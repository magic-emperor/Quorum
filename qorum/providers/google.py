"""
Google Gemini provider via the google-genai SDK.
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


class GoogleProvider(LLMProvider):
    name = "google"
    _env_var = "QORUM_PROVIDER_GOOGLE_API_KEY"

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    def is_configured(self) -> bool:
        return bool(self._api_key)

    def capabilities(self, model: str) -> Capabilities:
        m = model.lower()
        if "1.5" in m or "2.0" in m or "2.5" in m or "flash" in m or "pro" in m:
            return Capabilities(
                native_tool_use=True,
                json_mode=True,
                max_output_tokens=8_192,
                supports_system=True,
                context_window=1_000_000,
                native_web_search=True,   # Gemini Grounding / Google Search tool
                native_thinking=False,
            )
        return Capabilities(json_mode=True, max_output_tokens=4_096)

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
            import google.generativeai as genai  # type: ignore
        except ImportError as exc:
            raise ImportError("google-generativeai package required. pip install google-generativeai") from exc

        genai.configure(api_key=self._api_key)
        caps = self.capabilities(model)

        system_parts = [m.content for m in messages if m.role == "system"]
        system_str = "\n".join(system_parts) or None
        if json_mode and not caps.json_mode:
            extra = self.build_json_system_suffix()
            system_str = (system_str or "") + extra

        gen_config: dict[str, Any] = {
            "temperature": temperature,
            "max_output_tokens": max_tokens or caps.max_output_tokens,
        }
        if json_mode and caps.json_mode:
            gen_config["response_mime_type"] = "application/json"

        mdl = genai.GenerativeModel(
            model_name=model,
            system_instruction=system_str,
            generation_config=genai.types.GenerationConfig(**gen_config),
        )

        # Convert messages to Gemini format (alternating user/model)
        history = []
        user_parts: list[str] = []
        for m in messages:
            if m.role == "system":
                continue
            role = "model" if m.role == "assistant" else "user"
            if history and history[-1]["role"] == role:
                history[-1]["parts"].append(m.content)
            else:
                history.append({"role": role, "parts": [m.content]})

        if not history:
            history = [{"role": "user", "parts": ["Hello"]}]

        last = history.pop()  # send last as prompt

        try:
            chat = mdl.start_chat(history=history)
            response = await chat.send_message_async(last["parts"])
        except Exception as exc:
            err = str(exc).lower()
            if "api_key" in err or "auth" in err or "401" in err:
                raise ProviderAuthError(str(exc), provider=self.name, model=model) from exc
            if "quota" in err or "429" in err or "resource_exhausted" in err:
                raise ProviderRateLimit(str(exc), retry_after=30, provider=self.name, model=model) from exc
            if "500" in err or "503" in err:
                raise ProviderServerError(str(exc), provider=self.name, model=model) from exc
            raise ProviderBadRequest(str(exc), provider=self.name, model=model) from exc

        text = self.strip_fences(response.text or "")
        usage = {}
        if hasattr(response, "usage_metadata") and response.usage_metadata:
            usage = {
                "input_tokens": getattr(response.usage_metadata, "prompt_token_count", 0),
                "output_tokens": getattr(response.usage_metadata, "candidates_token_count", 0),
            }

        return LLMResponse(
            text=text, tool_calls=[], finish_reason="stop", usage=usage, raw=response
        )
