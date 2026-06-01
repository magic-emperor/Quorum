"""
Test/build runner tools.
Auto-detects the project type or uses a configured command.
Full detection logic in Phase 9; here we implement the basic runner.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from qorum.providers.base import ToolSpec
from qorum.tools.base import QorumTool, ToolContext, ToolResult
from qorum.tools.events import ToolEvent

_TIMEOUT = 300  # 5 minutes default for build/test


def _detect_test_cmd(cwd: Path) -> str:
    if (cwd / "pyproject.toml").exists() or (cwd / "setup.py").exists():
        return "python -m pytest --tb=short -q"
    if (cwd / "package.json").exists():
        return "npm test"
    if (cwd / "go.mod").exists():
        return "go test ./..."
    if (cwd / "Cargo.toml").exists():
        return "cargo test"
    if (cwd / "pom.xml").exists():
        return "mvn -q test"
    return ""


def _detect_build_cmd(cwd: Path) -> str:
    if (cwd / "package.json").exists():
        return "npm run build"
    if (cwd / "go.mod").exists():
        return "go build ./..."
    if (cwd / "Cargo.toml").exists():
        return "cargo build"
    if (cwd / "pom.xml").exists():
        return "mvn -q -DskipTests package"
    return ""


async def _run_cmd(command: str, cwd: Path, timeout: int) -> tuple[int, str]:
    import shlex
    try:
        parts = shlex.split(command)
        proc = await asyncio.create_subprocess_exec(
            *parts, cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            return 1, f"Command timed out after {timeout}s"
        return proc.returncode or 0, stdout.decode("utf-8", errors="replace")[:16_000]
    except FileNotFoundError as exc:
        return 1, f"Command not found: {exc}"


class RunTestsTool(QorumTool):
    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="run_tests",
            description="Run the project test suite. Auto-detects framework or uses override.",
            parameters={
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Override test command"},
                    "timeout": {"type": "integer"},
                },
                "required": [],
            },
        )

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        cmd = args.get("command") or _detect_test_cmd(ctx.cwd)
        if not cmd:
            return ToolResult.failure(
                "Could not detect a test command. Set 'command' explicitly or add a test_cmd "
                "to your registry.json."
            )
        allowed, reason = ctx.policy.check_shell(cmd)
        if not allowed:
            return ToolResult.failure(f"Test command blocked by policy: {reason}")

        timeout = args.get("timeout") or _TIMEOUT
        rc, output = await _run_cmd(cmd, ctx.cwd, timeout)
        ok = (rc == 0)
        event = ToolEvent(
            kind="test_result", agent=ctx.agent,
            summary=f"tests {'passed' if ok else 'FAILED'} (exit {rc})",
            exit_code=rc, ok=ok,
            payload={"command": cmd},
        )
        ctx.emit(event)
        return ToolResult(ok=ok, output=f"$ {cmd}\n{output}", event=event)


class RunBuildTool(QorumTool):
    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="run_build",
            description="Run the project build. Auto-detects framework or uses override.",
            parameters={
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "timeout": {"type": "integer"},
                },
                "required": [],
            },
        )

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        cmd = args.get("command") or _detect_build_cmd(ctx.cwd)
        if not cmd:
            return ToolResult.failure("Could not detect a build command.")
        allowed, reason = ctx.policy.check_shell(cmd)
        if not allowed:
            return ToolResult.failure(f"Build command blocked by policy: {reason}")

        timeout = args.get("timeout") or _TIMEOUT
        rc, output = await _run_cmd(cmd, ctx.cwd, timeout)
        ok = (rc == 0)
        event = ToolEvent(
            kind="build", agent=ctx.agent,
            summary=f"build {'succeeded' if ok else 'FAILED'} (exit {rc})",
            exit_code=rc, ok=ok,
            payload={"command": cmd},
        )
        ctx.emit(event)
        return ToolResult(ok=ok, output=f"$ {cmd}\n{output}", event=event)
