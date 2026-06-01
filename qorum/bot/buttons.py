"""
Platform-neutral button definition.
Each adapter renders Button → its native format (InlineKeyboard / Block Kit / Adaptive Card).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional


ButtonStyle = Literal["primary", "secondary", "danger", "success"]


@dataclass
class Button:
    """One button in a message card."""
    label: str
    action: str                            # from qorum.bot.actions.BotAction
    payload: dict[str, Any] = field(default_factory=dict)
    style: ButtonStyle = "secondary"
    disabled: bool = False


# ── Common button sets ────────────────────────────────────────────────────────

def approval_buttons(ticket_id: str) -> list[Button]:
    from qorum.bot.actions import BotAction
    return [
        Button("✅ Approve", BotAction.APPROVE,
               {"ticket_id": ticket_id}, style="success"),
        Button("✏ Request changes", BotAction.REQUEST_CHANGES,
               {"ticket_id": ticket_id}, style="secondary"),
        Button("✖ Reject", BotAction.REJECT,
               {"ticket_id": ticket_id}, style="danger"),
    ]


def boundary_buttons(capture_id: str) -> list[Button]:
    from qorum.bot.actions import BotAction
    return [
        Button("✅ Looks right → plan", BotAction.BOUNDARY_PROCEED,
               {"capture_id": capture_id}, style="success"),
        Button("✂ Last 10 msgs", BotAction.BOUNDARY_TRIM,
               {"capture_id": capture_id}, style="secondary"),
        Button("⬆ Earlier +10", BotAction.BOUNDARY_EXPAND,
               {"capture_id": capture_id}, style="secondary"),
        Button("✖ Cancel", BotAction.BOUNDARY_CANCEL,
               {"capture_id": capture_id}, style="danger"),
    ]


def diff_review_buttons(ticket_id: str) -> list[Button]:
    from qorum.bot.actions import BotAction
    return [
        Button("✅ Approve diff → commit", BotAction.APPROVE_DIFF,
               {"ticket_id": ticket_id}, style="success"),
        Button("✖ Discard", BotAction.DISCARD_DIFF,
               {"ticket_id": ticket_id}, style="danger"),
    ]


def progress_buttons(ticket_id: str) -> list[Button]:
    """Shown while an execution is running — lets the dev stop it."""
    from qorum.bot.actions import BotAction
    return [
        Button("🛑 Stop", BotAction.STOP_EXECUTION,
               {"ticket_id": ticket_id}, style="danger"),
    ]


def stopped_buttons(ticket_id: str) -> list[Button]:
    """Shown after a stop — keep the partial branch or discard + restore."""
    from qorum.bot.actions import BotAction
    return [
        Button("↩ Discard & restore", BotAction.DISCARD_DIFF,
               {"ticket_id": ticket_id}, style="danger"),
        Button("📌 Keep branch", BotAction.KEEP_BRANCH,
               {"ticket_id": ticket_id}, style="secondary"),
    ]


def feedback_buttons(ticket_id: str, artifact: str) -> list[Button]:
    from qorum.bot.actions import BotAction
    return [
        Button("👍 Helpful", BotAction.FEEDBACK_HELPFUL,
               {"ticket_id": ticket_id, "artifact": artifact}, style="secondary"),
        Button("👎 Needs work", BotAction.FEEDBACK_NEEDS_WORK,
               {"ticket_id": ticket_id, "artifact": artifact}, style="secondary"),
    ]
