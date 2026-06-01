"""
Qorum AI Plan Generator.

Responsibilities:
  1. Build context payload from NormalizedTicket
  2. Call the configured LLM provider via the registry
  3. Validate structured JSON output against Pydantic schemas
  4. For LARGE tickets: first propose phase breakdown, then generate per-phase plans
  5. Return validated PlanOutput (or list of PlanOutput for phased tickets)

All LLM calls go through qorum.providers.registry — no direct SDK imports here.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from pydantic import ValidationError

from qorum.adapters.base import NormalizedTicket, TicketSize
from qorum.core.logger import get_logger
from qorum.core.schemas import PhaseDefinition, PhaseProposal, PlanOutput, TestingOutput

if TYPE_CHECKING:
    from qorum.config import QorumConfig
    from qorum.providers.registry import ProviderRegistry

log = get_logger(__name__)

PROMPTS_DIR = Path(__file__).parent.parent / "prompts"


@dataclass
class GeneratedPlan:
    """Result of plan generation for one ticket (or one phase of a large ticket)."""
    plan: PlanOutput
    phase_number: int | None       # None for standard tickets
    phase_name: str | None         # e.g. "backend-api"
    phase_title: str | None        # e.g. "Backend API & Data Model"
    prompt_version: str


@dataclass
class GenerationResult:
    """Full result returned to the orchestrator."""
    ticket_id: str
    size: TicketSize
    plans: list[GeneratedPlan]     # 1 item for standard, N for large
    phase_proposal: PhaseProposal | None  # Only set for large tickets

    def model_dump_json(self) -> str:
        """Serialize to JSON for DB session persistence (B2)."""
        import json as _json
        return _json.dumps({
            "ticket_id": self.ticket_id,
            "size": self.size.value,
            "plans": [
                {
                    "plan": gp.plan.model_dump(),
                    "phase_number": gp.phase_number,
                    "phase_name": gp.phase_name,
                    "phase_title": gp.phase_title,
                    "prompt_version": gp.prompt_version,
                }
                for gp in self.plans
            ],
            "phase_proposal": self.phase_proposal.model_dump() if self.phase_proposal else None,
        })

    @classmethod
    def model_validate_json(cls, data: str) -> "GenerationResult":
        """Deserialize from JSON (B2)."""
        import json as _json
        from qorum.core.schemas import PhaseProposal as _PP
        from qorum.adapters.base import TicketSize as _TS
        d = _json.loads(data)
        plans = [
            GeneratedPlan(
                plan=PlanOutput.model_validate(p["plan"]),
                phase_number=p.get("phase_number"),
                phase_name=p.get("phase_name"),
                phase_title=p.get("phase_title"),
                prompt_version=p.get("prompt_version", "plan_v1"),
            )
            for p in d["plans"]
        ]
        return cls(
            ticket_id=d["ticket_id"],
            size=_TS(d["size"]),
            plans=plans,
            phase_proposal=_PP.model_validate(d["phase_proposal"]) if d.get("phase_proposal") else None,
        )


class PlanGenerationError(Exception):
    """Raised when plan generation fails after retries."""


class QorumPlanGenerator:
    """
    Generates implementation plans using the Claude API.
    One instance per application — the Anthropic client is reused across calls.
    """

    def __init__(self, config: "QorumConfig") -> None:
        self._config = config
        # Registry is built lazily so tests can inject mocks without full config
        self._registry: "ProviderRegistry | None" = None
        self._plan_prompt = self._load_prompt("plan_v1.md")
        self._phase_splitter_prompt = self._load_prompt("phase_splitter_v1.md")
        self._testing_prompt = self._load_prompt("testing_v1.md")

    def _get_registry(self) -> "ProviderRegistry":
        if self._registry is None:
            from qorum.providers.registry import ProviderRegistry
            self._registry = ProviderRegistry(self._config)
        return self._registry

    def set_registry(self, registry: "ProviderRegistry") -> None:
        """Inject a registry (used in tests to avoid real provider calls)."""
        self._registry = registry

    # ── Public API ────────────────────────────────────────────────────────────

    async def generate_plan_from_intent(
        self,
        intent: "Any",       # qorum.collaboration.intent.Intent
        classification: "Any",   # qorum.collaboration.schemas.Classification
        feedback: str | None = None,
    ) -> GenerationResult:
        """
        Phase 7: Generate a plan from a chat Intent rather than a board ticket.
        Uses ChatSummary.decisions/context as the plan input.
        complexity=COMPLEX → phased; SIMPLE → standard.
        """
        from qorum.adapters.base import TicketSize
        from qorum.collaboration.intent import Intent as _Intent

        plan_id = intent.capture.capture_id if intent.capture else "chat"
        log.info(
            "plan_generator.from_intent",
            plan_id=plan_id,
            work_type=classification.work_type,
            complexity=classification.complexity,
        )

        payload = _intent_to_plan_payload(intent, classification, feedback)
        size = TicketSize.LARGE if classification.complexity == "COMPLEX" else TicketSize.STANDARD

        if size == TicketSize.LARGE:
            # Reuse phased logic via a synthetic NormalizedTicket
            ticket = _synthetic_ticket(plan_id, payload, size)
            return await self._generate_phased(ticket, feedback=feedback)
        else:
            label = f"plan.{plan_id}"
            plan = await self._generate_single_plan(payload, label)
            return GenerationResult(
                ticket_id=plan_id,
                size=size,
                plans=[GeneratedPlan(
                    plan=plan,
                    phase_number=None,
                    phase_name=None,
                    phase_title=None,
                    prompt_version="plan_v1",
                )],
                phase_proposal=None,
            )

    async def generate_plan(
        self,
        ticket: NormalizedTicket,
        feedback: str | None = None,
    ) -> GenerationResult:
        """
        Generate a plan for a ticket.
        For LARGE tickets, first proposes phases then generates one plan per phase.
        feedback: reviewer feedback to incorporate when regenerating (B3).
        """
        log.info(
            "plan_generator.start",
            ticket_id=ticket.id,
            platform=ticket.platform.value,
            size=ticket.size.value,
            has_feedback=bool(feedback),
        )

        if ticket.size == TicketSize.LARGE:
            return await self._generate_phased(ticket, feedback=feedback)
        else:
            return await self._generate_standard(ticket, feedback=feedback)

    async def generate_testing(
        self,
        ticket: NormalizedTicket,
        plans: list[GeneratedPlan],
    ) -> list[TestingOutput]:
        """
        Generate testing.md content for each approved plan phase.
        Returns one TestingOutput per GeneratedPlan (1 for standard, N for phased).
        """
        log.info("plan_generator.testing_start", ticket_id=ticket.id, phases=len(plans))
        results: list[TestingOutput] = []
        for gp in plans:
            payload = {
                "plan": gp.plan.model_dump(),
                "phase_number": gp.phase_number,
                "phase_title": gp.phase_title,
                "prompt_version": "testing_v1",
            }
            raw_json = await self._call_llm(
                role="testing",
                system_prompt=self._testing_prompt,
                user_message=json.dumps(payload, indent=2),
                label=f"testing.{ticket.id}.phase{gp.phase_number or 1}",
            )
            try:
                results.append(TestingOutput.model_validate_json(raw_json))
            except (ValidationError, json.JSONDecodeError) as exc:
                log.error(
                    "plan_generator.testing_schema_invalid",
                    ticket_id=ticket.id,
                    phase=gp.phase_number,
                    error=str(exc),
                )
                raise PlanGenerationError(
                    f"Testing generation returned invalid output for {ticket.id} phase {gp.phase_number}: {exc}"
                ) from exc
        return results

    # ── Internal: Standard ticket ─────────────────────────────────────────────

    async def _generate_standard(
        self, ticket: NormalizedTicket, feedback: str | None = None
    ) -> GenerationResult:
        payload = self._build_plan_payload(ticket, phase_context=None, feedback=feedback)
        plan = await self._generate_single_plan(payload, ticket.id)

        return GenerationResult(
            ticket_id=ticket.id,
            size=ticket.size,
            plans=[GeneratedPlan(
                plan=plan,
                phase_number=None,
                phase_name=None,
                phase_title=None,
                prompt_version="plan_v1",
            )],
            phase_proposal=None,
        )

    # ── Internal: Large ticket ────────────────────────────────────────────────

    async def _generate_phased(
        self, ticket: NormalizedTicket, feedback: str | None = None
    ) -> GenerationResult:
        phase_proposal = await self._propose_phases(ticket)
        log.info(
            "plan_generator.phases_proposed",
            ticket_id=ticket.id,
            total_phases=phase_proposal.total_phases,
            phases=[p.name for p in phase_proposal.phases],
        )

        generated_plans: list[GeneratedPlan] = []
        for phase_def in phase_proposal.phases:
            phase_context = self._build_phase_context(phase_def, phase_proposal)
            payload = self._build_plan_payload(
                ticket, phase_context=phase_context, phase=phase_def, feedback=feedback
            )
            plan = await self._generate_single_plan(payload, f"{ticket.id}-phase{phase_def.number}")

            generated_plans.append(GeneratedPlan(
                plan=plan,
                phase_number=phase_def.number,
                phase_name=phase_def.name,
                phase_title=phase_def.title,
                prompt_version="plan_v1",
            ))

        return GenerationResult(
            ticket_id=ticket.id,
            size=ticket.size,
            plans=generated_plans,
            phase_proposal=phase_proposal,
        )

    async def _propose_phases(self, ticket: NormalizedTicket) -> PhaseProposal:
        """Ask Claude to propose a phase breakdown for a large ticket."""
        payload = {
            "ticket": self._ticket_to_dict(ticket),
            "prompt_version": "phase_splitter_v1",
        }

        raw_json = await self._call_llm(
            role="phase_split",
            system_prompt=self._phase_splitter_prompt,
            user_message=json.dumps(payload, indent=2),
            label=f"phase_split.{ticket.id}",
        )

        try:
            proposal = PhaseProposal.model_validate_json(raw_json)
            # Cap phases at configured limit
            if proposal.total_phases > self._config.qorum_large_ticket_phase_limit:
                proposal = PhaseProposal(
                    total_phases=self._config.qorum_large_ticket_phase_limit,
                    rationale=proposal.rationale,
                    phases=proposal.phases[: self._config.qorum_large_ticket_phase_limit],
                )
            return proposal
        except (ValidationError, json.JSONDecodeError) as exc:
            log.error("plan_generator.phase_proposal_invalid", ticket_id=ticket.id, error=str(exc))
            # Fallback: create a simple 2-phase proposal
            return self._default_phase_proposal(ticket)

    def _default_phase_proposal(self, ticket: NormalizedTicket) -> PhaseProposal:
        """Fallback phase proposal when AI output fails validation."""
        return PhaseProposal(
            total_phases=2,
            rationale="Default 2-phase split (phase proposal generation failed).",
            phases=[
                PhaseDefinition(
                    number=1,
                    name="implementation",
                    title="Core Implementation",
                    scope="Core backend and business logic implementation.",
                    sub_task_titles=["Core implementation work"],
                    estimated_effort=Effort.L,
                    depends_on_phases=[],
                ),
                PhaseDefinition(
                    number=2,
                    name="frontend-and-testing",
                    title="Frontend & Testing",
                    scope="UI, integration, and end-to-end testing.",
                    sub_task_titles=["Frontend work", "Testing"],
                    estimated_effort=Effort.M,
                    depends_on_phases=[1],
                ),
            ],
        )

    # ── Internal: Single plan generation ─────────────────────────────────────

    async def _generate_single_plan(self, payload: dict[str, Any], label: str) -> PlanOutput:
        """Call LLM, validate JSON output, return PlanOutput."""
        raw_json = await self._call_llm(
            role="plan",
            system_prompt=self._plan_prompt,
            user_message=json.dumps(payload, indent=2),
            label=f"plan.{label}",
        )

        try:
            plan = PlanOutput.model_validate_json(raw_json)
            log.info(
                "plan_generator.plan_validated",
                label=label,
                confidence=plan.confidence_overall,
                sub_tasks=len(plan.sub_tasks),
                ambiguities=len(plan.ambiguities),
                low_confidence=plan.low_confidence_warning,
            )
            return plan
        except (ValidationError, json.JSONDecodeError) as exc:
            log.error("plan_generator.schema_invalid", label=label, error=str(exc))
            raise PlanGenerationError(
                f"Plan generation returned invalid JSON schema for {label}: {exc}"
            ) from exc

    # ── Internal: provider call (Tasks 4+5: registry + JSON in provider layer) ─

    async def _call_llm(
        self,
        role: str,
        system_prompt: str,
        user_message: str,
        label: str,
    ) -> str:
        """
        Call the LLM for a given role via the provider registry.
        JSON mode is handled by the provider; repair is attempted here on failure.
        Retry is handled via core/retry wrapping the call.
        """
        from qorum.core.retry import with_retry
        from qorum.providers.base import LLMMessage
        from qorum.providers.errors import (
            ProviderAuthError, ProviderBadRequest, ProviderNotConfigured,
            ProviderRateLimit, ProviderServerError,
        )

        max_tokens = getattr(self._config, "qorum_max_tokens_plan", 8192)
        registry = self._get_registry()
        provider, model = registry.provider_for(role)

        messages = [
            LLMMessage(role="system", content=system_prompt),
            LLMMessage(role="user", content=user_message),
        ]

        log.info("plan_generator.llm_call", label=label, provider=provider.name, model=model)

        async def _do_call() -> str:
            resp = await provider.complete(
                messages,
                model=model,
                json_mode=True,
                max_tokens=max_tokens,
                temperature=0.2,
            )
            log.info(
                "plan_generator.llm_response",
                label=label,
                provider=provider.name,
                model=model,
                finish=resp.finish_reason,
                usage=resp.usage,
            )
            return resp.text

        try:
            # Map provider rate-limit to the shared RateLimitError so with_retry handles it
            from qorum.adapters.base import RateLimitError as _RL
            async def _guarded() -> str:
                try:
                    return await _do_call()
                except ProviderRateLimit as exc:
                    raise _RL(str(exc), retry_after=exc.retry_after) from exc
                except ProviderServerError as exc:
                    raise _RL(str(exc), retry_after=5) from exc
                except (ProviderAuthError, ProviderNotConfigured) as exc:
                    raise PlanGenerationError(
                        f"Provider not available for role '{role}': {exc}. "
                        f"Check your .env for provider API keys."
                    ) from exc
                except ProviderBadRequest as exc:
                    raise PlanGenerationError(f"Bad request to LLM: {exc}") from exc

            raw = await with_retry(_guarded, max_attempts=3, base_delay=2.0, label=label)

        except _RL as exc:
            raise PlanGenerationError(f"Rate limit persists after retries: {exc}") from exc

        # JSON repair (B7) — one attempt if the provider returned broken JSON
        try:
            json.loads(raw)
            return raw
        except json.JSONDecodeError:
            log.warning("plan_generator.json_repair_attempt", label=label)
            repair_msgs = [
                LLMMessage(role="system",
                    content="You are a JSON repair assistant. Return ONLY the corrected JSON object."),
                LLMMessage(role="user",
                    content=f"Fix this broken JSON and return only valid JSON:\n\n{raw}"),
            ]
            try:
                repair_resp = await provider.complete(
                    repair_msgs, model=model, json_mode=True, max_tokens=max_tokens
                )
                repaired = repair_resp.text
                json.loads(repaired)  # validate repair
                log.info("plan_generator.json_repair_success", label=label)
                return repaired
            except Exception as exc:
                raise PlanGenerationError(f"JSON repair failed for {label}: {exc}") from exc


    # ── Internal: Payload builders ────────────────────────────────────────────

    def _build_plan_payload(
        self,
        ticket: NormalizedTicket,
        phase_context: str | None,
        phase: "PhaseDefinition | None" = None,
        feedback: str | None = None,
    ) -> dict[str, Any]:
        ticket_dict = self._ticket_to_dict(ticket)

        if phase:
            ticket_dict["phase_filter_hint"] = (
                f"Focus ONLY on these aspects for Phase {phase.number} ({phase.title}): "
                f"{phase.scope}. "
                f"Relevant sub-tasks: {', '.join(phase.sub_task_titles)}"
            )

        payload: dict[str, Any] = {
            "ticket": ticket_dict,
            "phase_context": phase_context,
            "prompt_version": "plan_v1",
        }
        # B3: inject reviewer feedback so the regenerated plan addresses it
        if feedback:
            payload["reviewer_feedback"] = (
                f"## Reviewer feedback to address\n\n{feedback}\n\n"
                f"The plan below MUST address each point raised above."
            )
        return payload

    def _ticket_to_dict(self, ticket: NormalizedTicket) -> dict[str, Any]:
        """Serialize NormalizedTicket to a clean dict for the AI prompt."""

        def _item_to_dict(t: NormalizedTicket) -> dict:
            return {
                "id": t.id,
                "title": t.title,
                "description": t.description[:500] if t.description else "",
                "item_type": t.item_type,
                "status": t.status,
            }

        return {
            "platform": ticket.platform.value,
            "id": ticket.id,
            "url": ticket.url,
            "title": ticket.title,
            "description": ticket.description or "",
            "acceptance_criteria": ticket.acceptance_criteria,
            "item_type": ticket.item_type,
            "status": ticket.status,
            "assignee": ticket.assignee,
            "tags": ticket.tags,
            "priority": ticket.priority,
            "story_points": ticket.story_points,
            "sprint": ticket.sprint,
            "parent": _item_to_dict(ticket.parent) if ticket.parent else None,
            "children": [_item_to_dict(c) for c in ticket.children],
            "linked_items": [
                {
                    "id": li.id,
                    "title": li.title,
                    "relationship": li.relationship,
                    "status": li.status,
                }
                for li in ticket.linked_items
            ],
            "comments": [
                {
                    "author": c.author,
                    "body": c.body[:300] if c.body else "",
                }
                for c in ticket.comments[:10]  # Cap at 10 most recent
            ],
        }

    def _build_phase_context(
        self, phase_def: PhaseDefinition, proposal: PhaseProposal
    ) -> str:
        other_phases = [p for p in proposal.phases if p.number != phase_def.number]
        before = [p for p in other_phases if p.number < phase_def.number]
        after = [p for p in other_phases if p.number > phase_def.number]

        parts = [
            f"This is Phase {phase_def.number} of {proposal.total_phases}: {phase_def.title}.",
            f"Phase scope: {phase_def.scope}",
        ]
        if before:
            parts.append(f"Depends on: {', '.join(f'Phase {p.number} ({p.title})' for p in before)}.")
        if after:
            parts.append(f"Followed by: {', '.join(f'Phase {p.number} ({p.title})' for p in after)}.")

        return " ".join(parts)

    # ── Utilities ─────────────────────────────────────────────────────────────

    @staticmethod
    def _load_prompt(filename: str) -> str:
        path = PROMPTS_DIR / filename
        if not path.exists():
            raise FileNotFoundError(f"Prompt file not found: {path}")
        return path.read_text(encoding="utf-8")


# ── Module-level helpers ──────────────────────────────────────────────────────

def _intent_to_plan_payload(intent: "Any", classification: "Any", feedback: "str | None") -> dict:
    """Build a plan prompt payload from a chat Intent."""
    summary = intent.summary
    payload: dict = {
        "source": "chat",
        "work_type": classification.work_type,
        "complexity": classification.complexity,
        "prompt_version": "plan_v1",
        "title": intent.title_hint or "Untitled",
    }
    if summary:
        payload["decisions"] = summary.decisions
        payload["open_questions"] = summary.open_questions
        payload["context"] = summary.context
        payload["referenced_paths"] = summary.referenced_paths
        payload["acceptance_criteria"] = [
            f"The following decisions are implemented: {d}" for d in summary.decisions
        ]
        payload["assignees"] = summary.assignees
    if feedback:
        payload["reviewer_feedback"] = (
            f"## Reviewer feedback to address\n\n{feedback}\n\n"
            "The plan MUST address each point raised above."
        )
    return payload


def _synthetic_ticket(plan_id: str, payload: dict, size: "Any") -> "Any":
    """Wrap an intent payload as a minimal NormalizedTicket for the phased generator."""
    from datetime import datetime, timezone
    from qorum.adapters.base import NormalizedTicket, Platform, TicketSize
    ticket = NormalizedTicket(
        id=plan_id,
        platform=Platform.GITHUB_ISSUES,
        url="",
        title=payload.get("title", "Chat plan"),
        description=payload.get("context", ""),
        acceptance_criteria=payload.get("acceptance_criteria", []),
        item_type="story",
        status="open",
        assignee=None,
        tags=[],
        priority=None,
        story_points=None,
        sprint=None,
        parent=None,
        children=[],
        linked_items=[],
        comments=[],
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
        raw={},
    )
    # Force size if LARGE (add dummy children to exceed threshold)
    if size == TicketSize.LARGE:
        from qorum.adapters.base import _detect_size
        # Set via object to bypass the frozen field
        object.__setattr__(ticket, "size", TicketSize.LARGE)
    return ticket


def _strip_fences(text: str) -> str:
    """Remove accidental markdown code fences from an LLM response (B7)."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)
    return text.strip()
