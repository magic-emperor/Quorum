"""
Shell tool — run_command with allow-list enforcement, timeout, and output truncation.
"""
from __future__ import annotations

import asyncio
import shlex
from typing import Any

from qorum.providers.base import ToolSpec
from qorum.tools.base import QorumTool, ToolContext, ToolResult
from qorum.tools.events import ToolEvent

_MAX_OUTPUT = 16_000   # chars — truncate beyond this
_DEFAULT_TIMEOUT = 60  # seconds


class RunCommandTool(QorumTool):
    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="run_command",
            description=(
                "Run a shell command in the repo working directory. "
                "Must be in the allow-list. stdout+stderr are captured and returned."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The shell command to run"},
                    "timeout": {"type": "integer", "description": "Timeout in seconds (default 60)"},
                    "reason": {"type": "string"},
                },
                "required": ["command"],
            },
        )

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        command = args["command"]
        timeout = args.get("timeout") or _DEFAULT_TIMEOUT

        allowed, reason = ctx.policy.check_shell(command)
        if not allowed:
            return ToolResult.failure(f"Command blocked by policy: {reason}")

        try:
            parts = shlex.split(command)
        except ValueError as exc:
            return ToolResult.failure(f"Cannot parse command: {exc}")

        try:
            proc = await asyncio.create_subprocess_exec(
                *parts,
                cwd=str(ctx.cwd),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            try:
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.communicate()
                return ToolResult.failure(
                    f"Command timed out after {timeout}s: {command[:80]}"
                )
        except FileNotFoundError:
            return ToolResult.failure(f"Command not found: {parts[0]}")
        except OSError as exc:
            return ToolResult.failure(f"OS error running command: {exc}")

        output = stdout.decode("utf-8", errors="replace")
        if len(output) > _MAX_OUTPUT:
            output = output[:_MAX_OUTPUT] + f"\n... (truncated at {_MAX_OUTPUT} chars)"

        ok = (proc.returncode == 0)
        event = ToolEvent(
            kind="command", agent=ctx.agent,
            summary=f"$ {command[:80]}",
            exit_code=proc.returncode,
            ok=ok,
            reason=args.get("reason"),
            payload={"command": command},
        )
        ctx.emit(event)

        result_text = f"Exit code: {proc.returncode}\n{output}"
        return ToolResult(ok=ok, output=result_text, event=event)
