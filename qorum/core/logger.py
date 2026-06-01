"""
Structured JSON logging for Qorum using structlog.
Import `get_logger` anywhere in the codebase.

Usage:
    from qorum.core.logger import get_logger
    log = get_logger(__name__)
    log.info("plan_generated", ticket_id="PROJ-123", platform="jira_cloud", confidence=87)
"""
from __future__ import annotations

import logging
import sys

import structlog


def configure_logging(log_level: str = "INFO") -> None:
    """
    Configure structlog for JSON output.
    Call once at application startup (in main.py).
    """
    level = getattr(logging, log_level.upper(), logging.INFO)

    # Configure stdlib logging (used by third-party libs)
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=level,
    )

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.stdlib.add_log_level,
            structlog.stdlib.add_logger_name,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.UnicodeDecoder(),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    """Return a bound structlog logger for the given module name."""
    return structlog.get_logger(name)
