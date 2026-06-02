"""
Mistral AI provider via the mistralai SDK.
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


class MistralProvider(LLMProvider):
    name = "mistral"
    _env_var = "QORUM_PROVIDER_MISTRAL_API_KEY"

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    def is_configured(self) -> bool:
        return bool(self._api_key)

    def capabilities(self, model: str) -> Capabilities:
        m = model.lower()
        has_tools = any(x in m for x in ("mistral-large", "mistral-small", "mixtral", "codestral"))
        return Capabilities(
            native_tool_use=has_tools,
            json_mode=True,
            max_output_tokens=8_192,
            supports_system=True,
            context_window=32_768,
        )

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
            from mistralai import Mistral  # type: ignore
        except ImportError as exc:
            raise ImportError("mistralai package required. pip install mistralai") from exc

        client = Mistral(api_key=self._api_key)
        caps = self.capabilities(model)

        msgs = []
        for m in messages:
            if m.role == "tool":
                msgs.append({"role": "tool", "tool_call_id": m.tool_call_id or "", "content": m.content or "", "name": m.name or ""})
            elif m.role == "assistant" and m.tool_calls:
                msgs.append({
                    "role": "assistant",
                    "content": m.content or "",
                    "tool_calls": [
                        {"id": tc.id, "type": "function", "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)}}
                        for tc in m.tool_calls
                    ],
                })
            else:
                msgs.append({"role": m.role, "content": m.content or ""})
        if json_mode and not caps.json_mode:
            msgs[-1]["content"] = str(msgs[-1]["content"]) + self.build_json_system_suffix()

        kwargs: dict[str, Any] = {
            "model": model,
            "messages": msgs,
            "temperature": temperature,
        }
        if max_tokens:
            kwargs["max_tokens"] = max_tokens
        if json_mode and caps.json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        if tools and caps.native_tool_use:
            kwargs["tools"] = [
                {"type": "function", "function": {
                    "name": t.name, "description": t.description, "parameters": t.parameters
                }}
                for t in tools
            ]

        try:
            response = await client.chat.complete_async(**kwargs)
        except Exception as exc:
            err = str(exc).lower()
            if "401" in err or "api_key" in err or "auth" in err:
                raise ProviderAuthError(str(exc), provider=self.name, model=model) from exc
            if "429" in err or "rate" in err:
                raise ProviderRateLimit(str(exc), retry_after=15, provider=self.name, model=model) from exc
            if any(c in err for c in ("500", "502", "503")):
                raise ProviderServerError(str(exc), provider=self.name, model=model) from exc
            raise ProviderBadRequest(str(exc), provider=self.name, model=model) from exc

        choice = response.choices[0]
        msg = choice.message

        tool_calls: list[ToolCall] = []
        if msg.tool_calls:
            for tc in msg.tool_calls:
                try:
                    args = json.loads(tc.function.arguments)
                except Exception:
                    args = {}
                tool_calls.append(ToolCall(id=tc.id, name=tc.function.name, arguments=args))

        usage = {}
        if response.usage:
            usage = {
                "input_tokens": response.usage.prompt_tokens or 0,
                "output_tokens": response.usage.completion_tokens or 0,
            }

        return LLMResponse(
            text=self.strip_fences(msg.content or ""),
            tool_calls=tool_calls,
            finish_reason=choice.finish_reason or "stop",
            usage=usage,
            raw=response,
        )
