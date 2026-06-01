"""
Qorum Agent Harness — the execution engine.

run_agent() drives an agent loop in one of two modes:
  - Native: provider's function-calling API (Claude/OpenAI); Qorum tools exposed as functions.
  - Structured: ReAct JSON loop (same tools, same policy) — fallback for no-tool-use providers.

Both modes:
  - Respect max_steps and token budgets.
  - Emit ToolEvents for every tool action.
  - Save the full transcript to .quorum/context/sessions/.
  - Retry each LLM call via core/retry.

Phase 8 wires this into the execution engine on a real git branch.
Phase 10 wires the on_event callback to the WebSocket event bus.
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from qorum.agents.loader import AgentDef
from qorum.core.logger import get_logger
from qorum.providers.base import LLMMessage, LLMResponse, ToolCall
from qorum.providers.errors import ProviderRateLimit, ProviderServerError
from qorum.tools.base import ToolContext, ToolResult
from qorum.tools.events import ToolEvent
from qorum.tools.policy import ToolPolicy
from qorum.tools.registry import ToolRegistry, build_registry

log = get_logger(__name__)


# ── Result types ──────────────────────────────────────────────────────────────

@dataclass
class AgentRunResult:
    """Returned after run_agent completes (success or budget exhaustion)."""
    agent: str
    run_id: str
    ok: bool
    final_output: str                      # the agent's last text response
    steps_taken: int
    tokens_used: int
    tool_events: list[ToolEvent] = field(default_factory=list)
    error: Optional[str] = None            # set if ok=False
    cancelled: bool = False                # True if stopped by the developer mid-run


# ── Cancellation helper ───────────────────────────────────────────────────────

def _is_cancelled(ctx: ToolContext) -> bool:
    token = getattr(ctx, "cancel_token", None)
    return token is not None and token.is_cancelled()


def _cancelled_result(
    agent: str, run_id: str, steps: int, tokens: int,
    tool_events: list[ToolEvent], final_output: str = "",
) -> AgentRunResult:
    """Build the partial result returned when the developer stops the run."""
    return AgentRunResult(
        agent=agent, run_id=run_id, ok=True, cancelled=True,
        final_output=final_output, steps_taken=steps, tokens_used=tokens,
        tool_events=tool_events,
    )


# ── Transcript helpers ────────────────────────────────────────────────────────

def _save_transcript(
    run_id: str,
    agent: str,
    messages: list[LLMMessage],
    quorum_dir: Optional[Path],
) -> None:
    if not quorum_dir:
        return
    sessions_dir = quorum_dir / "context" / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    path = sessions_dir / f"{run_id}-{agent}.jsonl"
    with path.open("a", encoding="utf-8") as f:
        for m in messages:
            f.write(json.dumps({
                "role": m.role, "content": m.content[:2000], "name": m.name
            }) + "\n")


# ── Main entry point ──────────────────────────────────────────────────────────

async def run_agent(
    agent: AgentDef,
    task: str,
    tool_registry: ToolRegistry,
    ctx: ToolContext,
    provider_registry: Any,               # qorum.providers.registry.ProviderRegistry
    on_event: Optional[Callable[[ToolEvent], None]] = None,
    quorum_dir: Optional[Path] = None,
    cancel_token: Optional[Any] = None,   # CancellationToken — stop the run at a safe point
) -> AgentRunResult:
    """
    Run an agent to completion.
    Selects native vs structured mode based on the provider's capability flags.
    """
    run_id = uuid.uuid4().hex[:10]
    ctx.agent = agent.name
    ctx.run_id = run_id
    if on_event:
        ctx.on_event = on_event
    if cancel_token is not None:
        ctx.cancel_token = cancel_token

    provider, model = provider_registry.provider_for(agent.model_role)
    caps = provider.capabilities(model)

    # Tool gap-filling: inject Qorum-native web_search when provider lacks it.
    # Providers with native web search (Claude, Gemini) handle it themselves;
    # providers without it (Groq, DeepSeek, Mistral, Moonshot) get our tool injected.
    effective_registry = tool_registry
    if not caps.native_web_search and "web_search" not in tool_registry:
        from qorum.tools.registry import build_registry as _build_registry
        from qorum.tools.search import WebSearchTool
        effective_registry = ToolRegistry()
        for name in tool_registry.names():
            t = tool_registry.get(name)
            if t is not None:
                effective_registry.register(t)
        effective_registry.register(WebSearchTool())
        log.debug("harness.tool_gap_fill", injected="web_search", provider=provider.name)

    log.info(
        "harness.start",
        agent=agent.name,
        run_id=run_id,
        provider=provider.name,
        model=model,
        mode="native" if caps.native_tool_use else "structured",
        native_web_search=caps.native_web_search,
        native_thinking=caps.native_thinking,
    )

    if caps.native_tool_use:
        return await _run_native(agent, task, effective_registry, ctx, provider, model, run_id, quorum_dir)
    # Providers without native tool use get the structured ReAct loop (acts as thinking proxy)
    return await _run_structured(agent, task, effective_registry, ctx, provider, model, run_id, quorum_dir)


# ── Native tool-use loop ──────────────────────────────────────────────────────

async def _run_native(
    agent: AgentDef,
    task: str,
    registry: ToolRegistry,
    ctx: ToolContext,
    provider: Any,
    model: str,
    run_id: str,
    quorum_dir: Optional[Path],
) -> AgentRunResult:
    from qorum.core.retry import with_retry

    tools_for_agent = [
        registry.get(name).spec
        for name in agent.allowed_tools
        if registry.get(name) is not None
    ]

    messages: list[LLMMessage] = [
        LLMMessage(role="system", content=agent.system_prompt),
        LLMMessage(role="user", content=task),
    ]

    steps = 0
    tokens_used = 0
    tool_events: list[ToolEvent] = []

    while steps < agent.max_steps:
        # Safe point: stop cleanly before starting another step.
        if _is_cancelled(ctx):
            _save_transcript(run_id, agent.name, messages, quorum_dir)
            return _cancelled_result(agent.name, run_id, steps, tokens_used, tool_events)
        steps += 1

        async def _call() -> LLMResponse:
            return await provider.complete(
                messages,
                model=model,
                tools=tools_for_agent or None,
                temperature=0.2,
            )

        try:
            resp = await with_retry(_call, max_attempts=3, base_delay=2.0,
                                    label=f"{agent.name}.step{steps}")
        except Exception as exc:
            _save_transcript(run_id, agent.name, messages, quorum_dir)
            return AgentRunResult(
                agent=agent.name, run_id=run_id, ok=False,
                final_output="", steps_taken=steps,
                tokens_used=tokens_used,
                error=f"LLM call failed: {exc}",
            )

        tokens_used += resp.usage.get("input_tokens", 0) + resp.usage.get("output_tokens", 0)
        if tokens_used > agent.max_tokens_total:
            _save_transcript(run_id, agent.name, messages, quorum_dir)
            return AgentRunResult(
                agent=agent.name, run_id=run_id, ok=False,
                final_output=resp.text, steps_taken=steps,
                tokens_used=tokens_used,
                error=f"Token budget exceeded ({tokens_used} > {agent.max_tokens_total})",
            )

        if resp.text:
            messages.append(LLMMessage(role="assistant", content=resp.text))

        if resp.finish_reason == "stop" or not resp.tool_calls:
            _save_transcript(run_id, agent.name, messages, quorum_dir)
            return AgentRunResult(
                agent=agent.name, run_id=run_id, ok=True,
                final_output=resp.text, steps_taken=steps,
                tokens_used=tokens_used,
                tool_events=tool_events,
            )

        # Execute tool calls
        for tc in resp.tool_calls:
            # Safe point: stop before mutating the repo with the next tool.
            if _is_cancelled(ctx):
                _save_transcript(run_id, agent.name, messages, quorum_dir)
                return _cancelled_result(agent.name, run_id, steps, tokens_used,
                                         tool_events, final_output=resp.text)
            tool_result = await _dispatch_tool(tc, registry, ctx)
            if tool_result.event:
                tool_events.append(tool_result.event)
            messages.append(LLMMessage(
                role="tool",
                content=tool_result.output,
                name=tc.name,
                tool_call_id=tc.id,
            ))

    _save_transcript(run_id, agent.name, messages, quorum_dir)
    return AgentRunResult(
        agent=agent.name, run_id=run_id, ok=False,
        final_output=messages[-1].content if messages else "",
        steps_taken=steps, tokens_used=tokens_used,
        error=f"Max steps ({agent.max_steps}) reached without finalising.",
    )


# ── Structured ReAct loop ─────────────────────────────────────────────────────

_STRUCTURED_SYSTEM_SUFFIX = """
## Tool use format
You do not have native tool use. Instead, reply with ONE of these JSON structures:

