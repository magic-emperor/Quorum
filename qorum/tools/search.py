"""
Search tools — grep (ripgrep-backed with fallback), find_symbol.
Path-jailed to ctx.cwd.
"""
from __future__ import annotations

import asyncio
import re
from pathlib import Path
from typing import Any

from qorum.providers.base import ToolSpec
from qorum.tools.base import QorumTool, ToolContext, ToolResult
from qorum.tools.events import ToolEvent


async def _rg_or_grep(pattern: str, path: Path, flags: str = "") -> tuple[int, str]:
    """Run ripgrep if available, fall back to Python grep."""
    # Try ripgrep first
    cmd = ["rg", "--line-number", "--no-heading", "--color=never"]
    if "-i" in flags:
        cmd.append("-i")
    cmd += [pattern, str(path)]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10.0)
        return proc.returncode or 0, stdout.decode("utf-8", errors="replace")[:8000]
    except (FileNotFoundError, asyncio.TimeoutError):
        pass

    # Fallback: Python re-based grep
    lines_out = []
    regex = re.compile(pattern, re.IGNORECASE if "-i" in flags else 0)
    for f in path.rglob("*") if path.is_dir() else [path]:
        if not f.is_file():
            continue
        try:
            for i, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if regex.search(line):
                    rel = f.relative_to(path) if path.is_dir() else f.name
                    lines_out.append(f"{rel}:{i}: {line}")
                    if len(lines_out) >= 200:
                        return 0, "\n".join(lines_out)
        except OSError:
            continue
    return 0, "\n".join(lines_out)


class GrepTool(QorumTool):
    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="grep",
            description="Search files for a regex pattern. Returns file:line:content matches.",
            parameters={
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regular expression to search for"},
                    "path": {"type": "string", "description": "File or directory (relative to repo root)"},
                    "case_insensitive": {"type": "boolean", "default": False},
                    "glob": {"type": "string", "description": "File glob filter e.g. '*.py'"},
                },
                "required": ["pattern"],
            },
        )

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        from qorum.tools.fs import _safe_path
        path_str = args.get("path", ".")
        p, err = _safe_path(path_str, ctx)
        if p is None:
            return ToolResult.failure(err)

        flags = "-i" if args.get("case_insensitive") else ""
        _, output = await _rg_or_grep(args["pattern"], p, flags)

        event = ToolEvent(kind="search", agent=ctx.agent,
                          summary=f"grep '{args['pattern']}' in {path_str}",
                          payload={"pattern": args["pattern"], "path": path_str})
        ctx.emit(event)
        return ToolResult.success(output or "(no matches)", event=event)


class FindSymbolTool(QorumTool):
    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="find_symbol",
            description="Find where a function, class, or variable is defined in the codebase.",
            parameters={
                "type": "object",
                "properties": {
                    "symbol": {"type": "string", "description": "Symbol name to find"},
                    "kind": {"type": "string", "enum": ["function", "class", "variable", "any"],
                             "default": "any"},
                },
                "required": ["symbol"],
            },
        )

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        symbol = args["symbol"]
        kind = args.get("kind", "any")
        # Build a pattern based on common language conventions
        patterns = []
        if kind in ("function", "any"):
            patterns += [
                rf"def {re.escape(symbol)}\s*\(",           # Python
                rf"async def {re.escape(symbol)}\s*\(",     # Python async
                rf"function {re.escape(symbol)}\s*\(",      # JS
                rf"const {re.escape(symbol)}\s*=.*=>",      # JS arrow
                rf"func {re.escape(symbol)}\s*\(",          # Go
                rf"fn {re.escape(symbol)}\s*\(",            # Rust
            ]
        if kind in ("class", "any"):
            patterns += [
                rf"class {re.escape(symbol)}[\s(:]",        # Python/JS
                rf"struct {re.escape(symbol)}\s*\{{",       # Rust/Go
                rf"interface {re.escape(symbol)}\s*\{{",
            ]
        if kind in ("variable", "any"):
            patterns += [
                rf"\b{re.escape(symbol)}\s*=",
                rf"const {re.escape(symbol)}\s*=",
                rf"let {re.escape(symbol)}\s*=",
                rf"var {re.escape(symbol)}\s*=",
            ]

        combined = "|".join(f"({p})" for p in patterns)
        _, output = await _rg_or_grep(combined, ctx.cwd, "")

        event = ToolEvent(kind="search", agent=ctx.agent,
                          summary=f"find_symbol '{symbol}'",
                          payload={"symbol": symbol})
        ctx.emit(event)
        return ToolResult.success(output or f"Symbol '{symbol}' not found.", event=event)
