"""
Phase 10 — Run state store.

Holds in-memory run metadata (ExecutionResult, GateResult) indexed by run_id.
Backed by events.jsonl for event history; metadata is ephemeral across restarts
(reconstructable from jsonl + bot session DB if needed in Phase 11).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from qorum.execution.schemas import ExecutionResult, GateResult


@dataclass
class RunRecord:
    run_id: str
    plan_id: str
    status: str = "running"           # running | stopping | cancelled | complete | failed | approved | discarded
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    completed_at: Optional[datetime] = None
    result: Optional[ExecutionResult] = None
    gate: Optional[GateResult] = None
    branch: Optional[str] = None
    approved_by: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "run_id": self.run_id,
            "plan_id": self.plan_id,
            "status": self.status,
            "started_at": self.started_at.isoformat(),
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "branch": self.branch,
            "approved_by": self.approved_by,
            "files_changed": self.result.files_changed if self.result else 0,
            "lines_added": self.result.lines_added if self.result else 0,
            "lines_removed": self.result.lines_removed if self.result else 0,
            "gate_verdict": self.gate.verdict if self.gate else None,
        }


class RunStore:
    """In-memory run registry. One instance per server process."""

    def __init__(self) -> None:
        self._runs: dict[str, RunRecord] = {}

    def create(self, run_id: str, plan_id: str) -> RunRecord:
        record = RunRecord(run_id=run_id, plan_id=plan_id)
        self._runs[run_id] = record
        return record

    def get(self, run_id: str) -> Optional[RunRecord]:
        return self._runs.get(run_id)

    def complete(self, run_id: str, result: ExecutionResult) -> None:
        record = self._runs.get(run_id)
        if record:
            if getattr(result, "cancelled", False):
                record.status = "cancelled"
            else:
                record.status = "complete" if result.ok else "failed"
            record.completed_at = datetime.now(timezone.utc)
            record.result = result
            record.branch = result.branch
            if result.gate_result:
                record.gate = result.gate_result

    def mark_stopping(self, run_id: str) -> None:
        record = self._runs.get(run_id)
        if record and record.status == "running":
            record.status = "stopping"

    def mark_cancelled(self, run_id: str) -> None:
        record = self._runs.get(run_id)
        if record:
            record.status = "cancelled"
            record.completed_at = datetime.now(timezone.utc)

    def mark_approved(self, run_id: str, approved_by: str) -> None:
        record = self._runs.get(run_id)
        if record:
            record.status = "approved"
            record.approved_by = approved_by

    def mark_discarded(self, run_id: str) -> None:
        record = self._runs.get(run_id)
        if record:
            record.status = "discarded"

    def list_all(self) -> list[dict]:
        return [r.to_dict() for r in sorted(
            self._runs.values(), key=lambda r: r.started_at, reverse=True
        )]


# ── Global singleton ──────────────────────────────────────────────────────────

_store: Optional[RunStore] = None


def get_store() -> RunStore:
    global _store
    if _store is None:
        _store = RunStore()
    return _store
