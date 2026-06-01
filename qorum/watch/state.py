"""
Phase 11 — Watch state deduplication.

Persists processed ticket IDs to .quorum/watch-state.json so re-polls
don't re-trigger already-processed tickets.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from qorum.core.logger import get_logger

log = get_logger(__name__)


class WatchState:
    """
    Tracks which ticket IDs have been processed by quorum watch.
    One instance per watch project; backed by watch-state.json.
    """

    def __init__(self, state_path: Path) -> None:
        self._path = state_path
        self._processed: dict[str, str] = {}   # ticket_id → ISO timestamp
        self._load()

    def is_processed(self, ticket_id: str) -> bool:
        return ticket_id in self._processed

    def mark_processed(self, ticket_id: str) -> None:
        self._processed[ticket_id] = datetime.now(timezone.utc).isoformat()
        self._save()

    def processed_count(self) -> int:
        return len(self._processed)

    def all_processed(self) -> list[str]:
        return list(self._processed.keys())

    def reset(self, ticket_id: Optional[str] = None) -> None:
        """Reset one or all processed records (for testing / re-processing)."""
        if ticket_id:
            self._processed.pop(ticket_id, None)
        else:
            self._processed.clear()
        self._save()

    # ── Persistence ───────────────────────────────────────────────────────────

    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            self._processed = data.get("processed", {})
        except (json.JSONDecodeError, OSError) as exc:
            log.warning("watch_state.load_failed", path=str(self._path), error=str(exc))

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            json.dumps({"processed": self._processed}, indent=2),
            encoding="utf-8",
        )
