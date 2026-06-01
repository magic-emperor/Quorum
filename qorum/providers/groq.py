"""Groq provider — OpenAI-compatible, very fast. Best for 'fast' role."""
from __future__ import annotations
from qorum.providers.base import Capabilities
from qorum.providers.openai_compat import OpenAICompatibleProvider


class GroqProvider(OpenAICompatibleProvider):
    name = "groq"
    _base_url = "https://api.groq.com/openai/v1"
    _env_var = "QORUM_PROVIDER_GROQ_API_KEY"

    def _model_capabilities(self, model: str) -> Capabilities:
        m = model.lower()
        has_tools = "llama3" in m or "mixtral" in m or "gemma" in m
        return Capabilities(
            native_tool_use=has_tools,
            json_mode=True,
            max_output_tokens=8_192,
            supports_system=True,
            context_window=131_072,
        )
