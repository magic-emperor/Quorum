"""
Anthropic Claude provider.
Default executor provider — best native tool use for code tasks.
"""
from __future__ import annotations

import json
from typing import Any, Optional

from qorum.providers.base import (
    Capabilities, LLMMessage, LLMProvider, LLMResponse, ToolCall, ToolSpec,
)
from qorum.providers.errors import (
    ProviderAuthError, ProviderBadRequest, ProviderNotConfigured,
    ProviderRateLimit, ProviderServerError,
)


class AnthropicProvider(LLMProvider):
    name = "anthropic"
    _env_var = "QORUM_PROVIDER_ANTHROPIC_API_KEY"

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    def is_configured(self) -> bool:
        return bool(self._api_key)

    def capabilities(self, model: str) -> Capabilities:
        m = model.lower()
        # Claude 3+ all support tool use
        if "claude" in m:
            # claude-3-7+ / claude-sonnet-4+ have extended thinking
            has_thinking = any(x in m for x in ("3-7", "3.7", "sonnet-4", "opus-4", "haiku-4"))
            return Capabilities(
                native_tool_use=True,
                json_mode=False,
                max_output_tokens=8192,
                supports_system=True,
                context_window=200_000,
                native_web_search=True,   # Claude supports web_search tool natively
                native_thinking=has_thinking,
            )
        return Capabilities()

    async def complete(
        self,
        messages: list[LLMMessage],
        *,
        model: str,
        tools: Optional[list[ToolSpec]] = None,
        json_mode: bool = False,
        max_tokens: Optional[int] = None,
        temperature: float = 0.2,
    ) -> LLMResponse:
        if not self.is_configured():
            raise ProviderNotConfigured(self.name, self._env_var)

        try:
            import anthropic
        except ImportError as exc:
            raise ImportError("anthropic package is required. pip install anthropic") from exc

        client = anthropic.AsyncAnthropic(api_key=self._api_key)
        caps = self.capabilities(model)

        # Extract system message (Anthropic uses a dedicated param)
        system_parts = [m.content for m in messages if m.role == "system"]
        non_system = [m for m in messages if m.role != "system"]
        system_str = "\n".join(system_parts)

        if json_mode:
            system_str += self.build_json_system_suffix()

        oai_msgs = [{"role": m.role, "content": m.content} for m in non_system
                    if m.role in ("user", "assistant")]

        kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens or caps.max_output_tokens,
            "temperature": temperature,
            "messages": oai_msgs,
        }
        if system_str:
            kwargs["system"] = system_str
        if tools and caps.native_tool_use:
            kwargs["tools"] = [
                {
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.parameters,
                }
                for t in tools
            ]

        try:
            response = await client.messages.create(**kwargs)
        except anthropic.AuthenticationError as exc:
            raise ProviderAuthError(str(exc), provider=self.name, model=model) from exc
        except anthropic.RateLimitError as exc:
            raise ProviderRateLimit(str(exc), retry_after=30, provider=self.name, model=model) from exc
        except anthropic.BadRequestError as exc:
            raise ProviderBadRequest(str(exc), provider=self.name, model=model) from exc
        except anthropic.APIError as exc:
            if getattr(exc, "status_code", 0) >= 500:
                raise ProviderServerError(str(exc), provider=self.name, model=model) from exc
            raise ProviderBadRequest(str(exc), provider=self.name, model=model) from exc

        # Parse content blocks
        text_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        for block in response.content:
            if block.type == "text":
                text_parts.append(self.strip_fences(block.text))
            elif block.type == "tool_use":
                tool_calls.append(ToolCall(
                    id=block.id,
                    name=block.name,
                    arguments=block.input if isinstance(block.input, dict) else {},
                ))

        finish_map = {
            "end_turn": "stop",
            "tool_use": "tool_calls",
            "max_tokens": "length",
        }
        finish = finish_map.get(response.stop_reason or "end_turn", "stop")

        usage = {
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
        }

        return LLMResponse(
            text=" ".join(text_parts),
            tool_calls=tool_calls,
            finish_reason=finish,
            usage=usage,
            raw=response,
        )
