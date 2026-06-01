"""
Qorum WhatsApp Adapter — Phase 13.

Uses Meta WhatsApp Cloud API (REST + webhook).
FastAPI webhook route on Phase 10 server handles inbound messages.

Degraded UX (documented):
  - ≤3 buttons: interactive reply_button message
  - >3 buttons: list message
  - Fallback / outside 24h window: numbered text reply
  - No threads → default look-back + confirm

Required env vars:
  QORUM_WHATSAPP_TOKEN       — Cloud API Bearer token (System User token)
  QORUM_WHATSAPP_PHONE_ID    — WhatsApp Business phone number ID
  QORUM_WHATSAPP_VERIFY_TOKEN — Webhook verify token (arbitrary string)
  QORUM_WHATSAPP_APP_SECRET   — App secret for webhook signature verification

24-hour window:
  Outside it, only pre-approved template messages can be sent.
  The adapter tracks the last message timestamp per phone number.
"""
from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING, Any, Callable, Optional

from qorum.bot.base_adapter import BaseQorumAdapter, BotContext
from qorum.bot.buttons import Button
from qorum.bot.cards.whatsapp_interactive import (
    build_approval_message,
    interactive_reply_to_click,
    is_within_service_window,
    numbered_reply_text,
    parse_numbered_reply,
)
from qorum.bot.events import ButtonClick, ChatContext, ChatMessage, ChatUser
from qorum.bot.message_store import MessageStore
from qorum.core.logger import get_logger

if TYPE_CHECKING:
    from qorum.config import QorumConfig
    from qorum.core.orchestrator import QorumOrchestrator

log = get_logger(__name__)
_PLATFORM = "whatsapp"
_API_BASE = "https://graph.facebook.com/v19.0"

# Trigger keywords — no @mention in WhatsApp
_TRIGGER_KEYWORDS = {"qorum plan", "qorum help", "qorum status", "/qorum", "/atlas"}


