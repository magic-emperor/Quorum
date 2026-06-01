"""
Qorum Core Orchestrator — the main entry point for processing a ticket URL.

Flow:
  1. Detect platform from URL
  2. Verify auth token exists for that platform
  3. Fetch full ticket context (item + parent + children + comments)
  4. Detect ticket size (STANDARD vs LARGE)
  5. Generate plan(s) via AI
  6. Save to Qorum output folder
  7. Return result for bot layer to post in chat

Post-plan approval flow (Phase 4) is delegated to QorumApprovalPipeline.
The orchestrator is platform-agnostic — it delegates to adapters and generators.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING

from qorum.adapters.base import NormalizedTicket, TicketSize
from qorum.adapters.detector import UnsupportedPlatformError, detect_platform, extract_ticket_id_from_url
from qorum.approval.db import ApprovalDB
from qorum.approval.state_machine import QorumApprovalPipeline, ApprovalResult, TicketState
from qorum.core.logger import get_logger
from qorum.core.plan_generator import QorumPlanGenerator, GenerationResult, PlanGenerationError
from qorum.output.manager import QorumOutputManager
from qorum.output.renderer import WalkthroughData

if TYPE_CHECKING:
    from qorum.adapters.base import Platform
    from qorum.config import QorumConfig

log = get_logger(__name__)


class PlanMode(str, Enum):
    FULL = "full"       # Full plan + testing.md + walkthrough.md lifecycle
    BRIEF = "brief"     # Summary only, no approval flow


@dataclass
class OrchestratorResult:
    """Returned to the bot layer after plan generation."""
    ticket_id: str
    platform: str
    size: TicketSize
    mode: PlanMode
    phase_count: int                  # 1 for STANDARD, N for LARGE
    plan_paths: list[str]             # Absolute paths to generated plan.md file(s)
    inline_summary: str               # Short summary to post directly in chat
    confidence_overall: int           # 0-100
    ambiguity_count: int
    low_confidence_warning: bool
    requires_approval: bool           # Always True for FULL mode
    ticket: NormalizedTicket          # Full ticket context (for approval pipeline)
    generation_result: GenerationResult  # Full AI output for downstream use


@dataclass
class OrchestratorError:
    """Returned when processing fails. Bot layer posts this as a user-facing error."""
    ticket_id: str | None
    platform: str | None
    message: str                      # Human-readable, safe to post in chat
    recoverable: bool                 # If True, user can retry; if False, needs config fix


class QorumOrchestrator:
    """
    Main Qorum orchestrator. Instantiated once per application lifetime.
    Each `/atlas <url>` invocation calls `process(url)`.

    Call `await orchestrator.init()` once at startup to initialise the DB.
    """

    def __init__(self, config: "QorumConfig") -> None:
        self._config = config
        self._adapters: dict[str, object] = {}
        self._plan_generator = QorumPlanGenerator(config)
        self._output_manager = QorumOutputManager(config)
        self._db = ApprovalDB(config.qorum_db_path)
        self._approval = QorumApprovalPipeline(
            config=config,
            db=self._db,
            plan_generator=self._plan_generator,
            output_manager=self._output_manager,
        )

    async def init(self) -> None:
        """Initialise database tables. Call once at application startup."""
        await self._db.init()

    async def process(
        self,
        url: str,
        mode: PlanMode = PlanMode.FULL,
        feedback: str | None = None,
    ) -> OrchestratorResult | OrchestratorError:
        """
        Process a ticket URL end-to-end.

        Args:
            url:      Full ticket URL from the user.
            mode:     FULL (with approval flow) or BRIEF (summary only).
            feedback: Reviewer feedback to incorporate on re-generation (B3).

        Returns:
            OrchestratorResult on success, OrchestratorError on failure.
        """
        ticket_id: str | None = None
        platform_str: str | None = None

        try:
            log.info("qorum.process.start", url=url, mode=mode.value)

            platform = detect_platform(url, override=self._config.qorum_platform_override)
            platform_str = platform.value
            ticket_id = extract_ticket_id_from_url(url, platform)

            log.info("qorum.platform_detected", ticket_id=ticket_id, platform=platform_str)

            # ── B9: Guard against silently resetting a DONE ticket ────────────
            existing_state = await self._db.get_state(ticket_id)
            if existing_state == TicketState.DONE and not feedback:
                return OrchestratorError(
                    ticket_id=ticket_id,
                    platform=platform_str,
                    message=(
                        f"Ticket `{ticket_id}` is already DONE. "
                        f"Use `/qorum refresh {ticket_id}` to regenerate a new plan."
                    ),
                    recoverable=True,
                )

            if not self._config.has_platform_token(platform_str):
                return OrchestratorError(
                    ticket_id=ticket_id,
                    platform=platform_str,
                    message=(
                        f"No token configured for {platform_str.replace('_', ' ').title()}. "
                        f"Add the required token to your .env file. "
                        f"Run `/qorum help` for setup instructions."
                    ),
                    recoverable=False,
                )

            adapter = self._get_adapter(platform)
            ticket: NormalizedTicket = await adapter.fetch_item(url)  # type: ignore[attr-defined]

            log.info(
                "qorum.ticket_fetched",
                ticket_id=ticket_id,
                platform=platform_str,
                size=ticket.size.value,
                item_type=ticket.item_type,
                children_count=len(ticket.children),
            )

            # ── B3: Thread feedback into generation ───────────────────────────
            generation_result = await self._plan_generator.generate_plan(
                ticket, feedback=feedback
            )

            log.info(
                "qorum.plans_generated",
                ticket_id=ticket_id,
                phase_count=len(generation_result.plans),
                confidence_overall=generation_result.plans[0].plan.confidence_overall if generation_result.plans else 0,
            )

            saved = await self._output_manager.save_plans(ticket, generation_result)
            plan_paths = [str(p) for p in saved.plan_paths]

            # ── B9: Use correct from_state for re-runs ─────────────────────────
            from_state = existing_state  # None on first run; previous state on re-run
            await self._db.upsert_ticket(
                ticket_id=ticket_id,
                platform=platform_str,
                state=TicketState.PENDING_APPROVAL,
                phase_count=len(generation_result.plans),
                plan_paths=plan_paths,
            )
            await self._db.log_transition(
                ticket_id=ticket_id,
                from_state=from_state,
                to_state=TicketState.PENDING_APPROVAL,
                note="Plan generated" if not feedback else "Plan regenerated with feedback",
            )

            # ── Step 7: Build inline summary for chat ─────────────────────────
            inline_summary = self._build_inline_summary(ticket, generation_result, mode)

            # Aggregate confidence (lowest across all phases for large tickets)
            confidence_overall = min(
                gp.plan.confidence_overall for gp in generation_result.plans
            ) if generation_result.plans else 0

            ambiguity_count = sum(
                len(gp.plan.ambiguities) for gp in generation_result.plans
            )

            low_confidence_warning = any(
                gp.plan.low_confidence_warning for gp in generation_result.plans
            )

            return OrchestratorResult(
                ticket_id=ticket_id,
                platform=platform_str,
                size=ticket.size,
                mode=mode,
                phase_count=len(generation_result.plans),
                plan_paths=plan_paths,
                inline_summary=inline_summary,
                confidence_overall=confidence_overall,
                ambiguity_count=ambiguity_count,
                low_confidence_warning=low_confidence_warning,
                requires_approval=(mode == PlanMode.FULL),
                ticket=ticket,
                generation_result=generation_result,
            )

        except UnsupportedPlatformError as exc:
            return OrchestratorError(
                ticket_id=ticket_id,
                platform=platform_str,
                message=str(exc),
                recoverable=False,
            )
        except PlanGenerationError as exc:
            return OrchestratorError(
                ticket_id=ticket_id,
                platform=platform_str,
                message=str(exc),
                recoverable=True,
            )
        except Exception as exc:
            log.exception("qorum.process.error", ticket_id=ticket_id, platform=platform_str)
            return OrchestratorError(
                ticket_id=ticket_id,
                platform=platform_str,
                message=(
                    f"Something went wrong processing your ticket. "
                    f"Error: {type(exc).__name__}: {exc}"
                ),
                recoverable=True,
            )

    def _get_adapter(self, platform: "Platform") -> object:
        key = platform.value
        if key not in self._adapters:
            self._adapters[key] = self._build_adapter(platform)
        return self._adapters[key]

    def _build_adapter(self, platform: "Platform") -> object:
        from qorum.adapters.base import Platform as P
        import importlib

        adapter_map = {
            P.AZURE_BOARDS: "qorum.adapters.azure_boards.AzureBoardsAdapter",
            P.JIRA_CLOUD:   "qorum.adapters.jira_cloud.JiraCloudAdapter",
            P.JIRA_SERVER:  "qorum.adapters.jira_cloud.JiraCloudAdapter",
            P.GITHUB_ISSUES:"qorum.adapters.github_issues.GitHubIssuesAdapter",
            P.LINEAR:       "qorum.adapters.linear.LinearAdapter",
        }

        class_path = adapter_map.get(platform)
        if not class_path:
            raise ValueError(f"No adapter implemented for platform: {platform.value}")

        module_path, class_name = class_path.rsplit(".", 1)
        module = importlib.import_module(module_path)
        cls = getattr(module, class_name)
        return cls(self._config)

    # ── Approval actions (called by bot layer on button clicks) ───────────────

    async def approve(
        self,
        ticket: NormalizedTicket,
        generation_result: GenerationResult,
        approved_by: str | None = None,
    ) -> ApprovalResult | OrchestratorError:
        """[✅ Approve Plan] button handler. Generates testing.md."""
        try:
            return await self._approval.approve(ticket, generation_result, approved_by)
        except Exception as exc:
            log.exception("qorum.approve.error", ticket_id=ticket.id)
            return OrchestratorError(
                ticket_id=ticket.id,
                platform=ticket.platform.value,
                message=f"Approval failed: {type(exc).__name__}: {exc}",
                recoverable=True,
            )

    async def request_changes(
        self,
        ticket: NormalizedTicket,
        feedback_text: str,
        actor: str | None = None,
    ) -> ApprovalResult | OrchestratorError:
        """[✏️ Request Changes] button handler. Records feedback for plan regeneration."""
        try:
            return await self._approval.request_changes(ticket, feedback_text, actor)
        except Exception as exc:
            log.exception("qorum.request_changes.error", ticket_id=ticket.id)
            return OrchestratorError(
                ticket_id=ticket.id,
                platform=ticket.platform.value,
                message=f"Could not record change request: {type(exc).__name__}: {exc}",
                recoverable=True,
            )

    async def mark_done(
        self,
        ticket: NormalizedTicket,
        walkthrough: WalkthroughData,
        completed_by: str | None = None,
    ) -> ApprovalResult | OrchestratorError:
        """[🚀 Mark Done] button handler. Generates walkthrough.md."""
        try:
            return await self._approval.mark_done(ticket, walkthrough, completed_by)
        except Exception as exc:
            log.exception("qorum.mark_done.error", ticket_id=ticket.id)
            return OrchestratorError(
                ticket_id=ticket.id,
                platform=ticket.platform.value,
                message=f"Could not mark done: {type(exc).__name__}: {exc}",
                recoverable=True,
            )

    async def get_ticket_state(self, ticket_id: str) -> TicketState | None:
        """Return current approval state for a ticket, or None if not found."""
        return await self._db.get_state(ticket_id)

    async def get_stats(self) -> dict:
        """Return aggregate usage stats for /qorum stats command."""
        return await self._db.get_stats()

    async def list_recent(self, limit: int = 10) -> list:
        """Return most recent tickets for /qorum status command."""
        return await self._db.list_tickets(limit=limit)

    # ── Public API for bot layer — no _private access (B8) ───────────────────

    async def get_ticket_record(self, ticket_id: str) -> dict | None:
        """Return full DB record for a ticket, or None."""
        return await self._db.get_ticket(ticket_id)

    async def get_plan_paths(self, ticket_id: str) -> list:
        """Return all plan.md paths for a ticket."""
        return self._output_manager.get_plan_paths(ticket_id)

    async def record_feedback(
        self,
        ticket_id: str,
        artifact_type: str,
        rating: str,
        sections_flagged: list | None = None,
        comment: str | None = None,
        actor: str | None = None,
    ) -> None:
        """Store user feedback for a generated artifact."""
        await self._db.record_feedback(
            ticket_id=ticket_id,
            artifact_type=artifact_type,
            rating=rating,
            sections_flagged=sections_flagged,
            comment=comment,
            actor=actor,
        )

    async def save_session(
        self,
        ticket_id: str,
        url: str,
        ticket: NormalizedTicket,
        generation_result: GenerationResult,
        channel_id: str | None = None,
    ) -> None:
        """Persist ticket + generation result for bot restart survival (B2)."""
        await self._db.save_session(
            ticket_id=ticket_id,
            url=url,
            ticket_json=ticket.to_json(),
            result_json=generation_result.model_dump_json(),
            channel_id=channel_id,
        )

    async def load_session(self, ticket_id: str) -> dict | None:
        """Load a persisted session record, or None if not found (B2)."""
        return await self._db.load_session(ticket_id)

    async def delete_session(self, ticket_id: str) -> None:
        """Remove a persisted session (called after mark_done)."""
        await self._db.delete_session(ticket_id)

    async def record_vote(
        self,
        plan_id: str,
        user_id: str,
        display_name: str | None,
        verdict: str,
        note: str | None = None,
    ) -> None:
        """Persist an approval vote (idempotent per plan+user)."""
        await self._db.upsert_vote(plan_id, user_id, display_name, verdict, note)

    async def append_audit_event(
        self,
        plan_id: str,
        event_type: str,
        actor: str | None = None,
        detail: dict | None = None,
    ) -> None:
        """Append an immutable audit trail event."""
        await self._db.append_audit_event(plan_id, event_type, actor, detail)

    # ── Inline summary builder ─────────────────────────────────────────────────

    def _build_inline_summary(
        self,
        ticket: NormalizedTicket,
        result: GenerationResult,
        mode: PlanMode,
    ) -> str:
        if not result.plans:
            return f"*{ticket.title}* — Plan generation failed."

        first_plan = result.plans[0].plan
        confidence = first_plan.confidence_overall
        confidence_bar = self._confidence_bar(confidence)
        warning = "⚠️ *LOW CONFIDENCE — Resolve ambiguities before development*\n" if first_plan.low_confidence_warning else ""

        if mode == PlanMode.BRIEF:
            return (
                f"{warning}"
                f"*{ticket.title}*\n"
                f"_{first_plan.summary}_"
            )

        # Build ambiguity list (top 3)
        ambiguities_text = ""
        all_ambiguities = [a for gp in result.plans for a in gp.plan.ambiguities]
        if all_ambiguities:
            top = all_ambiguities[:3]
            ambiguities_text = "\n\n*Ambiguities to resolve:*\n" + "\n".join(
                f"• *{a.id}*: {a.question} _(Owner: {a.suggested_owner.value})_"
                for a in top
            )
            if len(all_ambiguities) > 3:
                ambiguities_text += f"\n_...and {len(all_ambiguities) - 3} more in the full plan._"

        phase_text = ""
        if result.size == TicketSize.LARGE:
            phase_names = [f"Phase {gp.phase_number}: {gp.phase_title}" for gp in result.plans]
            phase_text = f"\n\n*Phases ({len(result.plans)}):*\n" + "\n".join(f"• {p}" for p in phase_names)

        sub_tasks_count = sum(len(gp.plan.sub_tasks) for gp in result.plans)

        return (
            f"{warning}"
            f"*{ticket.title}* `{ticket.id}`\n"
            f"Platform: {ticket.platform.value.replace('_', ' ').title()} | "
            f"Type: {ticket.item_type} | "
            f"Confidence: {confidence_bar} {confidence}%\n\n"
            f"_{first_plan.summary}_"
            f"{phase_text}"
            f"\n\n*{sub_tasks_count} sub-tasks* identified"
            f"{ambiguities_text}"
        )

    @staticmethod
    def _confidence_bar(confidence: int) -> str:
        from qorum.core.schemas import CONF_GOOD, CONF_WARN
        if confidence >= CONF_GOOD:
            return "🟢"
        elif confidence >= CONF_WARN:
            return "🟡"
        else:
            return "🔴"

