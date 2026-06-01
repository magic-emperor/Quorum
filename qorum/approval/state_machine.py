"""
Qorum Approval State Machine — ticket lifecycle management.

States:
  PENDING_APPROVAL   → plan.md generated, waiting for developer approval
  APPROVED           → developer approved the plan
  CHANGES_REQUESTED  → developer requested changes (plan will be regenerated)
  TESTING_GENERATED  → testing.md generated after approval
  DONE               → developer marked ticket done, walkthrough.md generated

Valid transitions:
  PENDING_APPROVAL  → APPROVED            (approve action)
  PENDING_APPROVAL  → CHANGES_REQUESTED   (request changes action)
  CHANGES_REQUESTED → PENDING_APPROVAL    (after plan regeneration)
  APPROVED          → TESTING_GENERATED   (auto, after generating testing.md)
  TESTING_GENERATED → DONE               (mark done action)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING

from qorum.core.logger import get_logger
from qorum.output.manager import QorumOutputManager
from qorum.output.renderer import WalkthroughData

if TYPE_CHECKING:
    from qorum.adapters.base import NormalizedTicket
    from qorum.approval.db import ApprovalDB
    from qorum.config import QorumConfig
    from qorum.core.plan_generator import QorumPlanGenerator

log = get_logger(__name__)


class TicketState(str, Enum):
    PENDING_APPROVAL   = "PENDING_APPROVAL"
    APPROVED           = "APPROVED"
    CHANGES_REQUESTED  = "CHANGES_REQUESTED"
    TESTING_GENERATED  = "TESTING_GENERATED"
    DONE               = "DONE"


# Which transitions are legal
_VALID_TRANSITIONS: dict[TicketState, set[TicketState]] = {
    TicketState.PENDING_APPROVAL:  {TicketState.APPROVED, TicketState.CHANGES_REQUESTED},
    TicketState.CHANGES_REQUESTED: {TicketState.PENDING_APPROVAL},
    TicketState.APPROVED:          {TicketState.TESTING_GENERATED},
    TicketState.TESTING_GENERATED: {TicketState.DONE},
    TicketState.DONE:              set(),   # terminal
}


class InvalidTransitionError(Exception):
    """Raised when a state transition is not permitted."""


@dataclass
class ApprovalResult:
    """Returned after any state transition action."""
    ticket_id: str
    new_state: TicketState
    testing_paths: list[str] = field(default_factory=list)    # set after APPROVED
    walkthrough_path: str | None = None                        # set after DONE
    inline_message: str = ""                                   # for posting in chat


class QorumApprovalPipeline:
    """
    Orchestrates the post-plan lifecycle for a ticket:
      approve → generate testing.md
      request_changes → regenerate plan
      mark_done → generate walkthrough.md
    """

    def __init__(
        self,
        config: "QorumConfig",
        db: "ApprovalDB",
        plan_generator: "QorumPlanGenerator",
        output_manager: QorumOutputManager,
    ) -> None:
        self._config = config
        self._db = db
        self._generator = plan_generator
        self._output = output_manager

    # ── Public actions ────────────────────────────────────────────────────────

    async def approve(
        self,
        ticket: "NormalizedTicket",
        generation_result: GenerationResult,
        approved_by: str | None = None,
    ) -> ApprovalResult:
        """
        Called when developer clicks [✅ Approve Plan].
        Transitions: PENDING_APPROVAL → APPROVED → TESTING_GENERATED
        Generates and saves testing.md, then updates state.
        """
        current = await self._db.get_state(ticket.id)
        _assert_transition(ticket.id, current, TicketState.APPROVED)

        await self._db.upsert_ticket(
            ticket_id=ticket.id,
            platform=ticket.platform.value,
            state=TicketState.APPROVED,
            approved_by=approved_by,
        )
        await self._db.log_transition(
            ticket.id,
            from_state=current,
            to_state=TicketState.APPROVED,
            actor=approved_by,
            note="Plan approved",
        )
        log.info("approval.plan_approved", ticket_id=ticket.id, approved_by=approved_by)

        # Auto-generate testing.md immediately after approval
        testing_outputs = await self._generator.generate_testing(
            ticket, generation_result.plans
        )
        testing_paths = await self._output.save_testing(
            ticket, testing_outputs, generation_result.plans, approved_by=approved_by
        )
        testing_path_strs = [str(p) for p in testing_paths]

        await self._db.upsert_ticket(
            ticket_id=ticket.id,
            platform=ticket.platform.value,
            state=TicketState.TESTING_GENERATED,
            testing_paths=testing_path_strs,
        )
        await self._db.log_transition(
            ticket.id,
            from_state=TicketState.APPROVED,
            to_state=TicketState.TESTING_GENERATED,
            note="Testing artifact generated",
        )
        log.info(
            "approval.testing_generated",
            ticket_id=ticket.id,
            paths=testing_path_strs,
        )

        return ApprovalResult(
            ticket_id=ticket.id,
            new_state=TicketState.TESTING_GENERATED,
            testing_paths=testing_path_strs,
            inline_message=(
                f"Plan approved by {approved_by or 'developer'}. "
                f"Testing guide generated ({len(testing_paths)} file(s)).\n\n"
                f"Click **[🚀 Mark Done]** after implementation."
            ),
        )

    async def request_changes(
        self,
        ticket: "NormalizedTicket",
        feedback_text: str,
        actor: str | None = None,
    ) -> ApprovalResult:
        """
        Called when developer clicks [✏️ Request Changes].
        Transitions: PENDING_APPROVAL → CHANGES_REQUESTED
        Returns CHANGES_REQUESTED state — caller must regenerate plan and call
        plan_regenerated() when done.
        """
        current = await self._db.get_state(ticket.id)
        _assert_transition(ticket.id, current, TicketState.CHANGES_REQUESTED)

        await self._db.upsert_ticket(
            ticket_id=ticket.id,
            platform=ticket.platform.value,
            state=TicketState.CHANGES_REQUESTED,
            feedback_text=feedback_text,
        )
        await self._db.log_transition(
            ticket.id,
            from_state=current,
            to_state=TicketState.CHANGES_REQUESTED,
            actor=actor,
            note=f"Changes requested: {feedback_text[:100]}",
        )
        log.info(
            "approval.changes_requested",
            ticket_id=ticket.id,
            feedback_preview=feedback_text[:100],
        )

        return ApprovalResult(
            ticket_id=ticket.id,
            new_state=TicketState.CHANGES_REQUESTED,
            inline_message=(
                f"Changes noted. Regenerating plan with feedback:\n> {feedback_text[:200]}"
            ),
        )

    async def plan_regenerated(
        self,
        ticket: "NormalizedTicket",
        new_plan_paths: list[str],
    ) -> ApprovalResult:
        """
        Called after plan has been regenerated following a change request.
        Transitions: CHANGES_REQUESTED → PENDING_APPROVAL
        """
        current = await self._db.get_state(ticket.id)
        _assert_transition(ticket.id, current, TicketState.PENDING_APPROVAL)

        await self._db.upsert_ticket(
            ticket_id=ticket.id,
            platform=ticket.platform.value,
            state=TicketState.PENDING_APPROVAL,
            plan_paths=new_plan_paths,
        )
        await self._db.log_transition(
            ticket.id,
            from_state=current,
            to_state=TicketState.PENDING_APPROVAL,
            note="Plan regenerated after changes",
        )
        log.info("approval.plan_regenerated", ticket_id=ticket.id)

        return ApprovalResult(
            ticket_id=ticket.id,
            new_state=TicketState.PENDING_APPROVAL,
            inline_message="Plan regenerated. Please review and approve.",
        )

    async def mark_done(
        self,
        ticket: "NormalizedTicket",
        walkthrough: WalkthroughData,
        completed_by: str | None = None,
    ) -> ApprovalResult:
        """
        Called when developer clicks [🚀 Mark Done].
        Transitions: TESTING_GENERATED → DONE
        Generates and saves walkthrough.md.
        """
        current = await self._db.get_state(ticket.id)
        _assert_transition(ticket.id, current, TicketState.DONE)

        walkthrough_path = await self._output.save_walkthrough(
            ticket, walkthrough, completed_by=completed_by
        )
        walkthrough_path_str = str(walkthrough_path)

        await self._db.upsert_ticket(
            ticket_id=ticket.id,
            platform=ticket.platform.value,
            state=TicketState.DONE,
            completed_by=completed_by,
            walkthrough_path=walkthrough_path_str,
            pr_links=walkthrough.linked_prs,
        )
        await self._db.log_transition(
            ticket.id,
            from_state=current,
            to_state=TicketState.DONE,
            actor=completed_by,
            note="Ticket marked done, walkthrough generated",
        )
        log.info(
            "approval.done",
            ticket_id=ticket.id,
            completed_by=completed_by,
            walkthrough_path=walkthrough_path_str,
        )

        return ApprovalResult(
            ticket_id=ticket.id,
            new_state=TicketState.DONE,
            walkthrough_path=walkthrough_path_str,
            inline_message=(
                f"Ticket marked done by {completed_by or 'developer'}. "
                f"Walkthrough saved."
            ),
        )

    # ── Query helpers ─────────────────────────────────────────────────────────

    async def get_state(self, ticket_id: str) -> TicketState | None:
        return await self._db.get_state(ticket_id)

    async def get_ticket_record(self, ticket_id: str) -> dict | None:
        return await self._db.get_ticket(ticket_id)

    async def get_stats(self) -> dict:
        return await self._db.get_stats()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _assert_transition(
    ticket_id: str,
    current: TicketState | None,
    target: TicketState,
) -> None:
    """Raise InvalidTransitionError if the transition is not permitted."""
    if current is None:
        # No record yet — only PENDING_APPROVAL is valid as first state
        if target != TicketState.PENDING_APPROVAL:
            raise InvalidTransitionError(
                f"Ticket {ticket_id!r} has no state record; "
                f"cannot transition to {target.value} without PENDING_APPROVAL first."
            )
        return

    allowed = _VALID_TRANSITIONS.get(current, set())
    if target not in allowed:
        raise InvalidTransitionError(
            f"Ticket {ticket_id!r}: cannot transition from {current.value} to {target.value}. "
            f"Allowed: {[s.value for s in allowed] or 'none (terminal state)'}."
        )