class WhatsAppAdapter(BaseQorumAdapter):
    """
    WhatsApp Business Cloud API adapter.
    Inbound messages arrive via a FastAPI webhook (POST /webhooks/whatsapp).
    """

    def __init__(
        self,
        config: "QorumConfig",
        orchestrator: "QorumOrchestrator",
        store: Optional[MessageStore] = None,
    ) -> None:
        super().__init__(config, orchestrator)

        self._token = getattr(config, "qorum_whatsapp_token", "") or ""
        self._phone_id = getattr(config, "qorum_whatsapp_phone_id", "") or ""
        self._store = store or MessageStore()

        # phone_number → last message timestamp (for 24h window)
        self._last_user_msg: dict[str, float] = {}
        # phone_number → list of pending buttons (for numbered-reply fallback)
        self._pending_buttons: dict[str, list[Button]] = {}

        # Phase 4 handlers
        self._mention_handlers: list[Callable] = []
        self._button_handlers: list[Callable] = []

        self._session = None

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self) -> None:
        import aiohttp
        self._session = aiohttp.ClientSession(
            headers={"Authorization": f"Bearer {self._token}"}
        )
        await self._store.init()
        await self.on_mention(self.handle_mention)
        log.info("whatsapp.started", phone_id=self._phone_id)
        self._stopped = asyncio.Event()
        await self._stopped.wait()

    async def stop(self) -> None:
        if self._session:
            await self._session.close()
        if hasattr(self, "_stopped"):
            self._stopped.set()
        log.info("whatsapp.stopped")

    # ── Webhook handler (called by server route) ──────────────────────────────

    async def process_webhook(self, payload: dict) -> None:
        """Entry point from POST /webhooks/whatsapp."""
        for entry in payload.get("entry", []):
            for change in entry.get("changes", []):
                value = change.get("value", {})
                messages = value.get("messages", [])
                for msg in messages:
                    await self._dispatch_message(msg)

    async def _dispatch_message(self, msg: dict) -> None:
        from_phone = msg.get("from", "")
        self._last_user_msg[from_phone] = time.time()
        msg_type = msg.get("type", "")
        channel_id = from_phone

        # Buffer
        chat_msg = _wa_msg_to_chat_message(msg)
        if chat_msg:
            await self._store.store(chat_msg)

        # Button/interactive reply
        if msg_type == "interactive":
            click_dict = interactive_reply_to_click(msg, from_phone)
            if click_dict:
                user = ChatUser.from_platform(_PLATFORM, from_phone, None)
                click = ButtonClick(
                    platform=_PLATFORM,
                    channel_id=channel_id,
                    message_id=msg.get("id", ""),
                    user=user,
                    action=click_dict["action"],
                    payload=click_dict["payload"],
                    raw=msg,
                )
                for handler in self._button_handlers:
                    asyncio.create_task(handler(click))
                asyncio.create_task(self.dispatch_button(click))
                return

        # Numbered reply fallback
        text = msg.get("text", {}).get("body", "").strip() if msg_type == "text" else ""
        pending_buttons = self._pending_buttons.get(from_phone)
        if pending_buttons and text.isdigit():
            result = parse_numbered_reply(text, pending_buttons)
            if result:
                user = ChatUser.from_platform(_PLATFORM, from_phone, None)
                click = ButtonClick(
                    platform=_PLATFORM,
                    channel_id=channel_id,
                    message_id=msg.get("id", ""),
                    user=user,
                    action=result["action"],
                    payload=result["payload"],
                    raw=msg,
                )
                self._pending_buttons.pop(from_phone, None)
                for handler in self._button_handlers:
                    asyncio.create_task(handler(click))
                asyncio.create_task(self.dispatch_button(click))
                return

        # Keyword trigger (no @mention in WhatsApp)
        if text and any(text.lower().startswith(kw) for kw in _TRIGGER_KEYWORDS):
            chat_ctx = _wa_msg_to_chat_ctx(msg, from_phone)
            if chat_ctx:
                for handler in self._mention_handlers:
                    asyncio.create_task(handler(chat_ctx))
                bot_ctx = BotContext(_PLATFORM, channel_id, from_phone, None, msg)
                asyncio.create_task(self.handle_command(bot_ctx, text))

    # ── Phase 4: history / thread ─────────────────────────────────────────────

    async def fetch_history(
        self,
        channel_id: str,
        *,
        thread_id=None,
        anchor_message_id=None,
        limit: int = 200,
    ) -> list[ChatMessage]:
        """WhatsApp has no history API — return from rolling buffer."""
        return await self._store.fetch_window(_PLATFORM, channel_id, limit=limit)

    async def get_thread(self, channel_id: str, thread_id: str) -> list[ChatMessage]:
        return await self._store.fetch_window(_PLATFORM, channel_id, limit=500, thread_id=thread_id)

    async def buffer_oldest_ts(self, channel_id: str):
        return await self._store.oldest_ts(_PLATFORM, channel_id)

    # ── Phase 4: send_buttons ─────────────────────────────────────────────────

    async def send_buttons(
        self,
        channel_id: str,
        text: str,
        buttons: list[Button],
        thread_id: Optional[str] = None,
    ) -> str:
        last_ts = self._last_user_msg.get(channel_id, 0)
        payload = build_approval_message(text, buttons, last_ts)

        # Store buttons for numbered-reply fallback
        if payload.get("_numbered_fallback") or payload.get("_fallback"):
            self._pending_buttons[channel_id] = buttons

        msg_id = await self._send_message(channel_id, payload)
        return msg_id

    async def send_message(self, channel_id: str, text: str, **kwargs: Any) -> Any:
        payload = {"type": "text", "text": {"body": text[:4096]}}
        return await self._send_message(channel_id, payload)

    async def edit_message(
        self, channel_id: str, message_id: str, text: str, buttons=None
    ) -> None:
        # WhatsApp doesn't support message editing; send a new message instead
        if buttons:
            await self.send_buttons(channel_id, text, buttons)
        else:
            await self.send_message(channel_id, text)

    # ── Phase 4: on_mention / on_button ──────────────────────────────────────

    async def on_mention(self, handler: Callable) -> None:
        self._mention_handlers.append(handler)

    async def on_button(self, handler: Callable) -> None:
        self._button_handlers.append(handler)

    # ── Legacy methods ────────────────────────────────────────────────────────

    async def send_approval_buttons(self, channel_id, ticket_id, plan_paths, inline_summary) -> Any:
        from qorum.bot.buttons import approval_buttons
        return await self.send_buttons(channel_id, inline_summary, approval_buttons(ticket_id))

    async def send_testing_ready(self, channel_id, ticket_id, testing_paths) -> Any:
        paths = "\n".join(f"• {p}" for p in testing_paths)
        return await self.send_message(channel_id, f"Plan approved! Testing guide for `{ticket_id}`.\n{paths}")

    async def send_done(self, channel_id, ticket_id, walkthrough_path) -> Any:
        return await self.send_message(channel_id, f"✅ Ticket `{ticket_id}` complete! Walkthrough: {walkthrough_path}")

    async def send_feedback_buttons(self, channel_id, ticket_id, artifact_type) -> Any:
        from qorum.bot.buttons import feedback_buttons
        return await self.send_buttons(channel_id, f"How was this {artifact_type}?", feedback_buttons(ticket_id, artifact_type))

    async def prompt_for_feedback(self, channel_id, ticket_id) -> Any:
        return await self.send_message(channel_id, f"Reply with your feedback for `{ticket_id}` and I'll regenerate the plan.")

    # ── Internal HTTP ─────────────────────────────────────────────────────────

    async def _send_message(self, to_phone: str, message_payload: dict) -> str:
        if not self._session:
            import aiohttp
            self._session = aiohttp.ClientSession(
                headers={"Authorization": f"Bearer {self._token}"}
            )
        url = f"{_API_BASE}/{self._phone_id}/messages"
        body = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to_phone,
            **{k: v for k, v in message_payload.items() if not k.startswith("_")},
        }
        try:
            async with self._session.post(url, json=body) as resp:
                data = await resp.json()
                messages = data.get("messages", [])
                return messages[0].get("id", "") if messages else ""
        except Exception as exc:
            log.warning("whatsapp.send_failed", to=to_phone, error=str(exc))
            return ""


