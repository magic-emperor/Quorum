"""
OpenAI provider (Chat Completions API).
Extends OpenAICompatibleProvider with OpenAI-specific model capability maps.
"""
from __future__ import annotations

from qorum.providers.base import Capabilities
from qorum.providers.openai_compat import OpenAICompatibleProvider


class OpenAIProvider(OpenAICompatibleProvider):
    name = "openai"
    _base_url = "https://api.openai.com/v1"
    _env_var = "QORUM_PROVIDER_OPENAI_API_KEY"

    def _model_capabilities(self, model: str) -> Capabilities:
        m = model.lower()
        if any(x in m for x in ("gpt-4o", "gpt-4-turbo", "gpt-4.1", "o1", "o3", "o4")):
            return Capabilities(
                native_tool_use=True,
                json_mode=True,
                max_output_tokens=16_384,
                supports_system=True,
                context_window=128_000,
            )
        if "gpt-3.5" in m:
            return Capabilities(
                native_tool_use=True,
                json_mode=True,
                max_output_tokens=4_096,
                supports_system=True,
                context_window=16_385,
            )
        # Default
        return Capabilities(native_tool_use=True, json_mode=True, max_output_tokens=8_192)
