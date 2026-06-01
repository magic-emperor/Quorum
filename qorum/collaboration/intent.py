"""
Phase 5 — Intent: unifies chat capture and board tickets into a single object
that the rest of the pipeline (Phase 6 classifier, Phase 7 planner) consumes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, Optional

if TYPE_CHECKING:
    from qorum.adapters.base import NormalizedTicket
    from qorum.bot.events import ChatUser
    from qorum.collaboration.schemas import CaptureWindow, ChatSummary


@dataclass
class Intent:
    """
    The normalised input for all downstream phases.

    source="chat"  → capture + summary are populated; ticket is None.
    source="board" → ticket is populated (Phase 11+); capture/summary may be None.
    """
    source: Literal["chat", "board"]
    author: "ChatUser"

    # Chat path (Phase 5)
    capture: Optional["CaptureWindow"] = None
    summary: Optional["ChatSummary"] = None

    # Board path (Phase 11)
    ticket: Optional["NormalizedTicket"] = None

    # Shared
    links: list[str] = field(default_factory=list)
    raw_ref: dict[str, Any] = field(default_factory=dict)  # channel_id/thread_id or ticket url

    @property
    def capture_id(self) -> Optional[str]:
        return self.capture.capture_id if self.capture else None

    @property
    def title_hint(self) -> Optional[str]:
        """Best candidate title available — used by Phase 7 as the plan title seed."""
        if self.summary and self.summary.candidate_titles:
            return self.summary.candidate_titles[0]
        if self.ticket:
            return self.ticket.title
        return None

    @property
    def is_actionable(self) -> bool:
        """False → Phase 6 asks for clarification instead of planning."""
        if self.source == "chat":
            return self.summary is not None and self.summary.is_actionable
        if self.source == "board":
            return self.ticket is not None
        return False

    @classmethod
    def from_ticket(cls, ticket: "NormalizedTicket", author: "ChatUser") -> "Intent":
        """
        Phase 11: Build a board Intent directly from a NormalizedTicket.
        Extracts a ChatSummary equivalent from ticket fields so downstream
        classify/locate/plan sees the same shape as a chat Intent.
        """
        from qorum.collaboration.schemas import ChatSummary

        # Build a structured summary from ticket fields
        decisions = [f"Implement: {ticket.title}"]
        if ticket.acceptance_criteria:
            decisions = [f"Implement acceptance criterion: {ac}" for ac in ticket.acceptance_criteria[:5]]

        open_questions = []
        # Extract open questions from comments mentioning "?" or "unclear"
        for comment in ticket.comments[:5]:
            if "?" in comment.body:
                lines = [l.strip() for l in comment.body.splitlines() if "?" in l and len(l) < 200]
                open_questions.extend(lines[:2])

        # Extract referenced paths from description + comments
        import re as _re
        text = " ".join([ticket.description or ""] + [c.body for c in ticket.comments[:3]])
        referenced_paths = list(dict.fromkeys(
            _re.findall(r"[\w/-]+\.\w{2,6}|[\w-]+/[\w/-]+", text)
        ))[:10]

        context = (ticket.description or "")[:500] or ticket.title

        summary = ChatSummary(
            decisions=decisions,
            open_questions=open_questions,
            context=context,
            candidate_titles=[ticket.title],
            assignees=[ticket.assignee] if ticket.assignee else [],
            referenced_paths=referenced_paths,
            links=[ticket.url] + [li.url for li in ticket.linked_items[:3]],
        )

        return cls(
            source="board",
            author=author,
            ticket=ticket,
            summary=summary,
            links=[ticket.url],
            raw_ref={"board_project": ticket.id.split("-")[0] if "-" in ticket.id else ""},
        )
