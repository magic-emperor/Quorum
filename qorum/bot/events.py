"""
Platform-neutral bot event model.
All platforms (Telegram, Teams, Slack, Discord, WhatsApp) map their
native events to these types before anything else in the system sees them.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional


@dataclass
class ChatUser:
    """A platform user, with IDs from all platforms they've been seen on."""
    id: str                                    # Qorum-internal stable id (platform:user_id)
    display_name: Optional[str] = None
    platform_ids: dict[str, str] = field(default_factory=dict)  # {"telegram": "123", "slack": "U..."}
    is_bot: bool = False

    @classmethod
    def from_platform(cls, platform: str, platform_id: str,
                       display_name: Optional[str] = None) -> "ChatUser":
        return cls(
            id=f"{platform}:{platform_id}",
            display_name=display_name,
            platform_ids={platform: platform_id},
        )


@dataclass
class ChatMessage:
    """One message in a chat channel or thread."""
    id: str                                    # platform-native message id
    author: ChatUser
    text: str
    ts: datetime
    reply_to_id: Optional[str] = None          # id of the message this replies to
    thread_id: Optional[str] = None            # thread root id (= reply_to_id for Telegram)
    is_bot: bool = False
    kind: str = "text"                         # text | reaction | join | leave | file | bot
    platform: str = ""
    channel_id: str = ""
    raw: Any = None                            # original platform object (for adapters)

    def is_noise(self) -> bool:
        """Return True for messages that should be stripped before summarisation."""
        return self.kind in ("reaction", "join", "leave") or self.is_bot or not self.text.strip()


@dataclass
class ChatContext:
    """Full context for a trigger event (@mention or /qorum command)."""
    platform: str
    workspace_id: Optional[str]                # Slack workspace, Teams tenant, etc.
    channel_id: str
    thread_id: Optional[str]                   # set if the trigger is inside a thread
    trigger_message: ChatMessage
    me: ChatUser                               # the bot's own identity

    @property
    def is_in_thread(self) -> bool:
        return bool(self.thread_id)


@dataclass
class ButtonClick:
    """A button press from any platform."""
    platform: str
    channel_id: str
    message_id: str                            # the message carrying the button
    user: ChatUser
    action: str                                # from qorum.bot.actions.BotAction
    payload: dict[str, Any] = field(default_factory=dict)
    thread_id: Optional[str] = None
    raw: Any = None
