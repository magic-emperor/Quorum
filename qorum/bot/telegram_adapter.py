"""
Qorum Telegram Adapter — python-telegram-bot v20+ async implementation.

Implements the Phase 4 event model:
  - Rolling message buffer (SQLite) because Telegram bots cannot read chat history.
  - on_mention: fires ChatContext on @mention or /qorum command.
  - on_button: fires ButtonClick on InlineKeyboard taps.
  - send_buttons: renders Button[] as InlineKeyboardMarkup.
  - fetch_history / get_thread: reads from the rolling buffer.
  - edit_message: edits an existing message (e.g. progress updates).

Limitation (surfaced to Phase 5 boundary engine):
  The buffer starts empty when the bot joins a chat; history before joining is
  unavailable. fetch_history returns what has been seen since the bot was active.

Required env var:  TELEGRAM_BOT_TOKEN — from @BotFather
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Callable, Optional

from telegram import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    Update,
)
from telegram.constants import ParseMode
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from qorum.bot.actions import BotAction
from qorum.bot.base_adapter import BaseQorumAdapter, BotContext, ButtonAction
from qorum.bot.buttons import Button
from qorum.bot.events import ButtonClick, ChatContext, ChatMessage, ChatUser
from qorum.bot.message_store import MessageStore
from qorum.core.logger import get_logger

if TYPE_CHECKING:
    from qorum.config import QorumConfig
    from qorum.core.orchestrator import QorumOrchestrator

log = get_logger(__name__)

_PLATFORM = "telegram"

# Callback data: JSON-encoded {"action": "...", "ticket_id": "...", ...}
_CB_MAX = 64   # Telegram callback_data limit is 64 bytes — keep payloads small


def _encode_cb(action: str, payload: dict) -> str:
    data = json.dumps({"a": action, **{k[:3]: v for k, v in payload.items()}})
    return data[:_CB_MAX]


def _decode_cb(data: str) -> tuple[str, dict]:
    try:
        d = json.loads(data)
        action = d.pop("a", "")
        # Expand short keys back
        expanded = {}
        for k, v in d.items():
            if k == "tic":
                expanded["ticket_id"] = v
            elif k == "art":
                expanded["artifact"] = v
            else:
                expanded[k] = v
        return action, expanded
    except Exception:
        return "", {}


class TelegramAdapter(BaseQorumAdapter):
    """
    Telegram bot using python-telegram-bot v20 with Phase 4 event model.
    """

    def __init__(
        self,
        config: "QorumConfig",
        orchestrator: "QorumOrchestrator",
        store: Optional[MessageStore] = None,
    ) -> None:
        super().__init__(config, orchestrator)

        if not config.telegram_bot_token:
            raise ValueError("TELEGRAM_BOT_TOKEN is not set.")

        self._app = Application.builder().token(config.telegram_bot_token).build()
        self._store = store or MessageStore()

        # Phase 4 handlers registered by on_mention / on_button
        self._mention_handlers: list[Callable] = []
        self._button_handlers: list[Callable] = []

        self._register_handlers()

    # ── Bot lifecycle ─────────────────────────────────────────────────────────

    async def start(self) -> None:
        log.info("telegram.starting")
        self._stop_event = asyncio.Event()
        await self._store.init()
        await self._app.initialize()
        await self._app.start()
        await self.on_mention(self.handle_mention)
        await self._app.updater.start_polling()
        # Block here until stop() sets the event
        await self._stop_event.wait()

    async def stop(self) -> None:
        await self._app.updater.stop()
        await self._app.stop()
        await self._app.shutdown()
        if hasattr(self, "_stop_event"):
            self._stop_event.set()
        log.info("telegram.stopped")

    # ── Phase 4: history / thread ─────────────────────────────────────────────

    async def fetch_history(
        self,
        channel_id: str,
        *,
        thread_id: Optional[str] = None,
        anchor_message_id: Optional[str] = None,
        limit: int = 200,
    ) -> list[ChatMessage]:
        """
        Return messages from the rolling buffer.
        NOTE: Only messages seen while the bot was running are available.
        The bot has no API access to historical messages.
        """
        return await self._store.fetch_window(
            _PLATFORM,
            channel_id,
            limit=limit,
            before_id=anchor_message_id,
            thread_id=thread_id,
        )

    async def get_thread(self, channel_id: str, thread_id: str) -> list[ChatMessage]:
        """Return all messages in a reply thread from the buffer."""
        return await self._store.fetch_window(
            _PLATFORM, channel_id, limit=500, thread_id=thread_id
        )

    async def buffer_oldest_ts(self, channel_id: str) -> Optional[datetime]:
        """Return the oldest buffered timestamp — surfaces Telegram history limit to confirm card."""
        return await self._store.oldest_ts(_PLATFORM, channel_id)

    # ── Phase 4: send_buttons / edit_message ──────────────────────────────────

    async def send_buttons(
        self,
        channel_id: str,
        text: str,
        buttons: list[Button],
        thread_id: Optional[str] = None,
    ) -> str:
        keyboard = _buttons_to_keyboard(buttons)
        kwargs: dict[str, Any] = {
            "chat_id": channel_id,
            "text": text,
            "parse_mode": ParseMode.MARKDOWN,
            "reply_markup": keyboard,
        }
        if thread_id:
            try:
                kwargs["message_thread_id"] = int(thread_id)
            except (ValueError, TypeError):
                pass
        try:
            msg = await self._app.bot.send_message(**kwargs)
        except Exception as exc:
            if "thread" in str(exc).lower() or "message_thread_id" in str(exc).lower():
                # Private chats and non-forum groups don't support threads — retry without it
                kwargs.pop("message_thread_id", None)
                msg = await self._app.bot.send_message(**kwargs)
            else:
                raise
        return str(msg.message_id)

    async def edit_message(
        self,
        channel_id: str,
        message_id: str,
        text: str,
        buttons: Optional[list[Button]] = None,
    ) -> None:
        try:
            keyboard = _buttons_to_keyboard(buttons) if buttons else None
            await self._app.bot.edit_message_text(
                chat_id=channel_id,
                message_id=int(message_id),
                text=text,
                parse_mode=ParseMode.MARKDOWN,
                reply_markup=keyboard,
            )
        except Exception as exc:
            log.warning("telegram.edit_failed", message_id=message_id, error=str(exc))

    # ── Phase 4: on_mention / on_button ──────────────────────────────────────

    async def on_mention(self, handler: Callable) -> None:
        self._mention_handlers.append(handler)

    async def on_button(self, handler: Callable) -> None:
        self._button_handlers.append(handler)

    # ── Legacy Phase 1 send methods (kept for backward compat) ───────────────

    async def send_message(self, channel_id: str, text: str, **kwargs: Any) -> Any:
        return await self._app.bot.send_message(
            chat_id=channel_id, text=text, parse_mode=ParseMode.MARKDOWN, **kwargs
        )

    async def send_approval_buttons(
        self, channel_id: str, ticket_id: str, plan_paths: list[str], inline_summary: str
    ) -> Any:
        from qorum.bot.buttons import approval_buttons
        paths_text = "\n".join(f"• `{p}`" for p in plan_paths)
        text = f"{inline_summary}\n\n*Plan file(s):*\n{paths_text}"
        return await self.send_buttons(channel_id, text, approval_buttons(ticket_id))

    async def send_testing_ready(
        self, channel_id: str, ticket_id: str, testing_paths: list[str]
    ) -> Any:
        from qorum.bot.buttons import Button
        paths_text = "\n".join(f"• `{p}`" for p in testing_paths)
        text = (
            f"*Plan approved!* Testing guide generated for `{ticket_id}`.\n\n"
            f"*Testing file(s):*\n{paths_text}\n\nTap *Mark Done* after implementation."
        )
        buttons = [Button("🚀 Mark Done", BotAction.MARK_DONE, {"ticket_id": ticket_id}, style="success")]
        return await self.send_buttons(channel_id, text, buttons)

    async def send_done(self, channel_id: str, ticket_id: str, walkthrough_path: str) -> Any:
        return await self.send_message(
            channel_id,
            f"*Ticket `{ticket_id}` complete!* ✅\nWalkthrough: `{walkthrough_path}`",
        )

    async def send_feedback_buttons(
        self, channel_id: str, ticket_id: str, artifact_type: str
    ) -> Any:
        from qorum.bot.buttons import feedback_buttons
        return await self.send_buttons(
            channel_id,
            f"How was this {artifact_type} for `{ticket_id}`?",
            feedback_buttons(ticket_id, artifact_type),
        )

    async def prompt_for_feedback(self, channel_id: str, ticket_id: str) -> Any:
        return await self.send_message(
            channel_id,
            f"What changes would you like to the plan for `{ticket_id}`? "
            f"Reply with your feedback and I'll regenerate.",
        )

    # ── Handler registration ──────────────────────────────────────────────────

    def _register_handlers(self) -> None:
        app = self._app
        bot_self = self

        async def _buffer_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
            """Store every visible message in the rolling buffer."""
            if update.message:
                msg = _update_to_chat_message(update.message)
                if msg:
                    await bot_self._store.store(msg)

        async def _handle_edited(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
            if update.edited_message:
                msg = update.edited_message
                await bot_self._store.update_text(
                    _PLATFORM, str(msg.chat_id), str(msg.message_id), msg.text or ""
                )

        async def _handle_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
            """Handle /qorum and /atlas commands + @mention triggers."""
            if not update.message:
                return
            await _buffer_message(update, context)

            args = context.args or []
            text = " ".join(args).strip()
            subcommand = text.split()[0].lower() if text else "plan"

            ctx = _update_to_bot_ctx(update)
            asyncio.create_task(bot_self.handle_command(ctx, f"/qorum {text}"))

            # Only fire the plan/mention flow for planning commands, not help/status/etc.
            _INFO_COMMANDS = {"help", "status", "stats", "view", "refresh", "where", "link", "map"}
            if subcommand not in _INFO_COMMANDS:
                chat_ctx = _update_to_chat_ctx(update, text)
                if chat_ctx:
                    for handler in bot_self._mention_handlers:
                        asyncio.create_task(handler(chat_ctx))

        async def _handle_mention(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
            """Handle direct @bot_username mentions in group chats."""
            if not update.message or not update.message.text:
                return
            await _buffer_message(update, context)

            bot_username = (await app.bot.get_me()).username
            text = update.message.text
            if f"@{bot_username}" not in text and "qorum plan" not in text.lower():
                return   # not a mention of us

            chat_ctx = _update_to_chat_ctx(update, text)
            if chat_ctx:
                for handler in bot_self._mention_handlers:
                    asyncio.create_task(handler(chat_ctx))

        async def _handle_all_messages(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
            """Buffer all non-command messages. Also handle text feedback replies."""
            if not update.message:
                return
            await _buffer_message(update, context)

            # Phase 1 feedback reply path
            if context.chat_data is None:
                return
            ticket_id = context.chat_data.pop("pending_feedback_ticket", None)
            pending_ctx = context.chat_data.pop("pending_feedback_ctx", None)
            if ticket_id and update.message.text:
                ctx = pending_ctx or _update_to_bot_ctx(update)
                asyncio.create_task(
                    bot_self.handle_request_changes(ctx, ticket_id, update.message.text)
                )

        async def _handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
            query = update.callback_query
            if not query:
                return
            await query.answer()   # ack immediately (Telegram 3s timeout)

            action, payload = _decode_cb(query.data or "")
            tg_user = query.from_user

            click = ButtonClick(
                platform=_PLATFORM,
                channel_id=str(query.message.chat_id) if query.message else "",
                message_id=str(query.message.message_id) if query.message else "",
                user=ChatUser.from_platform(
                    _PLATFORM,
                    str(tg_user.id) if tg_user else "unknown",
                    tg_user.username or tg_user.full_name if tg_user else None,
                ),
                action=action,
                payload=payload,
                raw=update,
            )

            # Phase 4: fire button handlers
            for handler in bot_self._button_handlers:
                asyncio.create_task(handler(click))

            # Phase 1 / dispatch_button (for actions not yet wired in Phase 4 handlers)
            asyncio.create_task(bot_self.dispatch_button(click))

        # Register all handlers
        app.add_handler(CommandHandler("qorum", _handle_command))
        app.add_handler(CommandHandler("atlas", _handle_command))   # legacy alias
        app.add_handler(CallbackQueryHandler(_handle_callback))
        app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, _handle_all_messages))
        app.add_handler(MessageHandler(filters.UpdateType.EDITED_MESSAGE, _handle_edited))


# ── Helpers ───────────────────────────────────────────────────────────────────

def _buttons_to_keyboard(buttons: list[Button]) -> InlineKeyboardMarkup:
    """Render Button[] → InlineKeyboardMarkup. Groups into rows of ≤2."""
    rows = []
    row: list[InlineKeyboardButton] = []
    for btn in buttons:
        payload = {**btn.payload}
        # Shorten payload keys to fit 64-byte limit
        cb_data = _encode_cb(btn.action, payload)
        row.append(InlineKeyboardButton(btn.label, callback_data=cb_data))
        if len(row) == 2:
            rows.append(row)
            row = []
    if row:
        rows.append(row)
    return InlineKeyboardMarkup(rows)


def _update_to_bot_ctx(update: Update) -> BotContext:
    chat = update.effective_chat
    user = update.effective_user
    return BotContext(
        platform=_PLATFORM,
        channel_id=str(chat.id) if chat else "",
        user_id=str(user.id) if user else "",
        username=user.username if user else None,
        raw=update,
    )


def _update_to_chat_message(msg: Message) -> Optional[ChatMessage]:
    """Convert a PTB Message to a ChatMessage for the buffer."""
    if not msg.text and not msg.caption:
        return None
    user = msg.from_user
    author = ChatUser.from_platform(
        _PLATFORM,
        str(user.id) if user else "unknown",
        (user.username or user.full_name) if user else None,
    )
    author.is_bot = bool(user and user.is_bot)

    reply_to = str(msg.reply_to_message.message_id) if msg.reply_to_message else None

    return ChatMessage(
        id=str(msg.message_id),
        author=author,
        text=msg.text or msg.caption or "",
        ts=msg.date.replace(tzinfo=timezone.utc) if msg.date else datetime.now(timezone.utc),
        reply_to_id=reply_to,
        thread_id=reply_to,   # Telegram thread = root of reply chain
        is_bot=bool(user and user.is_bot),
        kind="text",
        platform=_PLATFORM,
        channel_id=str(msg.chat_id),
        raw=msg,
    )


def _update_to_chat_ctx(update: Update, command_text: str = "") -> Optional[ChatContext]:
    """Build a ChatContext from an Update (for on_mention handlers)."""
    if not update.effective_user or not update.message:
        return None
    user = update.effective_user
    chat = update.effective_chat
    bot_user = ChatUser.from_platform(_PLATFORM, "bot", "Qorum")

    trigger = _update_to_chat_message(update.message)
    if not trigger:
        return None

    return ChatContext(
        platform=_PLATFORM,
        workspace_id=None,
        channel_id=str(chat.id) if chat else "",
        thread_id=trigger.reply_to_id,   # non-None if inside a reply chain
        trigger_message=trigger,
        me=bot_user,
    )