# ── Helpers ───────────────────────────────────────────────────────────────────

def _wa_msg_to_chat_message(msg: dict) -> Optional[ChatMessage]:
    from datetime import datetime, timezone
    from_phone = msg.get("from", "")
    text = msg.get("text", {}).get("body", "") if msg.get("type") == "text" else ""
    if not text:
        return None
    author = ChatUser.from_platform(_PLATFORM, from_phone, None)
    ts_raw = msg.get("timestamp", "")
    try:
        ts = datetime.fromtimestamp(int(ts_raw), tz=timezone.utc)
    except (ValueError, TypeError):
        ts = datetime.now(timezone.utc)
    return ChatMessage(
        id=msg.get("id", ""),
        author=author,
        text=text,
        ts=ts,
        platform=_PLATFORM,
        channel_id=from_phone,
    )


def _wa_msg_to_chat_ctx(msg: dict, from_phone: str) -> Optional[ChatContext]:
    chat_msg = _wa_msg_to_chat_msg_strict(msg, from_phone)
    if not chat_msg:
        return None
    bot = ChatUser.from_platform(_PLATFORM, "bot", "Qorum")
    return ChatContext(
        platform=_PLATFORM,
        workspace_id=None,
        channel_id=from_phone,
        thread_id=None,
        trigger_message=chat_msg,
        me=bot,
    )


def _wa_msg_to_chat_msg_strict(msg: dict, from_phone: str) -> Optional[ChatMessage]:
    return _wa_msg_to_chat_message({**msg, "from": from_phone})
