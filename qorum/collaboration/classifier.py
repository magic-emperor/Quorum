"""
Phase 6 — Classifier.

Three sequential checks via the classify LLM role:
  1. Actionability gate  — is this a concrete work request?
  2. Work-type           — bug | feature | enhancement | refactor | chore | question
  3. Complexity          — SIMPLE | COMPLEX → model_tier + agent_route

Non-actionable intents return a Classification with actionable=False and a
clarifying_question. The bot layer posts that question and stops — no plan is
generated. This is the gate that keeps Qorum from planning on vague chatter.
"""
from __future__ import annotations

import json
from typing import TYPE_CHECKING, Optional

from pydantic import ValidationError

from qorum.collaboration.schemas import AGENT_ROUTE, Classification
from qorum.core.logger import get_logger

if TYPE_CHECKING:
    from qorum.collaboration.intent import Intent
    from qorum.config import QorumConfig
    from qorum.providers.registry import ProviderRegistry

log = get_logger(__name__)

_SYSTEM_PROMPT = """\
You are Qorum's Classifier. Given a work intent (decisions, context, referenced paths),
classify it in three sequential steps.

## Step 1: Actionability gate
Is this a concrete work request with a clear outcome?
- ACTIONABLE: "Fix the login bug where session expires too early"
- NOT ACTIONABLE: "I wonder if we should rethink the auth"

If NOT ACTIONABLE → output:
  {"actionable": false, "clarifying_question": "<one specific question>", "reasoning": "..."}
Then STOP.

## Step 2: Work type (only if actionable)
Classify as exactly one of: bug | feature | enhancement | refactor | chore | question
- bug: something is broken and needs fixing
- feature: net-new capability that doesn't exist
- enhancement: existing capability being improved or extended
- refactor: internal restructure with no user-visible change
- chore: tooling, deps, CI, docs, config
- question: the user wants an answer, not a code change

## Step 3: Complexity (only if not question)
SIMPLE if ALL true: single module, CRUD only, no auth/payments/realtime, <3 entities, 1 person, <1 day.
COMPLEX if ANY: multi-module, auth/payments/realtime, multiple roles, background jobs, >1 service.
When in doubt → COMPLEX.

Model tier: SIMPLE → fast; COMPLEX → default.

## Output (strict JSON, no other text):
{
  "actionable": true,
  "work_type": "bug|feature|enhancement|refactor|chore|question",
  "complexity": "SIMPLE|COMPLEX",
  "model_tier": "fast|default",
  "agent_route": ["planner", "coder", "reviewer", "tester"],
  "reasoning": "one sentence"
}
""".strip()

_CLASSIFY_TOOL = {
    "name": "classify_intent",
    "description": "Classify a work intent as actionable/type/complexity.",
    "input_schema": {
        "type": "object",
        "properties": {
            "actionable":           {"type": "boolean"},
            "work_type":            {"type": "string"},
            "complexity":           {"type": "string", "enum": ["SIMPLE", "COMPLEX"]},
            "model_tier":           {"type": "string", "enum": ["fast", "default", "premium"]},
            "agent_route":          {"type": "array", "items": {"type": "string"}},
            "reasoning":            {"type": "string"},
            "clarifying_question":  {"type": "string"},
        },
        "required": ["actionable", "reasoning"],
    },
}


class ClassificationError(Exception):
    pass


class IntentClassifier:
    """
    Classifies an Intent into a Classification.
    Shares the provider registry with other pipeline components.
    """

    def __init__(self, config: "QorumConfig") -> None:
        self._config = config
        self._registry: Optional["ProviderRegistry"] = None

    def set_registry(self, registry: "ProviderRegistry") -> None:
        self._registry = registry

    def _get_registry(self) -> "ProviderRegistry":
        if self._registry is None:
            from qorum.providers.registry import ProviderRegistry
            self._registry = ProviderRegistry(self._config)
        return self._registry

    async def classify(self, intent: "Intent") -> Classification:
        """Classify an Intent. Returns Classification with actionable=False on non-actionable input."""
        payload = _intent_to_payload(intent)
        log.info("classifier.start", source=intent.source, title=intent.title_hint)

        raw = await self._call_llm(json.dumps(payload, indent=2))
        return self._parse(raw)

    # ── LLM call ──────────────────────────────────────────────────────────────

    async def _call_llm(self, user_message: str) -> str:
        from qorum.core.retry import with_retry
        from qorum.providers.base import LLMMessage, ToolSpec
        from qorum.providers.errors import (
            ProviderAuthError, ProviderBadRequest, ProviderNotConfigured,
            ProviderRateLimit, ProviderServerError,
        )

        registry = self._get_registry()
        provider, model = registry.provider_for("classify")
        caps = provider.capabilities(model)
        use_tools = caps.native_tool_use

        messages = [
            LLMMessage(role="system", content=_SYSTEM_PROMPT),
            LLMMessage(role="user", content=user_message),
        ]

        classify_tool = ToolSpec(
            name=_CLASSIFY_TOOL["name"],
            description=_CLASSIFY_TOOL["description"],
            parameters=_CLASSIFY_TOOL["input_schema"],
        )

        async def _do_call() -> str:
            if use_tools:
                resp = await provider.complete(
                    messages, model=model, json_mode=False,
                    max_tokens=1024, temperature=0.1, tools=[classify_tool],
                )
                if resp.tool_calls:
                    tc = resp.tool_calls[0]
                    return json.dumps(tc.arguments) if isinstance(tc.arguments, dict) else tc.arguments
            resp = await provider.complete(
                messages, model=model, json_mode=True, max_tokens=1024, temperature=0.1,
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
                raise ClassificationError(f"Provider error: {exc}") from exc

        from qorum.adapters.base import RateLimitError as _RL
        try:
            return await with_retry(_guarded, max_attempts=3, base_delay=2.0, label="classify")
        except _RL as exc:
            raise ClassificationError(f"Rate limit: {exc}") from exc

    def _parse(self, raw: str) -> Classification:
        try:
            data = json.loads(raw) if isinstance(raw, str) else raw
            clf = Classification.model_validate(data)
            # Fill agent_route from routing map if LLM left it empty
            if clf.actionable and clf.work_type and not clf.agent_route:
                clf.agent_route = AGENT_ROUTE.get(clf.work_type, [])
            log.info(
                "classifier.result",
                actionable=clf.actionable,
                work_type=clf.work_type,
                complexity=clf.complexity,
            )
            return clf
        except (ValidationError, json.JSONDecodeError, TypeError) as exc:
            log.error("classifier.parse_failed", error=str(exc), raw=str(raw)[:200])
            # Safe fallback: treat as actionable enhancement (full route, no data loss)
            return Classification(
                actionable=True,
                work_type="enhancement",
                complexity="COMPLEX",
                model_tier="default",
                agent_route=AGENT_ROUTE["enhancement"],
                reasoning="Classification parsing failed — defaulting to enhancement/COMPLEX.",
            )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _intent_to_payload(intent: "Intent") -> dict:
    """Flatten an Intent into a classifier-friendly dict."""
    payload: dict = {"source": intent.source}

    if intent.summary:
        payload["decisions"] = intent.summary.decisions
        payload["open_questions"] = intent.summary.open_questions
        payload["context"] = intent.summary.context
        payload["referenced_paths"] = intent.summary.referenced_paths
        payload["candidate_titles"] = intent.summary.candidate_titles
    elif intent.ticket:
        payload["title"] = intent.ticket.title
        payload["description"] = intent.ticket.description or ""
        payload["labels"] = getattr(intent.ticket, "labels", [])

    return payload
