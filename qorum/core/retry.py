"""
Async retry utility with exponential backoff.
Used by all platform adapters for rate limits and transient errors.
"""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TypeVar

from qorum.adapters.base import RateLimitError
from qorum.core.logger import get_logger

log = get_logger(__name__)

T = TypeVar("T")


async def with_retry(
    fn: Callable[[], Awaitable[T]],
    max_attempts: int = 3,
    base_delay: float = 2.0,
    label: str = "request",
) -> T:
    """
    Retry an async callable with exponential backoff.

    - On RateLimitError: respects retry_after from the error
    - On other exceptions: exponential backoff (base_delay * 2^attempt)
    - Raises the last exception after max_attempts exhausted
    """
    last_exc: Exception | None = None

    for attempt in range(1, max_attempts + 1):
        try:
            return await fn()
        except RateLimitError as exc:
            last_exc = exc
            wait = exc.retry_after
            log.warning(
                "qorum.retry.rate_limit",
                label=label,
                attempt=attempt,
                max_attempts=max_attempts,
                wait_seconds=wait,
            )
            if attempt < max_attempts:
                await asyncio.sleep(wait)
        except Exception as exc:
            last_exc = exc
            wait = base_delay * (2 ** (attempt - 1))
            log.warning(
                "qorum.retry.error",
                label=label,
                attempt=attempt,
                max_attempts=max_attempts,
                wait_seconds=wait,
                error=str(exc),
            )
            if attempt < max_attempts:
                await asyncio.sleep(wait)

    raise last_exc  # type: ignore[misc]
