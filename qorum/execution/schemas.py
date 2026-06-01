"""
Phase 8 — Execution schemas.

ExecutionResult: returned by runner.execute() and stored in .quorum/
ChangeLogEntry: one file touched during execution (path, action, lines, why)
RollbackPoint: pre-execution snapshot for discard/rollback
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


ChangeAction = Literal["create", "modify", "delete", "rename"]

# ── Phase 9 schemas ───────────────────────────────────────────────────────────

class DetectResult(BaseModel):
    """Detected project toolchain for a repo."""
    language: str = "unknown"
    build_cmd: Optional[str] = None
    test_cmd: Optional[str] = None
    lint_cmd: Optional[str] = None
    install_cmd: Optional[str] = None
    pkg_manager: Optional[str] = None   # npm / pnpm / yarn / bun / pip / cargo / etc.
    confidence: float = 1.0             # 0-1; <1 means multiple signals or heuristic

    @property
    def has_build(self) -> bool:
        return bool(self.build_cmd)

    @property
    def has_test(self) -> bool:
        return bool(self.test_cmd)


class FailedTest(BaseModel):
    name: str
    message: str = ""
    file: Optional[str] = None


class GateResult(BaseModel):
    """Result of running the build/test gate."""
    install_ok: bool = True
    build_ok: bool = True
    tests_ok: bool = True
    lint_warnings: int = 0
    failed_tests: list[FailedTest] = Field(default_factory=list)
    summary: str = ""
    logs_path: Optional[Path] = None
    fix_attempts: int = 0
    overridden: bool = False      # True if human chose [Override commit] despite failure
    overridden_by: Optional[str] = None

    @property
    def passed(self) -> bool:
        return self.install_ok and self.build_ok and self.tests_ok

    @property
    def verdict(self) -> str:
        if self.overridden:
            return "OVERRIDDEN"
        if self.passed:
            return "PASS"
        if not self.install_ok:
            return "INSTALL_FAIL"
        if not self.build_ok:
            return "BUILD_FAIL"
        return "TEST_FAIL"

    def card_text(self) -> str:
        icon = "✅" if self.passed else ("⚠" if self.overridden else "❌")
        lines = [f"{icon} Gate: *{self.verdict}*"]
        if self.summary:
            lines.append(self.summary)
        if self.failed_tests:
            lines.append(f"\nFailing tests ({len(self.failed_tests)}):")
            for t in self.failed_tests[:5]:
                lines.append(f"  • `{t.name}`")
                if t.message:
                    lines.append(f"    {t.message[:120]}")
            if len(self.failed_tests) > 5:
                lines.append(f"  _...and {len(self.failed_tests) - 5} more_")
        if self.fix_attempts:
            lines.append(f"\n_Auto-fix attempted {self.fix_attempts} time(s)._")
        return "\n".join(lines)


class ChangeLogEntry(BaseModel):
    """One file changed during execution."""
    path: str
    action: ChangeAction
    lines_added: int = 0
    lines_removed: int = 0
    agent: str = ""
    reason: str = ""
    ts: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def net_lines(self) -> int:
        return self.lines_added - self.lines_removed

    def summary(self) -> str:
        sign = f"+{self.lines_added}/-{self.lines_removed}"
        return f"{self.action} `{self.path}` ({sign}) — {self.reason}"


@dataclass
class RollbackPoint:
    """Pre-execution state snapshot so we can restore on discard."""
    plan_id: str
    repo: Path
    base_branch: str
    exec_branch: str
    stash_ref: Optional[str]           # None if tree was clean
    base_commit_sha: str
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    point_id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])

    def to_dict(self) -> dict:
        return {
            "plan_id": self.plan_id,
            "repo": str(self.repo),
            "base_branch": self.base_branch,
            "exec_branch": self.exec_branch,
            "stash_ref": self.stash_ref,
            "base_commit_sha": self.base_commit_sha,
            "created_at": self.created_at.isoformat(),
            "point_id": self.point_id,
        }


@dataclass
class ExecutionResult:
    """Returned after runner.execute() completes (success or halted)."""
    plan_id: str
    branch: str
    change_log: list[ChangeLogEntry]
    diff_summary: str                   # truncated unified diff for chat display
    transcript_path: Optional[Path]     # .quorum/context/sessions/<run_id>.json
    rollback_point: RollbackPoint
    ok: bool = True
    error: Optional[str] = None         # set when ok=False
    gate_result: Optional["GateResult"] = None   # set by Phase 9 gate
    security_result: Optional[Any] = None        # set by Phase 14 security gate
    cancelled: bool = False             # True if the developer stopped the run mid-flight

    @property
    def files_changed(self) -> int:
        return len(self.change_log)

    @property
    def lines_added(self) -> int:
        return sum(e.lines_added for e in self.change_log)

    @property
    def lines_removed(self) -> int:
        return sum(e.lines_removed for e in self.change_log)

    def diff_card_text(self) -> str:
        """Short summary for the diff-review card posted in chat."""
        if not self.ok:
            return f"⚠ Execution failed: {self.error}"

        header = (
            f"🛑 *Stopped* — partial work on branch `{self.branch}`"
            if self.cancelled
            else f"*Diff ready for review* — branch `{self.branch}`"
        )
        lines = [
            header,
            f"+{self.lines_added} / -{self.lines_removed} lines across {self.files_changed} file(s)",
            "",
        ]
        for entry in self.change_log[:8]:
            lines.append(f"  • {entry.summary()}")
        if len(self.change_log) > 8:
            lines.append(f"  _...and {len(self.change_log) - 8} more_")

        # Gate result block
        if self.gate_result is not None:
            lines.append("")
            lines.append(self.gate_result.card_text())

        return "\n".join(lines)
