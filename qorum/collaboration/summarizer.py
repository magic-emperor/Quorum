"""
Phase 5 — Chat summarizer.

Calls the summarizer agent role (provider-agnostic via registry) and produces
a validated ChatSummary. Persists Markdown + JSON to .quorum/collaboration/.

Design note: we drive the LLM via a single forced tool call (tool_use) so the
output is always valid JSON matching the schema — no regex repair needed.
Falls back to json_mode=True if the provider doesn't support tool_use.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from pydantic import ValidationError

from qorum.collaboration.clean import format_for_llm
from qorum.collaboration.schemas import CaptureWindow, ChatSummary
from qorum.core.logger import get_logger

if TYPE_CHECKING:
    from qorum.config import QorumConfig
    from qorum.providers.registry import ProviderRegistry

log = get_logger(__name__)

# The system prompt instructs the model to call the output tool exactly once.
_SYSTEM_PROMPT = """\
You are Qorum's Summarizer. You receive a cleaned team chat transcript and extract
structured information.

## Rules
- Only extract what is explicitly in the messages — do not invent.
- If a message contradicts a previous one, include both and note the conflict in open_questions.
- Keep decisions concrete: "Replace JWT auth with session tokens" not "change auth".
- referenced_paths: file names, module names, or code symbols mentioned (e.g. "auth/", "UserService").
- candidate_titles: 2-3 short titles suitable as a ticket or plan title.
- Ignore noise: reactions, "ok", "lgtm", "sounds good", "+1", brief acknowledgements.
- assignees: @-mentioned people identified as responsible owners.
- links: any board URLs, PR links, or ticket references.

