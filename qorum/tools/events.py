"""
ToolEvent schema — emitted by every tool action so Phase 10 can stream them
to VS Code, the web dashboard, and the chat thread.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal, Optional


ToolEventKind = Literal[
    "file_open",
    "file_create",
    "file_edit",
    "file_delete",
    "fs_write",       # alias used by Phase 8 harness
    "fs_edit",        # alias used by Phase 8 harness
    "fs_create",      # alias used by Phase 8 harness
    "fs_delete",      # alias used by Phase 8 harness
    "command",
    "git",
    "test_result",
    "build",
    "gate",           # Phase 9 gate step
    "gate_install",
    "gate_build",
    "gate_lint",
    "gate_test",
    "search",
    "http",
    "phase",
    "status",
    "error",
    "ping",           # WS keepalive
    "cancelled",      # execution stopped by the developer
]


@dataclass
class ToolEvent:
    """
    One observable action from the execution loop.
    Emitted by every tool; consumed by Phase 10 event bus + chat progress.
    """
    kind: ToolEventKind
    agent: str                           # which agent triggered this
    summary: str                         # human-readable one-liner for chat
    ts: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    run_id: str = ""
    path: Optional[str] = None           # affected file path (relative to repo root)
    lines_added: Optional[int] = None
    lines_removed: Optional[int] = None
    reason: Optional[str] = None         # why this change was made
    exit_code: Optional[int] = None      # for command / build / test
    ok: bool = True
    payload: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "agent": self.agent,
            "summary": self.summary,
            "ts": self.ts.isoformat(),
            "run_id": self.run_id,
            "path": self.path,
            "lines_added": self.lines_added,
            "lines_removed": self.lines_removed,
            "reason": self.reason,
            "exit_code": self.exit_code,
            "ok": self.ok,
            "payload": self.payload,
        }
