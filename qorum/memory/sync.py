"""
Phase 14 — Multi-developer .quorum/ concurrency.

Two developers in the same repo can mutate .quorum/ files at once. This module
provides safe write strategies so no update is lost and append-only files never
conflict.

Strategies:
  - write_json_cas(path, mutate_fn): optimistic compare-and-swap. Reads current
    content + a version hash, applies mutate_fn, writes only if the file is
    unchanged since read; otherwise re-reads and retries (bounded).
  - merge_records(): last-writer-wins per top-level key for nervous-system files
    (each key is an independent record, so union-merge is safe).
  - append_jsonl(): append-only writes for audit-trail (no read-modify-write, so
    no conflict by construction).
  - immutable_write(): approvals — refuse to overwrite an existing file.

Conflicts that cannot auto-resolve are recorded to nervous-system/conflicts.json
and surfaced to the caller.
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from qorum.core.logger import get_logger

log = get_logger(__name__)

_MAX_CAS_RETRIES = 5
_RETRY_BASE_DELAY = 0.02   # seconds

# Per-path in-process locks serialize the read-check-write critical section so
# concurrent coroutines/threads in one process never lose an update. Cross-process
# races are still caught by the content-hash check + retry (optimistic CAS).
_path_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(path: Path) -> threading.Lock:
    key = str(path.resolve())
    with _locks_guard:
        lock = _path_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _path_locks[key] = lock
        return lock


class CASConflictError(Exception):
    """Raised when CAS retries are exhausted (hot key)."""


class ImmutableWriteError(Exception):
    """Raised when attempting to overwrite an immutable file."""


def _content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def _read_with_hash(path: Path) -> tuple[Any, str]:
    """Read JSON + its content hash. Returns (data_or_None, hash)."""
    if not path.exists():
        return None, ""
    raw = path.read_bytes()
    try:
        data = json.loads(raw) if raw.strip() else None
    except json.JSONDecodeError:
        log.warning("sync.corrupt_json", path=str(path))
        data = None
    return data, _content_hash(raw)


def _atomic_write(path: Path, data: Any) -> None:
    """Write JSON atomically via a temp file + os.replace (atomic on all OSes)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(data, indent=2, default=str)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(serialized)
        os.replace(tmp, path)   # atomic
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def write_json_cas(
    path: Path,
    mutate_fn: Callable[[Any], Any],
    *,
    default: Any = None,
    max_retries: int = _MAX_CAS_RETRIES,
) -> Any:
    """
    Compare-and-swap JSON write.

    Reads the current content + hash, applies mutate_fn(current), and writes only
    if the file is unchanged since read. Retries on conflict (bounded).

    mutate_fn receives the current data (or `default` if the file is empty/missing)
    and must return the new data to write.

    Returns the data that was written.
    Raises CASConflictError if retries are exhausted.
    """
    lock = _lock_for(path)
    for attempt in range(max_retries):
        # Serialize the read-check-write so in-process writers never lose updates.
        with lock:
            current, read_hash = _read_with_hash(path)
            if current is None:
                current = default if default is not None else []

            new_data = mutate_fn(_deepcopy(current))

            # Re-check the hash right before writing (catches cross-process writes).
            _, now_hash = _read_with_hash(path)
            if now_hash == read_hash:
                _atomic_write(path, new_data)
                return new_data

        # Conflict — someone wrote between our read and write; retry
        log.debug("sync.cas_retry", path=str(path), attempt=attempt + 1)
        time.sleep(_RETRY_BASE_DELAY * (attempt + 1))

    log.error("sync.cas_exhausted", path=str(path))
    raise CASConflictError(f"CAS write failed after {max_retries} retries: {path}")


def merge_records(
    path: Path,
    new_records: dict[str, Any],
    *,
    key_field: Optional[str] = None,
) -> dict[str, Any]:
    """
    Merge top-level keyed records into a nervous-system JSON file using CAS.
    Last-writer-wins per key (each key is an independent record).

    If the file holds a list and key_field is given, records are keyed by that
    field; otherwise the file is treated as a dict keyed by record id.
    """
    def _mutate(current: Any) -> Any:
        if isinstance(current, list) and key_field:
            by_key = {r.get(key_field): r for r in current if isinstance(r, dict)}
            by_key.update(new_records)
            return list(by_key.values())
        if isinstance(current, dict):
            current.update(new_records)
            return current
        # Empty/unknown → start a dict
        return dict(new_records)

    return write_json_cas(path, _mutate, default={} if not key_field else [])


def append_jsonl(path: Path, record: dict) -> None:
    """
    Append a record to a JSONL file. Append-only → no read-modify-write, no
    conflict by construction. Each line is one JSON object.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, default=str)
    with _lock_for(path):
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
            f.flush()


def read_jsonl(path: Path, *, quarantine_bad: bool = True) -> list[dict]:
    """
    Read a JSONL file, skipping (and optionally quarantining) malformed lines.
    Returns the list of valid records.
    """
    if not path.exists():
        return []
    records: list[dict] = []
    bad_lines: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            bad_lines.append(line)
    if bad_lines and quarantine_bad:
        quarantine = path.with_suffix(path.suffix + ".bad")
        with open(quarantine, "a", encoding="utf-8") as f:
            for bl in bad_lines:
                f.write(bl + "\n")
        log.warning("sync.quarantined_lines", path=str(path), count=len(bad_lines))
    return records


def immutable_write(path: Path, data: Any) -> None:
    """
    Write a file that must never be overwritten (e.g. approval records).
    Raises ImmutableWriteError if the file already exists.
    """
    if path.exists():
        raise ImmutableWriteError(f"Refusing to overwrite immutable file: {path}")
    _atomic_write(path, data)


def record_conflict(
    quorum_dir: Path,
    file: str,
    description: str,
    detail: Optional[dict] = None,
) -> None:
    """
    Record an unresolvable conflict to nervous-system/conflicts.json (append via CAS).
    Surfaced to chat by the caller.
    """
    conflicts_path = quorum_dir / "nervous-system" / "conflicts.json"

    def _mutate(current: Any) -> Any:
        items = current if isinstance(current, list) else []
        items.append({
            "file": file,
            "description": description,
            "detail": detail or {},
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        return items

    write_json_cas(conflicts_path, _mutate, default=[])


# ── Helpers ───────────────────────────────────────────────────────────────────

def _deepcopy(obj: Any) -> Any:
    """Cheap deep copy via JSON round-trip (data is always JSON-serialisable here)."""
    return json.loads(json.dumps(obj, default=str)) if obj is not None else obj
