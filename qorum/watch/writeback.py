"""
Phase 11 — Bidirectional write-back.

Called at specific pipeline events to update the source ticket:
  plan_created   → comment "Qorum plan ready" + plan link
  approved       → status → in_progress (configurable)
  committed      → comment with branch + gate result; status → in_review
  pr_opened      → link_pr (opt-in)

Status names are configurable via registry.json per-repo:
  { "status_map": { "in_progress": "In Progress", "in_review": "In Review" } }
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from qorum.core.logger import get_logger

if TYPE_CHECKING:
    from qorum.adapters.base import BaseTicketAdapter
    from qorum.execution.schemas import ExecutionResult, GateResult

log = get_logger(__name__)

# Default status names — adapters may vary; registry overrides take precedence.
_DEFAULT_STATUS_MAP = {
    "in_progress": "In Progress",
    "in_review": "In Review",
    "done": "Done",
}


class WriteBack:
    """
    Handles all write-back events for a single board ticket.
    Constructed once per pipeline run; methods called at each event.
    """

    def __init__(
        self,
        adapter: "BaseTicketAdapter",
        ticket_id: str,
        status_map: Optional[dict[str, str]] = None,
        enabled: bool = True,
    ) -> None:
        self._adapter = adapter
        self._ticket_id = ticket_id
        # If caller passes an explicit dict (even empty), use it as-is;
        # only fall back to defaults when status_map is None.
        self._status_map = status_map if status_map is not None else dict(_DEFAULT_STATUS_MAP)
        self._enabled = enabled

    async def on_plan_created(
        self,
        plan_title: str,
        plan_url: Optional[str] = None,
        dashboard_url: Optional[str] = None,
    ) -> None:
        if not self._enabled:
            return
        parts = [f"**Qorum plan ready:** _{plan_title}_"]
        if plan_url:
            parts.append(f"\nPlan: {plan_url}")
        if dashboard_url:
            parts.append(f"\nDashboard: {dashboard_url}")
        parts.append("\nAwaiting approval.")
        await self._comment("\n".join(parts))

    async def on_approved(self) -> None:
        if not self._enabled:
            return
        await self._set_status("in_progress")
        await self._comment("Plan approved. Execution starting.")

    async def on_committed(
        self,
        branch: str,
        gate_result: Optional["GateResult"] = None,
        change_summary: Optional[str] = None,
    ) -> None:
        if not self._enabled:
            return
        parts = [f"**Qorum committed to branch `{branch}`**"]
        if change_summary:
            parts.append(f"\n{change_summary}")
        if gate_result:
            parts.append(f"\nGate: {gate_result.verdict}")
        await self._comment("\n".join(parts))
        await self._set_status("in_review")

    async def on_pr_opened(self, pr_url: str) -> None:
        if not self._enabled:
            return
        await self._adapter.link_pr(self._ticket_id, pr_url)
        await self._comment(f"PR opened: {pr_url}")

    # ── Internal ──────────────────────────────────────────────────────────────

    async def _comment(self, body: str) -> None:
        try:
            await self._adapter.post_comment(self._ticket_id, body)
        except Exception as exc:
            log.warning("writeback.comment_failed", ticket=self._ticket_id, error=str(exc))

    async def _set_status(self, key: str) -> None:
        mapped = self._status_map.get(key)
        if not mapped:
            log.warning("writeback.status_not_mapped", key=key, ticket=self._ticket_id)
            return
        try:
            await self._adapter.update_status(self._ticket_id, mapped)
        except Exception as exc:
            log.warning("writeback.status_failed", ticket=self._ticket_id, key=key, error=str(exc))


def get_status_map_from_registry(registry_entry: Optional[dict]) -> dict[str, str]:
    """Extract status_map from a registry.json mapping entry."""
    if not registry_entry:
        return {}
    return registry_entry.get("status_map", {})