To use a tool:
{"thought": "why I need this tool", "tool": "<tool_name>", "args": {<arguments>}}

To finish:
{"final": "<your complete final answer or status>"}

Available tools: {tool_list}

Reply with ONLY the JSON — no other text.
"""


async def _run_structured(
    agent: AgentDef,
    task: str,
    registry: ToolRegistry,
    ctx: ToolContext,
    provider: Any,
    model: str,
    run_id: str,
    quorum_dir: Optional[Path],
) -> AgentRunResult:
    from qorum.core.retry import with_retry

    tool_list = ", ".join(agent.allowed_tools) or "none"
    system = (
        agent.system_prompt
        + _STRUCTURED_SYSTEM_SUFFIX.replace("{tool_list}", tool_list)
    )

    messages: list[LLMMessage] = [
        LLMMessage(role="system", content=system),
        LLMMessage(role="user", content=task),
    ]

    steps = 0
    tokens_used = 0
    tool_events: list[ToolEvent] = []
    repair_used = False

    while steps < agent.max_steps:
        if _is_cancelled(ctx):
            _save_transcript(run_id, agent.name, messages, quorum_dir)
            return _cancelled_result(agent.name, run_id, steps, tokens_used, tool_events)
        steps += 1

        async def _call() -> LLMResponse:
            return await provider.complete(
                messages, model=model, json_mode=True, temperature=0.2
            )

        try:
            resp = await with_retry(_call, max_attempts=3, base_delay=2.0,
                                    label=f"{agent.name}.structured.step{steps}")
        except Exception as exc:
            _save_transcript(run_id, agent.name, messages, quorum_dir)
            return AgentRunResult(
                agent=agent.name, run_id=run_id, ok=False, final_output="",
                steps_taken=steps, tokens_used=tokens_used, error=str(exc),
            )

        tokens_used += resp.usage.get("input_tokens", 0) + resp.usage.get("output_tokens", 0)

        # Parse the action JSON
        try:
            action = json.loads(resp.text)
            repair_used = False
        except json.JSONDecodeError:
            if not repair_used:
                repair_used = True
                messages.append(LLMMessage(role="assistant", content=resp.text))
                messages.append(LLMMessage(
                    role="user",
                    content='Your response was not valid JSON. Reply with ONLY the JSON action or {"final": "..."}',
                ))
                continue
            # Second bad JSON — abort
            _save_transcript(run_id, agent.name, messages, quorum_dir)
            return AgentRunResult(
                agent=agent.name, run_id=run_id, ok=False, final_output=resp.text,
                steps_taken=steps, tokens_used=tokens_used,
                error="Repeated invalid JSON in structured mode.",
            )

        messages.append(LLMMessage(role="assistant", content=resp.text))

        if "final" in action:
            _save_transcript(run_id, agent.name, messages, quorum_dir)
            return AgentRunResult(
                agent=agent.name, run_id=run_id, ok=True,
                final_output=str(action["final"]),
                steps_taken=steps, tokens_used=tokens_used,
                tool_events=tool_events,
            )

        if "tool" not in action:
            messages.append(LLMMessage(
                role="user",
                content='Missing "tool" key. Use {"tool": "...", "args": {...}} or {"final": "..."}',
            ))
            continue

        # Dispatch tool
        if _is_cancelled(ctx):
            _save_transcript(run_id, agent.name, messages, quorum_dir)
            return _cancelled_result(agent.name, run_id, steps, tokens_used, tool_events)
        tc = ToolCall(
            id=f"s{steps}",
            name=action["tool"],
            arguments=action.get("args", {}),
        )
        tool_result = await _dispatch_tool(tc, registry, ctx)
        if tool_result.event:
            tool_events.append(tool_result.event)

        messages.append(LLMMessage(
            role="user",
            content=f"Tool '{tc.name}' result (ok={tool_result.ok}):\n{tool_result.output}",
        ))

    _save_transcript(run_id, agent.name, messages, quorum_dir)
    return AgentRunResult(
        agent=agent.name, run_id=run_id, ok=False,
        final_output=messages[-1].content if messages else "",
        steps_taken=steps, tokens_used=tokens_used,
        error=f"Max steps ({agent.max_steps}) reached.",
    )


# ── Tool dispatch ─────────────────────────────────────────────────────────────

async def _dispatch_tool(
    tc: ToolCall,
    registry: ToolRegistry,
    ctx: ToolContext,
) -> ToolResult:
    """Run a single tool call. Returns ToolResult.failure if the tool is missing or blocked."""
    tool = registry.get(tc.name)
    if tool is None:
        log.warning("harness.unknown_tool", name=tc.name)
        return ToolResult.failure(
            f"Tool '{tc.name}' is not available to this agent. "
            f"Available: {registry.names()}"
        )
    try:
        result = await tool.run(tc.arguments, ctx)
        log.info(
            "harness.tool_result",
            tool=tc.name,
            ok=result.ok,
            output_len=len(result.output),
        )
        return result
    except Exception as exc:
        log.exception("harness.tool_error", tool=tc.name)
        return ToolResult.failure(f"Tool '{tc.name}' raised an exception: {exc}")
