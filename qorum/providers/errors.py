"""
Provider-neutral exception hierarchy.
Every provider adapter maps its SDK exceptions to these, so calling
code only needs to handle one set of errors.
"""
from __future__ import annotations


class ProviderError(Exception):
    """Base class for all LLM provider errors."""
    def __init__(self, message: str, provider: str = "", model: str = "") -> None:
        super().__init__(message)
        self.provider = provider
        self.model = model


class ProviderAuthError(ProviderError):
    """Invalid or missing API key. Not retryable."""


class ProviderRateLimit(ProviderError):
    """Rate limit hit. Retryable after retry_after seconds."""
    def __init__(self, message: str, retry_after: float = 10.0,
                 provider: str = "", model: str = "") -> None:
        super().__init__(message, provider=provider, model=model)
        self.retry_after = retry_after


class ProviderBadRequest(ProviderError):
    """Malformed request (bad parameters, context too long). Not retryable."""


class ProviderServerError(ProviderError):
    """Provider 5xx error. Retryable."""


class ProviderNotConfigured(ProviderError):
    """No API key set for this provider. Surface to the user with env-var hint."""
    def __init__(self, provider: str, env_var: str) -> None:
        super().__init__(
            f"Provider '{provider}' is not configured. "
            f"Set {env_var} in your .env file.",
            provider=provider,
        )
        self.env_var = env_var
