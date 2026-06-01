"""
Phase 8 — Change log builder.

Converts ToolEvents from the agent harness into a ChangeLog (list of
ChangeLogEntry). Each entry records path, action, line delta, agent, and reason.

Reason comes from:
  1. The agent's stated intent attached to the ToolEvent payload["reason"]
  2. Fallback: matching entry in plan's file_change_intent list
  3. Fallback: "edited by <agent>"
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from qorum.core.schemas import FileChangeIntent
from qorum.execution.schemas import ChangeAction, ChangeLogEntry
from qorum.tools.events import ToolEvent


def build_change_log(
    events: list[ToolEvent],
    repo_root: Path,
    file_change_intent: list[FileChangeIntent],
) -> list[ChangeLogEntry]:
    """
    Build a ChangeLog from ToolEvents produced by the harness.
    File-system write events are translated into ChangeLogEntries.
    """
    intent_map = {fci.path: fci for fci in file_change_intent}
    entries: dict[str, ChangeLogEntry] = {}   # path → latest entry

    for event in events:
        if event.kind not in ("fs_write", "fs_edit", "fs_delete", "fs_create"):
            continue

        path = event.payload.get("path", "")
        if not path:
            continue

        # Normalise to repo-relative path
        try:
            rel = Path(path).resolve().relative_to(repo_root.resolve())
            path_key = str(rel).replace("\\", "/")
        except ValueError:
            path_key = path

        action = _event_to_action(event.kind)
        lines_added   = int(event.payload.get("lines_added", 0))
        lines_removed = int(event.payload.get("lines_removed", 0))

        # Try to infer line delta from diff payload if counts not explicit
        if lines_added == 0 and lines_removed == 0 and "diff" in event.payload:
            lines_added, lines_removed = _count_diff_lines(event.payload["diff"])

        reason = (
            event.payload.get("reason")
            or (intent_map[path_key].reason if path_key in intent_map else "")
            or f"edited by {event.agent}"
        )

        if path_key in entries:
            # Merge: accumulate line counts, keep latest action/reason
            existing = entries[path_key]
            entries[path_key] = ChangeLogEntry(
                path=path_key,
                action=action,
                lines_added=existing.lines_added + lines_added,
                lines_removed=existing.lines_removed + lines_removed,
                agent=event.agent,
                reason=reason or existing.reason,
            )
        else:
            entries[path_key] = ChangeLogEntry(
                path=path_key,
                action=action,
                lines_added=lines_added,
                lines_removed=lines_removed,
                agent=event.agent,
                reason=reason,
            )

    return list(entries.values())


def render_for_commit_message(entries: list[ChangeLogEntry]) -> str:
    """Render the Changes: section of the structured commit message."""
    lines = ["Changes:"]
    for e in entries:
        lines.append(f"  {e.path}: {e.action} — {e.reason}")
    return "\n".join(lines)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _event_to_action(kind: str) -> ChangeAction:
    return {
        "fs_create": "create",
        "fs_write": "modify",
        "fs_edit": "modify",
        "fs_delete": "delete",
    }.get(kind, "modify")


def _count_diff_lines(diff_text: str) -> tuple[int, int]:
    """Count +/- lines in a unified diff string."""
    added = removed = 0
    for line in diff_text.splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            added += 1
        elif line.startswith("-") and not line.startswith("---"):
            removed += 1
    return added, removed
