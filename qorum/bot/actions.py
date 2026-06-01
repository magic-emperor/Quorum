"""
Bot action names — the single source of truth for all button/callback identifiers.
Every platform encodes these in its native button type; the dispatcher reads them here.
"""
from __future__ import annotations


class BotAction:
    # Approval flow
    APPROVE = "qorum:approve"
    REJECT = "qorum:reject"
    REQUEST_CHANGES = "qorum:request_changes"
    MARK_DONE = "qorum:mark_done"

    # Chat boundary (Phase 5)
    BOUNDARY_PROCEED = "qorum:boundary:proceed"
    BOUNDARY_TRIM = "qorum:boundary:trim"
    BOUNDARY_EXPAND = "qorum:boundary:expand"
    BOUNDARY_CANCEL = "qorum:boundary:cancel"

    # Target / location (Phase 6)
    CHANGE_TARGET = "qorum:change_target"
    CONFIRM_TARGET = "qorum:confirm_target"

    # Execution (Phase 8)
    EXECUTE = "qorum:execute"
    STOP_EXECUTION = "qorum:stop_execution"   # halt a running execution
    KEEP_BRANCH = "qorum:keep_branch"         # keep partial work after a stop
    APPROVE_DIFF = "qorum:approve_diff"
    DISCARD_DIFF = "qorum:discard_diff"
    PUSH = "qorum:push"            # opt-in, never automatic

    # Feedback
    FEEDBACK_HELPFUL = "qorum:feedback:helpful"
    FEEDBACK_NEEDS_WORK = "qorum:feedback:needs_work"
    FEEDBACK_FLAG = "qorum:feedback:flag"

    # Info
    VIEW_PLAN = "qorum:view_plan"
    VIEW_CAPTURE = "qorum:view_capture"


# Set of all valid action strings (for validation)
ALL_ACTIONS: frozenset[str] = frozenset(
    v for k, v in vars(BotAction).items()
    if not k.startswith("_") and isinstance(v, str)
)
