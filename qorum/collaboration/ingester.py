"""
Phase 5 — Boundary engine.

resolve_window() applies three strategies (priority order) to determine which
slice of conversation a trigger message refers to:

  1. THREAD-SCOPED   — trigger is inside a reply thread → all messages in that thread.
  2. FROM HERE       — trigger text contains "from here" and is a reply → messages from
                       the anchor to the trigger.
  3. DEFAULT LOOK-BACK — recent N messages / X minutes before the trigger.

The confirm card (rendered by the adapter using Phase 4 buttons) lets the human
trim or expand the window before planning starts.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Optional

from qorum.bot.events import ChatContext, ChatMessage
from qorum.collaboration.schemas import CaptureWindow
from qorum.core.logger import get_logger

if TYPE_CHECKING:
    from qorum.bot.base_adapter import BaseQorumAdapter
    from qorum.config import QorumConfig

log = get_logger(__name__)

# Phrases that activate the "from here" strategy.
_FROM_HERE_RE = re.compile(
    r"\b(from here|starting here|from this message|since here)\b",
    re.IGNORECASE,
)

# Default look-back values (overridable in config).
_DEFAULT_COUNT = 30
_DEFAULT_MINUTES = 120


class BoundaryEngine:
    """
    Resolves a CaptureWindow from a ChatContext + adapter.
    Stateless — create once and call resolve_window() per trigger.
    """

    def __init__(self, config: Optional["QorumConfig"] = None) -> None:
        self._default_count = (
            getattr(config, "qorum_capture_default_count", None) or _DEFAULT_COUNT
        )
        self._default_minutes = (
            getattr(config, "qorum_capture_default_minutes", None) or _DEFAULT_MINUTES
        )

    async def resolve_window(
        self,
        ctx: ChatContext,
        adapter: "BaseQorumAdapter",
    ) -> CaptureWindow:
        """
        Choose a boundary strategy and fetch the corresponding messages.

        Returns a CaptureWindow ready for confirm-card display.
        """
        trigger = ctx.trigger_message

        # ── Strategy 1: Thread-scoped ─────────────────────────────────────────
        if ctx.thread_id:
            log.info("boundary.thread_scoped", channel=ctx.channel_id, thread=ctx.thread_id)
            messages = await adapter.get_thread(ctx.channel_id, ctx.thread_id)
            return _make_window(messages, "thread", ctx.channel_id, ctx.thread_id)

        # ── Strategy 2: "from here" anchor ────────────────────────────────────
        text = trigger.text or ""
        if _FROM_HERE_RE.search(text) and trigger.reply_to_id:
            log.info("boundary.from_here", anchor_id=trigger.reply_to_id)
            all_msgs = await adapter.fetch_history(
                ctx.channel_id,
                anchor_message_id=None,
                limit=500,          # fetch a generous window then slice
            )
            window = _slice_from_anchor(all_msgs, trigger.reply_to_id, trigger.id)
            if window:
                return _make_window(window, "from_here", ctx.channel_id)
            # Fall through if anchor not found in buffer

        # ── Strategy 3: Default look-back ─────────────────────────────────────
        log.info(
            "boundary.lookback",
            count=self._default_count,
            minutes=self._default_minutes,
        )
        messages = await adapter.fetch_history(
            ctx.channel_id,
            anchor_message_id=trigger.id,
            limit=self._default_count,
        )

        # Apply the time-based cap: drop messages older than default_minutes
        cutoff = trigger.ts - timedelta(minutes=self._default_minutes)
        messages = [m for m in messages if m.ts >= cutoff]

        return await _make_lookback_window(
            messages,
            ctx.channel_id,
            adapter,
            self._default_count,
        )

    # ── Adjust helpers (used by the confirm-card button handler) ──────────────

    async def expand_window(
        self,
        current: CaptureWindow,
        adapter: "BaseQorumAdapter",
        steps: int = 10,
    ) -> CaptureWindow:
        """Fetch `steps` more messages before the current window start."""
        older = await adapter.fetch_history(
            current.channel_id,
            anchor_message_id=_first_id(current.messages),
            limit=steps,
        )
        if not older:
            return current   # already at the buffer boundary

        combined = older + current.messages
        window = _make_window(combined, current.strategy, current.channel_id, current.thread_id)
        window.capture_id = current.capture_id   # keep the same id for the edit_message flow
        window.buffer_limited = current.buffer_limited
        window.buffer_oldest_ts = current.buffer_oldest_ts
        return window

    async def trim_window(
        self,
        current: CaptureWindow,
        steps: int = 10,
    ) -> CaptureWindow:
        """Drop the `steps` oldest messages from the current window."""
        trimmed = current.messages[steps:] if len(current.messages) > steps else current.messages[-1:]
        window = _make_window(trimmed, current.strategy, current.channel_id, current.thread_id)
        window.capture_id = current.capture_id
        return window


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_window(
    messages: list[ChatMessage],
    strategy: str,
    channel_id: str,
    thread_id: Optional[str] = None,
    buffer_limited: bool = False,
    buffer_oldest_ts: Optional[datetime] = None,
) -> CaptureWindow:
    """Construct a CaptureWindow from a list of messages."""
    if not messages:
        now = datetime.now(timezone.utc)
        return CaptureWindow(
            messages=[],
            start_ts=now,
            end_ts=now,
            strategy=strategy,      # type: ignore[arg-type]
            channel_id=channel_id,
            thread_id=thread_id,
        )

    start = min(m.ts for m in messages)
    end   = max(m.ts for m in messages)

    return CaptureWindow(
        messages=messages,
        start_ts=start,
        end_ts=end,
        strategy=strategy,          # type: ignore[arg-type]
        channel_id=channel_id,
        thread_id=thread_id,
        buffer_limited=buffer_limited,
        buffer_oldest_ts=buffer_oldest_ts,
    )


async def _make_lookback_window(
    messages: list[ChatMessage],
    channel_id: str,
    adapter: "BaseQorumAdapter",
    limit: int,
) -> CaptureWindow:
    """
    Build the look-back window and check if the adapter buffer was the limiting factor.
    Uses adapter.buffer_oldest_ts() — Telegram overrides this; others return None.
    """
    buffer_limited = False
    buffer_oldest_ts = None

    # If we got fewer messages than requested, the buffer may be limiting us.
    if len(messages) < limit:
        oldest = await adapter.buffer_oldest_ts(channel_id)
        if oldest and messages:
            buffer_oldest_ts = oldest
            buffer_limited = True

    return _make_window(
        messages,
        "lookback",
        channel_id,
        buffer_limited=buffer_limited,
        buffer_oldest_ts=buffer_oldest_ts,
    )


def _slice_from_anchor(
    messages: list[ChatMessage],
    anchor_id: str,
    trigger_id: str,
) -> list[ChatMessage]:
    """Return messages from anchor_id to trigger_id (inclusive, chronological)."""
    ids = [m.id for m in messages]
    try:
        start = ids.index(anchor_id)
    except ValueError:
        return []
    try:
        end = ids.index(trigger_id) + 1
    except ValueError:
        end = len(ids)
    return messages[start:end]


def _first_id(messages: list[ChatMessage]) -> Optional[str]:
    return messages[0].id if messages else None