## Output
Call the extract_summary tool with the structured extraction.
If the chat contains no actionable signal, set decisions=[] and note this in context.
""".strip()

# Tool definition for structured output (Claude / OpenAI tool_use)
_EXTRACT_TOOL = {
    "name": "extract_summary",
    "description": "Extract structured summary from chat transcript.",
    "input_schema": {
        "type": "object",
        "properties": {
            "decisions":         {"type": "array", "items": {"type": "string"}},
            "open_questions":    {"type": "array", "items": {"type": "string"}},
            "context":           {"type": "string"},
            "candidate_titles":  {"type": "array", "items": {"type": "string"}},
            "assignees":         {"type": "array", "items": {"type": "string"}},
            "referenced_paths":  {"type": "array", "items": {"type": "string"}},
            "links":             {"type": "array", "items": {"type": "string"}},
        },
        "required": ["decisions", "open_questions", "context"],
    },
}


class ChatSummarizer:
    """
    Summarises a cleaned CaptureWindow into a ChatSummary.
    One instance per application — shares the provider registry.
    """

    def __init__(self, config: "QorumConfig") -> None:
        self._config = config
        self._registry: Optional["ProviderRegistry"] = None

    def _get_registry(self) -> "ProviderRegistry":
        if self._registry is None:
            from qorum.providers.registry import ProviderRegistry
            self._registry = ProviderRegistry(self._config)
        return self._registry

    def set_registry(self, registry: "ProviderRegistry") -> None:
        """Inject a registry (used in tests)."""
        self._registry = registry

    async def summarise(self, capture: CaptureWindow, cleaned_messages: list) -> ChatSummary:
        """
        Call the LLM and return a validated ChatSummary.
        cleaned_messages: output of clean.strip_noise(capture.messages).
        """
        if not cleaned_messages:
            log.warning("summarizer.empty_input", capture_id=capture.capture_id)
            return ChatSummary(context="No messages remained after noise stripping.")

        transcript = format_for_llm(cleaned_messages)
        log.info(
            "summarizer.start",
            capture_id=capture.capture_id,
            message_count=len(cleaned_messages),
            chars=len(transcript),
        )

        raw = await self._call_llm(transcript, capture.capture_id)
        return self._parse_output(raw, capture.capture_id)

    # ── Persistence ───────────────────────────────────────────────────────────

    async def persist(
        self,
        capture: CaptureWindow,
        summary: ChatSummary,
        quorum_dir: Path,
    ) -> tuple[Path, Path]:
        """
        Write Markdown + JSON to .quorum/collaboration/chat-summaries/.
        Returns (md_path, json_path).
        """
        summaries_dir = quorum_dir / "collaboration" / "chat-summaries"
        summaries_dir.mkdir(parents=True, exist_ok=True)

        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        stem = f"{capture.capture_id}-{today}"

        md_path = summaries_dir / f"{stem}.md"
        json_path = summaries_dir / f"{stem}.json"

        md_path.write_text(
            summary.to_markdown(capture, capture.capture_id),
            encoding="utf-8",
        )
        json_path.write_text(
            summary.model_dump_json(indent=2),
            encoding="utf-8",
        )

        log.info(
            "summarizer.persisted",
            capture_id=capture.capture_id,
            md=str(md_path),
            json=str(json_path),
        )
        return md_path, json_path

    # ── Internal LLM call ──────────────────────────────────────────────────────

    async def _call_llm(self, transcript: str, capture_id: str) -> str:
        from qorum.core.retry import with_retry
        from qorum.providers.base import LLMMessage, ToolSpec
        from qorum.providers.errors import (
            ProviderAuthError, ProviderBadRequest, ProviderNotConfigured,
            ProviderRateLimit, ProviderServerError,
        )

        registry = self._get_registry()
        provider, model = registry.provider_for("summarize")

        messages = [
            LLMMessage(role="system", content=_SYSTEM_PROMPT),
            LLMMessage(role="user", content=f"Chat transcript:\n\n{transcript}"),
        ]

        # Use tool_use (structured output) if the provider supports it;
        # fall back to json_mode (plain JSON in text) otherwise.
        caps = provider.capabilities(model)
        use_tools = caps.native_tool_use

        log.info(
            "summarizer.llm_call",
            capture_id=capture_id,
            provider=provider.name,
            model=model,
            structured=use_tools,
        )

        extract_tool = ToolSpec(
            name=_EXTRACT_TOOL["name"],
            description=_EXTRACT_TOOL["description"],
            parameters=_EXTRACT_TOOL["input_schema"],
        )

        async def _do_call() -> str:
            if use_tools:
                resp = await provider.complete(
                    messages,
                    model=model,
                    json_mode=False,
                    max_tokens=4096,
                    temperature=0.1,
                    tools=[extract_tool],
                )
                # Extract the tool call input as JSON string
                if resp.tool_calls:
                    tc = resp.tool_calls[0]
                    return json.dumps(tc.arguments) if isinstance(tc.arguments, dict) else tc.arguments
            # Fallback: ask for raw JSON
            resp = await provider.complete(
                messages,
                model=model,
                json_mode=True,
                max_tokens=4096,
                temperature=0.1,
            )
            return resp.text

        async def _guarded() -> str:
            try:
                return await _do_call()
            except ProviderRateLimit as exc:
                from qorum.adapters.base import RateLimitError as _RL
                raise _RL(str(exc), retry_after=exc.retry_after) from exc
            except ProviderServerError as exc:
                from qorum.adapters.base import RateLimitError as _RL
                raise _RL(str(exc), retry_after=5) from exc
            except (ProviderAuthError, ProviderNotConfigured, ProviderBadRequest) as exc:
                raise SummarizationError(f"Provider error: {exc}") from exc

        from qorum.adapters.base import RateLimitError as _RL
        try:
            return await with_retry(_guarded, max_attempts=3, base_delay=2.0, label=f"summarize.{capture_id}")
        except _RL as exc:
            raise SummarizationError(f"LLM rate limit exceeded: {exc}") from exc

    def _parse_output(self, raw: str, capture_id: str) -> ChatSummary:
        """Parse LLM output into a validated ChatSummary."""
        try:
            data = json.loads(raw) if isinstance(raw, str) else raw
            return ChatSummary.model_validate(data)
        except (ValidationError, json.JSONDecodeError, TypeError) as exc:
            log.error("summarizer.parse_failed", capture_id=capture_id, error=str(exc), raw=raw[:200])
            # Return a minimal summary rather than crashing the whole flow
            return ChatSummary(
                context="Summary extraction failed — the conversation could not be parsed.",
                open_questions=["Could you describe the key decisions from this conversation?"],
            )


class SummarizationError(Exception):
    """Raised when summarization fails after retries."""
