"""
Phase 14.1 — Execution cancellation.

Lets a developer STOP a running execution from any surface (chat, web, VS Code).

Two cooperating pieces:
  - CancellationToken: a per-execution flag the runner + agent harness poll at
    safe points (between tool calls / agents). is_cancelled() is True if either
    the in-process asyncio.Event is set OR a cross-process control file exists.
    The control file is the zero-IPC bridge so a Stop pressed in the SERVER
    process (web dashboard / VS Code) reaches a run executing in the BOT process.
  - ExecutionRegistry: a process-wide map plan_id -> (token, task) so the chat
    Stop handler and the server /stop endpoint can find a live execution.

Cancellation is cooperative (graceful): the run halts at the next safe point so
no file is left half-written. A hard fallback (Task.cancel) is applied by the
caller after a grace timeout if the run is stuck in a long await.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Optional

from qorum.core.logger import get_logger

log = get_logger(__name__)

_CONTROL_DIRNAME = "control"


class CancellationToken:
    """
    A cooperative cancellation flag. Checked at safe points by the harness/runner.
    """

    def __init__(self, plan_id: str, quorum_dir: Optional[Path] = None) -> None:
        self._plan_id = plan_id
        self._event = asyncio.Event()
        self._quorum_dir = quorum_dir

    @property
    def plan_id(self) -> str:
        return self._plan_id

    def _control_path(self) -> Optional[Path]:
        if self._quorum_dir is None:
            return None
        return self._quorum_dir / _CONTROL_DIRNAME / f"{self._plan_id}.stop"

    def is_cancelled(self) -> bool:
        """True if cancelled in-process OR via the cross-process control file."""
        if self._event.is_set():
            return True
        path = self._control_path()
        if path is not None and path.exists():
            # Mirror the file state into the event so later checks are fast.
            self._event.set()
            return True
        return False

    def cancel(self) -> None:
        """Request graceful cancellation (in-process)."""
        self._event.set()
        log.info("cancellation.requested", plan_id=self._plan_id)

    def write_control_file(self) -> None:
        """Request cancellation across processes by dropping a control marker."""
        path = self._control_path()
        if path is None:
            # No quorum_dir → fall back to the in-process event only.
            self.cancel()
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("stop", encoding="utf-8")
        self._event.set()
        log.info("cancellation.control_file_written", plan_id=self._plan_id, path=str(path))

    def clear(self) -> None:
        """Reset the token and remove any control file (after a run finishes)."""
        self._event.clear()
        path = self._control_path()
        if path is not None and path.exists():
            try:
                path.unlink()
            except OSError:
                pass


class ExecutionRegistry:
    """
    Process-wide registry of live executions, keyed by plan_id.
    Holds the CancellationToken and the running asyncio.Task (for the hard fallback).
    """

    def __init__(self) -> None:
        self._tokens: dict[str, CancellationToken] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    def register(self, plan_id: str, token: CancellationToken) -> None:
        self._tokens[plan_id] = token

    def attach_task(self, plan_id: str, task: asyncio.Task) -> None:
        self._tasks[plan_id] = task

    def get_token(self, plan_id: str) -> Optional[CancellationToken]:
        return self._tokens.get(plan_id)

    def get_task(self, plan_id: str) -> Optional[asyncio.Task]:
        return self._tasks.get(plan_id)

    def is_active(self, plan_id: str) -> bool:
        task = self._tasks.get(plan_id)
        return task is not None and not task.done()

    def cancel(self, plan_id: str, *, cross_process: bool = False) -> bool:
        """
        Request cancellation for a plan. Returns True if a token was found.
        cross_process=True also writes the control file (server → bot bridge).
        """
        token = self._tokens.get(plan_id)
        if token is None:
            return False
        if cross_process:
            token.write_control_file()
        else:
            token.cancel()
        return True

    def remove(self, plan_id: str) -> None:
        token = self._tokens.pop(plan_id, None)
        if token is not None:
            token.clear()
        self._tasks.pop(plan_id, None)


# ── Process-wide singleton ────────────────────────────────────────────────────

_registry: Optional[ExecutionRegistry] = None


def get_registry() -> ExecutionRegistry:
    global _registry
    if _registry is None:
        _registry = ExecutionRegistry()
    return _registry
