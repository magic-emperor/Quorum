"""
Phase 10 — In-process event bus.

EventBus connects execution on_event callbacks → WebSocket subscribers + jsonl file.

Design:
  - Publish:  bus.publish(run_id, event) — non-blocking, fire-and-forget.
  - Subscribe: async for event in bus.subscribe(run_id): ...
  - Replay:   bus.replay(run_id) — yields past events from .quorum/.../events.jsonl
              before switching to the live tail.
  - Backfill: late-joining WS clients get all past events then live updates.

Single source of truth: events.jsonl is the durable record.
In-process asyncio.Queue per run_id is the live pipe.
"""
from __future__ import annotations

import asyncio
import json
from asyncio import Queue
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator, Optional

from qorum.core.logger import get_logger
from qorum.tools.events import ToolEvent

log = get_logger(__name__)

_MAX_QUEUED_EVENTS = 1024   # per subscriber; old events dropped if full


class EventBus:
    """
    In-process pub/sub bus for ToolEvents.
    One global instance per server process.
    """

    def __init__(self, sessions_dir: Optional[Path] = None) -> None:
        # run_id → list of subscriber queues
        self._subscribers: dict[str, list[Queue]] = {}
        # run_id → path to events.jsonl
        self._log_paths: dict[str, Path] = {}
        self._sessions_dir = sessions_dir

    # ── Publish ───────────────────────────────────────────────────────────────

    def publish(self, run_id: str, event: ToolEvent) -> None:
        """
        Publish an event to all subscribers and append to events.jsonl.
        Non-blocking — safe to call from any coroutine.
        """
        serialized = _serialize(run_id, event)

        # Append to disk
        log_path = self._log_path(run_id)
        try:
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(serialized + "\n")
        except OSError as exc:
            log.warning("event_bus.write_failed", run_id=run_id, error=str(exc))

        # Deliver to all live subscribers
        for q in list(self._subscribers.get(run_id, [])):
            try:
                q.put_nowait(serialized)
            except asyncio.QueueFull:
                log.warning("event_bus.subscriber_queue_full", run_id=run_id)

    def make_callback(self, run_id: str):
        """Return an on_event callable suitable for passing to ExecutionRunner."""
        def _cb(event: ToolEvent) -> None:
            self.publish(run_id, event)
        return _cb

    # ── Subscribe ─────────────────────────────────────────────────────────────

    async def subscribe(self, run_id: str) -> AsyncIterator[str]:
        """
        Async generator — yields serialized JSON events.
        Backfills from events.jsonl, then streams live events.
        Caller should cancel/break when the client disconnects.
        """
        q: Queue = Queue(maxsize=_MAX_QUEUED_EVENTS)
        subs = self._subscribers.setdefault(run_id, [])
        subs.append(q)

        try:
            # Backfill: replay past events before switching to live
            for line in self._read_log(run_id):
                yield line

            # Live tail
            while True:
                try:
                    item = await asyncio.wait_for(q.get(), timeout=30.0)
                    yield item
                except asyncio.TimeoutError:
                    # Send a keepalive ping
                    yield json.dumps({"kind": "ping", "ts": _now()})
        finally:
            subs.remove(q)
            if not subs:
                self._subscribers.pop(run_id, None)

    # ── Replay ────────────────────────────────────────────────────────────────

    def replay(self, run_id: str) -> list[dict]:
        """Return all past events for a run as parsed dicts."""
        return [json.loads(line) for line in self._read_log(run_id)]

    def run_ids(self) -> list[str]:
        """Return all run IDs that have an events.jsonl file."""
        if not self._sessions_dir or not self._sessions_dir.exists():
            return []
        return [
            p.parent.name
            for p in self._sessions_dir.glob("*/events.jsonl")
        ]

    # ── Internal ──────────────────────────────────────────────────────────────

    def _log_path(self, run_id: str) -> Path:
        if run_id in self._log_paths:
            return self._log_paths[run_id]
        if self._sessions_dir:
            p = self._sessions_dir / run_id / "events.jsonl"
            p.parent.mkdir(parents=True, exist_ok=True)
        else:
            import tempfile
            p = Path(tempfile.gettempdir()) / f"qorum-{run_id}-events.jsonl"
        self._log_paths[run_id] = p
        return p

    def _read_log(self, run_id: str) -> list[str]:
        path = self._log_path(run_id)
        if not path.exists():
            return []
        try:
            return [l for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
        except OSError:
            return []


# ── Serialization ─────────────────────────────────────────────────────────────

def _serialize(run_id: str, event: ToolEvent) -> str:
    """Serialize a ToolEvent to a JSON string for wire + disk."""
    return json.dumps({
        "run_id": run_id,
        "kind": event.kind,
        "agent": event.agent,
        "summary": event.summary,
        "ok": event.ok,
        "ts": event.ts.isoformat() if hasattr(event, "ts") and event.ts else _now(),
        "payload": event.payload or {},
        "exit_code": event.exit_code,
    }, default=str)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Global singleton ──────────────────────────────────────────────────────────

_bus: Optional[EventBus] = None


def get_bus() -> EventBus:
    global _bus
    if _bus is None:
        _bus = EventBus()
    return _bus


def init_bus(sessions_dir: Path) -> EventBus:
    global _bus
    _bus = EventBus(sessions_dir=sessions_dir)
    return _bus
