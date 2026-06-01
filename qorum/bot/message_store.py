"""
Rolling message buffer — SQLite-backed per-channel storage for platforms that
cannot retrieve chat history via their API (primarily Telegram).

The bot stores every message it sees while running. On @mention, the ingestion
layer (Phase 5) calls fetch_window() to retrieve recent messages, using this
store as the history source.

Limitations (documented for Phase 5 to surface in the confirm card):
  - Buffer starts empty when the bot first joins a chat.
  - History before the bot joined is unavailable.
  - Buffer size is capped (configurable); oldest messages are pruned.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import aiosqlite

from qorum.bot.events import ChatMessage, ChatUser
from qorum.core.logger import get_logger

log = get_logger(__name__)

_DEFAULT_DB = Path("qorum-message-store.db")
_DEFAULT_CAP = 5_000   # messages per channel


_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS messages (
    platform    TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    message_id  TEXT NOT NULL,
    author_id   TEXT NOT NULL,
    author_name TEXT,
    text        TEXT NOT NULL,
    ts          TEXT NOT NULL,
    reply_to_id TEXT,
    thread_id   TEXT,
    is_bot      INTEGER NOT NULL DEFAULT 0,
    kind        TEXT NOT NULL DEFAULT 'text',
    raw_json    TEXT,
    PRIMARY KEY (platform, channel_id, message_id)
);
CREATE INDEX IF NOT EXISTS ix_messages_channel_ts
    ON messages (platform, channel_id, ts DESC);
"""


