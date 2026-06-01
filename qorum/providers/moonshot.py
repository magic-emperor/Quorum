"""Moonshot AI (Kimi) provider — OpenAI-compatible API."""
from __future__ import annotations
from qorum.providers.base import Capabilities
from qorum.providers.openai_compat import OpenAICompatibleProvider


class MoonshotProvider(OpenAICompatibleProvider):
    name = "moonshot"
    _base_url = "https://api.moonshot.cn/v1"
    _env_var = "QORUM_PROVIDER_MOONSHOT_API_KEY"

    def _model_capabilities(self, model: str) -> Capabilities:
        return Capabilities(
            native_tool_use=True,
            json_mode=True,
            max_output_tokens=8_192,
            supports_system=True,
            context_window=128_000,
        )
