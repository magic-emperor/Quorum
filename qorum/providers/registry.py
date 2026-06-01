"""
Provider registry — resolves (role → provider, model) from config.

Roles:
  summarize    — extract decisions from raw chat; cheap + fast
  classify     — actionability gate + work-type + complexity; cheap
  plan         — generate plan.md; needs quality reasoning
  phase_split  — propose phase breakdown for large tickets; same quality
  testing      — generate testing.md; same quality
  execute      — agentic code execution; needs native tool use

Each role maps to a {provider, model} pair from config, with fallbacks.
The registry is a singleton per application instance.
"""
from __future__ import annotations

import os
from typing import TYPE_CHECKING, Optional

from qorum.providers.base import Capabilities, LLMProvider
from qorum.providers.errors import ProviderNotConfigured

if TYPE_CHECKING:
    from qorum.config import QorumConfig

# All known role names
ROLES = frozenset({"summarize", "classify", "plan", "phase_split", "testing", "execute"})


def _make_provider(name: str, config: "QorumConfig") -> Optional[LLMProvider]:
    """Instantiate a provider by name, returning None if the key is missing."""
    from qorum.providers.anthropic import AnthropicProvider
    from qorum.providers.openai import OpenAIProvider
    from qorum.providers.google import GoogleProvider
    from qorum.providers.mistral import MistralProvider
    from qorum.providers.deepseek import DeepSeekProvider
    from qorum.providers.groq import GroqProvider
    from qorum.providers.moonshot import MoonshotProvider
    from qorum.providers.openrouter import OpenRouterProvider

    provider_map = {
        "anthropic":  (AnthropicProvider,  config.qorum_provider_anthropic_api_key,  None),
        "openai":     (OpenAIProvider,      config.qorum_provider_openai_api_key,     None),
        "google":     (GoogleProvider,      config.qorum_provider_google_api_key,     None),
        "mistral":    (MistralProvider,     config.qorum_provider_mistral_api_key,    None),
        "deepseek":   (DeepSeekProvider,    config.qorum_provider_deepseek_api_key,   config.qorum_provider_deepseek_base_url),
        "groq":       (GroqProvider,        config.qorum_provider_groq_api_key,       None),
        "moonshot":   (MoonshotProvider,    config.qorum_provider_moonshot_api_key,   None),
        "openrouter": (OpenRouterProvider,  config.qorum_provider_openrouter_api_key, None),
    }

    entry = provider_map.get(name)
    if not entry:
        return None
    cls, api_key, base_url = entry
    if not api_key:
        return None
    if base_url:
        return cls(api_key, base_url=base_url)  # type: ignore[call-arg]
    return cls(api_key)


class ProviderRegistry:
    """
    Single instance per application. Built from QorumConfig.
    Maps each role to (provider_instance, model_string).
    """

    # Default role → (provider_name, model)
    # Overridden by config QORUM_ROLE_<ROLE>_PROVIDER / QORUM_ROLE_<ROLE>_MODEL
    _DEFAULTS: dict[str, tuple[str, str]] = {
        "summarize":   ("anthropic", "claude-haiku-4-5-20251001"),
        "classify":    ("anthropic", "claude-haiku-4-5-20251001"),
        "plan":        ("anthropic", "claude-sonnet-4-6"),
        "phase_split": ("anthropic", "claude-sonnet-4-6"),
        "testing":     ("anthropic", "claude-sonnet-4-6"),
        "execute":     ("anthropic", "claude-sonnet-4-6"),
    }

    def __init__(self, config: "QorumConfig") -> None:
        self._config = config
        self._providers: dict[str, LLMProvider] = {}
        self._role_map: dict[str, tuple[str, str]] = {}  # role → (provider_name, model)
        self._build()

    def _build(self) -> None:
        cfg = self._config
        for role in ROLES:
            # Config overrides via QORUM_ROLE_<ROLE>_PROVIDER / QORUM_ROLE_<ROLE>_MODEL
            provider_name = (
                getattr(cfg, f"qorum_role_{role}_provider", None)
                or self._DEFAULTS.get(role, ("anthropic", "claude-sonnet-4-6"))[0]
            )
            model = (
                getattr(cfg, f"qorum_role_{role}_model", None)
                or self._DEFAULTS.get(role, ("anthropic", "claude-sonnet-4-6"))[1]
            )
            self._role_map[role] = (provider_name, model)

    def provider_for(self, role: str) -> tuple[LLMProvider, str]:
        """Return (provider, model) for a role. Raises ProviderNotConfigured if unavailable."""
        if role not in ROLES:
            raise ValueError(f"Unknown role: {role!r}. Valid: {sorted(ROLES)}")

        provider_name, model = self._role_map.get(role, ("anthropic", "claude-sonnet-4-6"))

        # Try requested provider; fall back to any configured provider
        provider = self._get_or_build(provider_name)
        if provider is None or not provider.is_configured():
            provider, provider_name = self._find_any_configured()

        if provider is None:
            raise ProviderNotConfigured(
                "all",
                "QORUM_PROVIDER_ANTHROPIC_API_KEY (or any other provider key)",
            )

        return provider, model

    def capabilities_for(self, role: str) -> Capabilities:
        provider, model = self.provider_for(role)
        return provider.capabilities(model)

    def _get_or_build(self, name: str) -> Optional[LLMProvider]:
        if name not in self._providers:
            p = _make_provider(name, self._config)
            if p:
                self._providers[name] = p
        return self._providers.get(name)

    def _find_any_configured(self) -> tuple[Optional[LLMProvider], str]:
        """Return the first provider that is configured."""
        for name in ("anthropic", "openai", "google", "mistral", "groq", "deepseek", "moonshot", "openrouter"):
            p = self._get_or_build(name)
            if p and p.is_configured():
                return p, name
        return None, ""

    def configured_providers(self) -> list[str]:
        """Return names of all providers that have an API key set."""
        result = []
        for name in ("anthropic", "openai", "google", "mistral", "groq", "deepseek", "moonshot", "openrouter"):
            p = self._get_or_build(name)
            if p and p.is_configured():
                result.append(name)
        return result