class MessageStore:
    """
    Async SQLite-backed rolling message buffer.
    One instance per bot; shared across all channels.
    """

    def __init__(self, db_path: Path = _DEFAULT_DB, cap: int = _DEFAULT_CAP) -> None:
        self._path = db_path
        self._cap = cap

    async def init(self) -> None:
        """Create tables. Call once at bot startup."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self._path) as conn:
            await conn.executescript(_CREATE_SQL)
            await conn.commit()

    # ── Write ─────────────────────────────────────────────────────────────────

    async def store(self, msg: ChatMessage) -> None:
        """Store one message. Silently replaces on duplicate message_id."""
        async with aiosqlite.connect(self._path) as conn:
            await conn.execute(
                """
                INSERT OR REPLACE INTO messages
                    (platform, channel_id, message_id, author_id, author_name,
                     text, ts, reply_to_id, thread_id, is_bot, kind, raw_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    msg.platform,
                    msg.channel_id,
                    msg.id,
                    msg.author.id,
                    msg.author.display_name,
                    msg.text,
                    msg.ts.isoformat(),
                    msg.reply_to_id,
                    msg.thread_id,
                    int(msg.is_bot),
                    msg.kind,
                    None,   # raw not stored (not serialisable in general)
                ),
            )
            await conn.commit()

        await self._prune(msg.platform, msg.channel_id)

    async def update_text(
        self,
        platform: str,
        channel_id: str,
        message_id: str,
        new_text: str,
    ) -> None:
        """Update a stored message's text (handles edits)."""
        async with aiosqlite.connect(self._path) as conn:
            await conn.execute(
                "UPDATE messages SET text = ? WHERE platform=? AND channel_id=? AND message_id=?",
                (new_text, platform, channel_id, message_id),
            )
            await conn.commit()

    async def delete(self, platform: str, channel_id: str, message_id: str) -> None:
        """Remove a message (handles deletes)."""
        async with aiosqlite.connect(self._path) as conn:
            await conn.execute(
                "DELETE FROM messages WHERE platform=? AND channel_id=? AND message_id=?",
                (platform, channel_id, message_id),
            )
            await conn.commit()

    # ── Read ──────────────────────────────────────────────────────────────────

    async def fetch_window(
        self,
        platform: str,
        channel_id: str,
        limit: int = 100,
        before_id: Optional[str] = None,
        thread_id: Optional[str] = None,
    ) -> list[ChatMessage]:
        """
        Return up to `limit` most recent messages, optionally filtered by thread.
        If `before_id` is given, returns messages older than that id.
        """
        async with aiosqlite.connect(self._path) as conn:
            conn.row_factory = aiosqlite.Row

            if thread_id is not None:
                # Thread: messages where thread_id matches OR reply_to_id builds the chain
                query = """
                    SELECT * FROM messages
                    WHERE platform=? AND channel_id=?
                      AND (thread_id=? OR message_id=? OR reply_to_id=?)
                    ORDER BY ts ASC
                    LIMIT ?
                """
                params = (platform, channel_id, thread_id, thread_id, thread_id, limit)
            elif before_id:
                query = """
                    SELECT * FROM messages
                    WHERE platform=? AND channel_id=?
                      AND ts < (SELECT ts FROM messages
                                WHERE platform=? AND channel_id=? AND message_id=?)
                    ORDER BY ts DESC LIMIT ?
                """
                params = (platform, channel_id, platform, channel_id, before_id, limit)
            else:
                query = """
                    SELECT * FROM messages
                    WHERE platform=? AND channel_id=?
                    ORDER BY ts DESC LIMIT ?
                """
                params = (platform, channel_id, limit)

            async with conn.execute(query, params) as cursor:
                rows = await cursor.fetchall()

        messages = [_row_to_message(dict(r)) for r in rows]
        # Return in chronological order
        if not thread_id and not before_id:
            messages.reverse()
        return messages

    async def count(self, platform: str, channel_id: str) -> int:
        """Return the number of stored messages for a channel."""
        async with aiosqlite.connect(self._path) as conn:
            async with conn.execute(
                "SELECT COUNT(*) FROM messages WHERE platform=? AND channel_id=?",
                (platform, channel_id),
            ) as cursor:
                row = await cursor.fetchone()
                return row[0] if row else 0

    async def oldest_ts(self, platform: str, channel_id: str) -> Optional[datetime]:
        """Return the timestamp of the oldest buffered message, or None."""
        async with aiosqlite.connect(self._path) as conn:
            async with conn.execute(
                "SELECT ts FROM messages WHERE platform=? AND channel_id=? ORDER BY ts ASC LIMIT 1",
                (platform, channel_id),
            ) as cursor:
                row = await cursor.fetchone()
        if row:
            return datetime.fromisoformat(row[0])
        return None

    # ── Maintenance ───────────────────────────────────────────────────────────

    async def _prune(self, platform: str, channel_id: str) -> None:
        """Remove oldest messages when the cap is exceeded."""
        async with aiosqlite.connect(self._path) as conn:
            async with conn.execute(
                "SELECT COUNT(*) FROM messages WHERE platform=? AND channel_id=?",
                (platform, channel_id),
            ) as cursor:
                (count,) = await cursor.fetchone()

            if count > self._cap:
                excess = count - self._cap
                await conn.execute(
                    """
                    DELETE FROM messages WHERE rowid IN (
                        SELECT rowid FROM messages
                        WHERE platform=? AND channel_id=?
                        ORDER BY ts ASC LIMIT ?
                    )
                    """,
                    (platform, channel_id, excess),
                )
                await conn.commit()


# ── Row deserialisation ───────────────────────────────────────────────────────

def _row_to_message(row: dict) -> ChatMessage:
    author = ChatUser(
        id=row["author_id"],
        display_name=row["author_name"],
        platform_ids={row["platform"]: row["author_id"].split(":")[-1]},
        is_bot=bool(row["is_bot"]),
    )
    return ChatMessage(
        id=row["message_id"],
        author=author,
        text=row["text"],
        ts=datetime.fromisoformat(row["ts"]),
        reply_to_id=row.get("reply_to_id"),
        thread_id=row.get("thread_id"),
        is_bot=bool(row["is_bot"]),
        kind=row.get("kind", "text"),
        platform=row["platform"],
        channel_id=row["channel_id"],
    )
