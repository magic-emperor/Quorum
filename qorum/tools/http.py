"""
HTTP fetch tool — read-only, allow-list enforced (docs lookups only).
"""
from __future__ import annotations

from typing import Any

from qorum.providers.base import ToolSpec
from qorum.tools.base import QorumTool, ToolContext, ToolResult
from qorum.tools.events import ToolEvent

_MAX_BYTES = 32_000
_TIMEOUT = 10


class HttpFetchTool(QorumTool):
    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="http_fetch",
            description="Fetch a URL (read-only, for documentation lookups). Only allow-listed hosts.",
            parameters={
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "reason": {"type": "string"},
                },
                "required": ["url"],
            },
        )

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        url = args["url"]
        allowed, reason = ctx.policy.check_http(url)
        if not allowed:
            return ToolResult.failure(f"HTTP fetch blocked by policy: {reason}")

        try:
            import httpx
            async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
                response = await client.get(url)
            content = response.text[:_MAX_BYTES]
            if len(response.text) > _MAX_BYTES:
                content += f"\n... (truncated at {_MAX_BYTES} chars)"
        except ImportError:
            return ToolResult.failure("httpx is required for http_fetch. pip install httpx")
        except Exception as exc:
            return ToolResult.failure(f"HTTP fetch failed: {exc}")

        event = ToolEvent(kind="http", agent=ctx.agent, summary=f"fetch {url[:80]}",
                          reason=args.get("reason"), payload={"url": url})
        ctx.emit(event)
        return ToolResult.success(content, event=event)
