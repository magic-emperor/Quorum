"""DeepSeek provider — OpenAI-compatible API."""
from __future__ import annotations
from qorum.providers.base import Capabilities
from qorum.providers.openai_compat import OpenAICompatibleProvider


class DeepSeekProvider(OpenAICompatibleProvider):
    name = "deepseek"
    _base_url = "https://api.deepseek.com/v1"
    _env_var = "QORUM_PROVIDER_DEEPSEEK_API_KEY"

    def _model_capabilities(self, model: str) -> Capabilities:
        return Capabilities(
            native_tool_use=True,
            json_mode=True,
            max_output_tokens=8_192,
            supports_system=True,
            context_window=64_000,
        )
