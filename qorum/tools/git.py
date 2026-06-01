"""
Git tools — status, diff, stash, branch, add, commit.
NO push tool exists by default (policy.allow_git_push=False).
"""
from __future__ import annotations

import asyncio
import shlex
from typing import Any

from qorum.providers.base import ToolSpec
from qorum.tools.base import QorumTool, ToolContext, ToolResult
from qorum.tools.events import ToolEvent

_GIT_TIMEOUT = 30


async def _git(args_list: list[str], cwd: str) -> tuple[int, str]:
    cmd = ["git"] + args_list
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=_GIT_TIMEOUT)
        return proc.returncode or 0, stdout.decode("utf-8", errors="replace")
    except asyncio.TimeoutError:
        return 1, "git command timed out"
    except FileNotFoundError:
        return 1, "git not found in PATH"


class GitStatusTool(QorumTool):
    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="git_status",
            description="Show the working tree status.",
            parameters={"type": "object", "properties": {}, "required": []},
        )

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        rc, out = await _git(["status", "--short"], str(ctx.cwd))
        event = ToolEvent(kind="git", agent=ctx.agent, summary="git status", ok=(rc == 0))
        ctx.emit(event)
        return ToolResult(ok=(rc == 0), output=out or "(clean)", event=event)


class GitDiffTool(QorumTool):
    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="git_diff",
            description="Show changes in the working tree or staged area.",
            parameters={
                "type": "object",
                "properties": {
                    "staged": {"type": "boolean", "description": "Show staged changes (default false)"},
                    "path": {"type": "string", "description": "Limit diff to this file/dir (optional)"},
                },
                "required": [],
            },
        )

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        git_args = ["diff"]
        if args.get("staged"):
            git_args.append("--staged")
        if args.get("path"):
            git_args += ["--", args["path"]]
        rc, out = await _git(git_args, str(ctx.cwd))
        event = ToolEvent(kind="git", agent=ctx.agent, summary="git diff", ok=(rc == 0))
        ctx.emit(event)
        return ToolResult(ok=(rc == 0), output=out[:16_000] or "(no changes)", event=event)


class GitStashTool(QorumTool):
    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="git_stash",
            description="Stash or pop the working tree changes.",
            parameters={
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["push", "pop", "list"], "default": "push"},
                    "message": {"type": "string"},
                },
                "required": [],
            },
        )

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        action = args.get("action", "push")
        git_args = ["stash", action]
        if action == "push":
            git_args += ["--include-untracked"]
            if args.get("message"):
                git_args += ["-m", args["message"]]
        rc, out = await _git(git_args, str(ctx.cwd))
        event = ToolEvent(kind="git", agent=ctx.agent, summary=f"git stash {action}", ok=(rc == 0))
        ctx.emit(event)
        return ToolResult(ok=(rc == 0), output=out, event=event)


class GitBranchTool(QorumTool):
    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="git_branch",
            description="Create and/or checkout a branch.",
            parameters={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Branch name"},
                    "base": {"type": "string", "description": "Base branch (default: current HEAD)"},
                },
                "required": ["name"],
            },
        )

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        name = args["name"]
        base = args.get("base", "HEAD")
        # Create + checkout in one step
        rc, out = await _git(["checkout", "-b", name, base], str(ctx.cwd))
        if rc != 0 and "already exists" in out:
            rc, out = await _git(["checkout", name], str(ctx.cwd))
        event = ToolEvent(kind="git", agent=ctx.agent, summary=f"git branch {name}", ok=(rc == 0))
        ctx.emit(event)
        return ToolResult(ok=(rc == 0), output=out, event=event)


class GitAddTool(QorumTool):
    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="git_add",
            description="Stage files for commit.",
            parameters={
                "type": "object",
                "properties": {
                    "paths": {"type": "array", "items": {"type": "string"},
                              "description": "File paths to stage. Use ['.'] for all."},
                },
                "required": ["paths"],
            },
        )

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        paths = args.get("paths") or ["."]
        rc, out = await _git(["add", "--"] + paths, str(ctx.cwd))
        event = ToolEvent(kind="git", agent=ctx.agent, summary=f"git add {paths}", ok=(rc == 0))
        ctx.emit(event)
        return ToolResult(ok=(rc == 0), output=out or "staged", event=event)


class GitCommitTool(QorumTool):
    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="git_commit",
            description=(
                "Commit staged changes. Only available after developer diff approval. "
                "NEVER use git push — that is a separate developer action."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "message": {"type": "string", "description": "Commit message"},
                },
                "required": ["message"],
            },
        )

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        if not ctx.policy.allow_git_commit:
            return ToolResult.failure("git_commit is not permitted by the current policy.")

        rc, out = await _git(["commit", "-m", args["message"]], str(ctx.cwd))
        event = ToolEvent(kind="git", agent=ctx.agent, summary="git commit", ok=(rc == 0),
                          payload={"message": args["message"][:80]})
        ctx.emit(event)
        return ToolResult(ok=(rc == 0), output=out, event=event)
