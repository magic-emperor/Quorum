"""
OpenAI-API-compatible provider base.
DeepSeek, Groq, Moonshot, and OpenRouter are thin subclasses — they use the
same REST API shape as OpenAI but with a different base_url and API key.
"""
from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Optional

from qorum.providers.base import (
    Capabilities, LLMMessage, LLMProvider, LLMResponse, ToolCall, ToolSpec,
)
from qorum.providers.errors import (
    ProviderAuthError, ProviderBadRequest, ProviderNotConfigured,
    ProviderRateLimit, ProviderServerError,
)

if TYPE_CHECKING:
    pass


class OpenAICompatibleProvider(LLMProvider):
    """
    Provider for any API that speaks the OpenAI Chat Completions format.
    Subclasses set: name, api_key, base_url, default_capabilities.
    """

    name: str = "openai_compat"
    _base_url: str = "https://api.openai.com/v1"
    _env_var: str = "OPENAI_API_KEY"

    def __init__(self, api_key: str, base_url: Optional[str] = None) -> None:
        self._api_key = api_key
        if base_url:
            self._base_url = base_url

    def is_configured(self) -> bool:
        return bool(self._api_key)

    def capabilities(self, model: str) -> Capabilities:
        return self._model_capabilities(model)

    def _model_capabilities(self, model: str) -> Capabilities:
        """Override in subclasses for model-specific capability maps."""
        return Capabilities(
            native_tool_use=True,
            json_mode=True,
            max_output_tokens=16_384,
            supports_system=True,
            context_window=128_000,
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
            import openai  # lazy import — only needed when provider is used
        except ImportError as exc:
            raise ImportError(
                f"openai package is required for {self.name}. "
                f"Install with: pip install openai"
            ) from exc

        client = openai.AsyncOpenAI(api_key=self._api_key, base_url=self._base_url)
        caps = self.capabilities(model)

        # Build message list
        oai_messages = self._to_oai_messages(messages, caps)

        # Build kwargs
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": oai_messages,
            "temperature": temperature,
        }
        if max_tokens:
            kwargs["max_tokens"] = max_tokens

        if json_mode and caps.json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        elif json_mode:
            # Inject JSON instruction into the last user message
            kwargs["messages"] = self._inject_json_instruction(oai_messages)

        if tools and caps.native_tool_use:
            kwargs["tools"] = [self._to_oai_tool(t) for t in tools]
            kwargs["tool_choice"] = "auto"

        try:
            response = await client.chat.completions.create(**kwargs)
        except openai.AuthenticationError as exc:
            raise ProviderAuthError(str(exc), provider=self.name, model=model) from exc
        except openai.RateLimitError as exc:
            raise ProviderRateLimit(str(exc), retry_after=30, provider=self.name, model=model) from exc
        except openai.BadRequestError as exc:
            raise ProviderBadRequest(str(exc), provider=self.name, model=model) from exc
        except openai.APIStatusError as exc:
            if exc.status_code >= 500:
                raise ProviderServerError(str(exc), provider=self.name, model=model) from exc
            raise ProviderBadRequest(str(exc), provider=self.name, model=model) from exc

        choice = response.choices[0]
        msg = choice.message

        tool_calls = []
        if msg.tool_calls:
            for tc in msg.tool_calls:
                try:
                    args = json.loads(tc.function.arguments) if tc.function.arguments else {}
                except json.JSONDecodeError:
                    args = {"_raw": tc.function.arguments}
                tool_calls.append(ToolCall(id=tc.id, name=tc.function.name, arguments=args))

        finish = choice.finish_reason or "stop"
        if tool_calls and finish != "tool_calls":
            finish = "tool_calls"

        usage = {}
        if response.usage:
            usage = {
                "input_tokens": response.usage.prompt_tokens or 0,
                "output_tokens": response.usage.completion_tokens or 0,
            }

        return LLMResponse(
            text=self.strip_fences(msg.content or ""),
            tool_calls=tool_calls,
            finish_reason=finish,
            usage=usage,
            raw=response,
        )

    # ── Helpers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _to_oai_messages(messages: list[LLMMessage], caps: Capabilities) -> list[dict]:
        result = []
        for m in messages:
            if m.role == "system" and not caps.supports_system:
                # Convert to a user message if system not supported
                result.append({"role": "user", "content": f"[SYSTEM] {m.content}"})
            elif m.role == "tool":
                result.append({
                    "role": "tool",
                    "tool_call_id": m.tool_call_id or "",
                    "content": m.content,
                })
            elif m.role == "assistant" and m.tool_calls:
                result.append({
                    "role": "assistant",
                    "content": m.content or "",
                    "tool_calls": [
                        {"id": tc.id, "type": "function", "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)}}
                        for tc in m.tool_calls
                    ],
                })
            else:
                result.append({"role": m.role, "content": m.content})
        return result

    @staticmethod
    def _inject_json_instruction(messages: list[dict]) -> list[dict]:
        suffix = (
            "\n\nCRITICAL: Respond with a single valid JSON object only. "
            "No text before or after. No markdown. Pure JSON."
        )
        msgs = list(messages)
        # Append to last user message, or add one
        for i in range(len(msgs) - 1, -1, -1):
            if msgs[i]["role"] == "user":
                msgs[i] = dict(msgs[i])
                msgs[i]["content"] = str(msgs[i]["content"]) + suffix
                return msgs
        msgs.append({"role": "user", "content": suffix.strip()})
        return msgs

    @staticmethod
    def _to_oai_tool(t: ToolSpec) -> dict:
        return {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
            },
        }
