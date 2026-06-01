"""
Filesystem tools — read, write, edit, list, glob.
All writes are path-jailed to ctx.cwd.
"""
from __future__ import annotations

import difflib
from pathlib import Path
from typing import Any

from qorum.providers.base import ToolSpec
from qorum.tools.base import QorumTool, ToolContext, ToolResult
from qorum.tools.events import ToolEvent


def _safe_path(path_str: str, ctx: ToolContext) -> tuple[Path | None, str]:
    """Resolve path relative to cwd and check against jail. Returns (path, error_msg)."""
    raw = Path(path_str)
    if not raw.is_absolute():
        resolved = (ctx.cwd / raw).resolve()
    else:
        resolved = raw.resolve()
    ok, reason = ctx.policy.check_path(resolved)
    if not ok:
        return None, reason
    return resolved, ""


class ReadFileTool(QorumTool):
    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="read_file",
            description="Read the contents of a file. Path is relative to the repo root.",
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path relative to repo root"},
                    "start_line": {"type": "integer", "description": "First line to read (1-indexed, optional)"},
                    "end_line": {"type": "integer", "description": "Last line to read (inclusive, optional)"},
                },
                "required": ["path"],
            },
        )

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        p, err = _safe_path(args["path"], ctx)
        if p is None:
            return ToolResult.failure(err)
        if not p.exists():
            return ToolResult.failure(f"File not found: {args['path']}")
        if not p.is_file():
            return ToolResult.failure(f"Not a file: {args['path']}")

        try:
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError as exc:
            return ToolResult.failure(f"Cannot read {args['path']}: {exc}")

        start = max(0, (args.get("start_line") or 1) - 1)
        end = args.get("end_line")
        if end is not None:
            lines = lines[start:end]
        else:
            lines = lines[start:]

        content = "\n".join(f"{start + i + 1}: {l}" for i, l in enumerate(lines))
        event = ToolEvent(kind="file_open", agent=ctx.agent, summary=f"read {args['path']}",
                          path=args["path"])
        ctx.emit(event)
        return ToolResult.success(content or "(empty)", event=event)


class WriteFileTool(QorumTool):
    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="write_file",
            description="Write (overwrite) a file. Creates parent directories if needed. Path-jailed to repo root.",
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                    "reason": {"type": "string", "description": "Why this file is being written"},
                },
                "required": ["path", "content"],
            },
        )

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        p, err = _safe_path(args["path"], ctx)
        if p is None:
            return ToolResult.failure(err)

        existed = p.exists()
        old_lines = p.read_text(encoding="utf-8", errors="replace").splitlines() if existed else []
        new_lines = args["content"].splitlines()
        added = max(0, len(new_lines) - len(old_lines))
        removed = max(0, len(old_lines) - len(new_lines))

        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(args["content"], encoding="utf-8")
        except OSError as exc:
            return ToolResult.failure(f"Cannot write {args['path']}: {exc}")

        kind = "file_create" if not existed else "file_edit"
        event = ToolEvent(
            kind=kind, agent=ctx.agent,
            summary=f"{'create' if not existed else 'write'} {args['path']}",
            path=args["path"], lines_added=added, lines_removed=removed,
            reason=args.get("reason"),
        )
        ctx.emit(event)
        return ToolResult.success(f"Written: {args['path']} ({added}+ {removed}-)", event=event)


class EditFileTool(QorumTool):
    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="edit_file",
            description=(
                "Make a targeted string replacement in a file. "
                "old_string must appear exactly once. Path-jailed to repo root."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "old_string": {"type": "string", "description": "Exact text to replace"},
                    "new_string": {"type": "string", "description": "Replacement text"},
                    "reason": {"type": "string"},
                },
                "required": ["path", "old_string", "new_string"],
            },
        )

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        p, err = _safe_path(args["path"], ctx)
        if p is None:
            return ToolResult.failure(err)
        if not p.exists():
            return ToolResult.failure(f"File not found: {args['path']}")

        try:
            original = p.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            return ToolResult.failure(f"Cannot read {args['path']}: {exc}")

        old = args["old_string"]
        count = original.count(old)
        if count == 0:
            return ToolResult.failure(
                f"old_string not found in {args['path']}. "
                f"Make sure the text is an exact match (whitespace, quotes, newlines)."
            )
        if count > 1:
            return ToolResult.failure(
                f"old_string appears {count} times in {args['path']}. "
                f"Provide more context to make it unique."
            )

        new_content = original.replace(old, args["new_string"], 1)
        old_lines = original.splitlines()
        new_lines = new_content.splitlines()
        diff = list(difflib.unified_diff(old_lines, new_lines, lineterm=""))
        added = sum(1 for l in diff if l.startswith("+") and not l.startswith("+++"))
        removed = sum(1 for l in diff if l.startswith("-") and not l.startswith("---"))

        try:
            p.write_text(new_content, encoding="utf-8")
        except OSError as exc:
            return ToolResult.failure(f"Cannot write {args['path']}: {exc}")

        event = ToolEvent(
            kind="file_edit", agent=ctx.agent,
            summary=f"edit {args['path']}",
            path=args["path"], lines_added=added, lines_removed=removed,
            reason=args.get("reason"),
        )
        ctx.emit(event)
        return ToolResult.success(
            f"Edited {args['path']}: {added}+ {removed}-\nDiff:\n" + "\n".join(diff[:20]),
            event=event,
        )


class ListDirTool(QorumTool):
    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="list_dir",
            description="List the contents of a directory. Path-jailed to repo root.",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Directory path (relative)"}},
                "required": ["path"],
            },
        )

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        p, err = _safe_path(args["path"], ctx)
        if p is None:
            return ToolResult.failure(err)
        if not p.exists():
            return ToolResult.failure(f"Directory not found: {args['path']}")
        if not p.is_dir():
            return ToolResult.failure(f"Not a directory: {args['path']}")

        entries = sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name))
        lines = []
        for e in entries[:200]:
            rel = e.relative_to(ctx.cwd) if ctx.policy.repo_root else e
            prefix = "d " if e.is_dir() else "f "
            lines.append(prefix + str(rel))
        if len(list(p.iterdir())) > 200:
            lines.append("... (truncated at 200 entries)")

        event = ToolEvent(kind="file_open", agent=ctx.agent, summary=f"ls {args['path']}",
                          path=args["path"])
        ctx.emit(event)
        return ToolResult.success("\n".join(lines) or "(empty directory)", event=event)


class GlobTool(QorumTool):
    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="glob",
            description="Find files matching a glob pattern within the repo. Returns relative paths.",
            parameters={
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Glob pattern, e.g. 'src/**/*.py'"},
                    "base": {"type": "string", "description": "Base directory (optional, defaults to repo root)"},
                },
                "required": ["pattern"],
            },
        )

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        base_str = args.get("base", ".")
        base, err = _safe_path(base_str, ctx)
        if base is None:
            return ToolResult.failure(err)
        if not base.is_dir():
            return ToolResult.failure(f"Base directory not found: {base_str}")

        matches = sorted(base.glob(args["pattern"]))
        lines = [str(m.relative_to(ctx.cwd)) for m in matches[:500]]
        event = ToolEvent(kind="search", agent=ctx.agent,
                          summary=f"glob {args['pattern']} → {len(lines)} files",
                          payload={"pattern": args["pattern"]})
        ctx.emit(event)
        return ToolResult.success("\n".join(lines) or "(no matches)", data={"paths": lines}, event=event)
