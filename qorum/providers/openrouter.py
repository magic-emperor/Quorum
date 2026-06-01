"""
OpenRouter gateway — routes to any model (vendor/model format).
Capabilities vary by the underlying model; defaults are conservative.
"""
from __future__ import annotations
from qorum.providers.base import Capabilities
from qorum.providers.openai_compat import OpenAICompatibleProvider


class OpenRouterProvider(OpenAICompatibleProvider):
    name = "openrouter"
    _base_url = "https://openrouter.ai/api/v1"
    _env_var = "QORUM_PROVIDER_OPENROUTER_API_KEY"

    def _model_capabilities(self, model: str) -> Capabilities:
        # Model strings are vendor/model e.g. "anthropic/claude-3-5-sonnet"
        m = model.lower()
        has_tools = any(x in m for x in ("claude", "gpt-4", "gpt-3.5", "mistral", "llama3"))
        has_json = any(x in m for x in ("claude", "gpt", "mistral", "gemini"))
        return Capabilities(
            native_tool_use=has_tools,
            json_mode=has_json,
            max_output_tokens=8_192,
            supports_system=True,
            context_window=128_000,
        )
