"""
Phase 5 — Noise stripping for captured chat messages.

Drops: reactions, joins/leaves, bot messages, empty/file-only posts, pure emoji.
Collapses quoted replies into a note so the summarizer isn't confused by repetition.
Preserves author + timestamp for attribution context.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Optional

from qorum.bot.events import ChatMessage


# ── Noise detection ───────────────────────────────────────────────────────────

# Set of Unicode Emoji characters we treat as "pure emoji" if that's all the message is.
_EMOJI_RE = re.compile(
    "[\U00002600-\U000027BF"         # misc symbols
    "\U0001F300-\U0001F64F"          # emoticons
    "\U0001F680-\U0001F6FF"          # transport + map
    "\U0001F700-\U0001F77F"
    "\U0001F780-\U0001F7FF"
    "\U0001F800-\U0001F8FF"
    "\U0001F900-\U0001F9FF"
    "\U0001FA00-\U0001FA6F"
    "\U0001FA70-\U0001FAFF"
    "\U00002702-\U000027B0]+",
    re.UNICODE,
)

# Short affirmations that add no signal to the summarizer.
_NOISE_PHRASES = frozenset({
    "ok", "okay", "k", "👍", "👎", "lgtm", "lol", "haha", "hehe",
    "sounds good", "gg", "+1", "-1", "agreed", "yep", "yup", "nope",
    "sure", "np", "thx", "thanks", "ty", "no worries", "noted",
})

# Configurable set of message kinds to always drop.
_NOISE_KINDS = frozenset({"reaction", "join", "leave"})


def _is_pure_emoji(text: str) -> bool:
    stripped = _EMOJI_RE.sub("", text).strip()
    return stripped == ""


def _is_noise_phrase(text: str) -> bool:
    return text.strip().lower() in _NOISE_PHRASES


def is_noise(msg: ChatMessage, deny_kinds: Optional[frozenset] = None) -> bool:
    """
    Return True for messages that should be stripped before summarisation.
    deny_kinds: additional message kinds to reject (e.g. {"file"}).
    """
    kinds = deny_kinds or frozenset()

    if msg.kind in (_NOISE_KINDS | kinds):
        return True
    if msg.is_bot:
        return True
    if not msg.text or not msg.text.strip():
        return True
    if _is_pure_emoji(msg.text):
        return True
    if _is_noise_phrase(msg.text):
        return True

    return False


# ── Quote collapse ────────────────────────────────────────────────────────────

# Telegram/Slack often repeat quoted text as "> original\n reply"
_QUOTE_RE = re.compile(r"^>.*$", re.MULTILINE)


def _collapse_quotes(text: str) -> str:
    """Replace block-quoted content with a placeholder, keeping the reply."""
    # Collapse multiple quoted lines into one marker
    collapsed = _QUOTE_RE.sub("[quoted]", text)
    # Deduplicate adjacent [quoted] lines
    collapsed = re.sub(r"(\[quoted\]\n?)+", "[quoted] ", collapsed)
    return collapsed.strip()


# ── Public API ────────────────────────────────────────────────────────────────

def strip_noise(
    messages: list[ChatMessage],
    deny_kinds: Optional[frozenset] = None,
) -> list[ChatMessage]:
    """
    Return a new list with noise removed and quotes collapsed.
    Preserves all attribution (author, ts) for the remaining messages.
    """
    cleaned: list[ChatMessage] = []
    for msg in messages:
        if is_noise(msg, deny_kinds):
            continue

        # Collapse quoted content so the summarizer doesn't see repeated text
        if ">" in msg.text:
            from dataclasses import replace
            msg = replace(msg, text=_collapse_quotes(msg.text))

        cleaned.append(msg)

    return cleaned


def format_for_llm(messages: list[ChatMessage]) -> str:
    """
    Render cleaned messages as a simple transcript string for the summarizer prompt.
    Format: [HH:MM] @author: text
    """
    lines = []
    for msg in messages:
        ts = msg.ts.strftime("%H:%M")
        author = msg.author.display_name or msg.author.id
        lines.append(f"[{ts}] @{author}: {msg.text}")
    return "\n".join(lines)
