"""
Qorum Microsoft Teams Adapter — Phase 12.

Implements the Phase 4 bot event model for Teams using the Bot Framework SDK.

Architecture:
  - A FastAPI route (POST /api/messages) receives Bot Framework activities.
  - TeamsAdapter.process_activity() dispatches to the right handler.
  - Approvals come as Invoke activities (adaptiveCard/action) — ack immediately,
    process async (Teams has a 5s response window).
  - Adaptive Cards with Action.Execute replace Telegram's InlineKeyboard.
  - Reply threads (conversation.id) map directly to Phase 5 thread-scoped strategy.
  - Proactive messaging uses stored ConversationReferences.

Required env vars:
  QORUM_TEAMS_APP_ID       — Azure Bot Service App ID
  QORUM_TEAMS_APP_PASSWORD — Azure Bot Service App Password (client secret)
  QORUM_TEAMS_TENANT_ID    — (optional) restrict to one tenant

Limitation (Teams history):
  The Bot Framework SDK doesn't expose a history API directly. Thread history
  is fetched via the conversation.get_activity_members API or Graph API
  (requires additional permissions). The rolling buffer (MessageStore) is used
  as a fallback for channels without Graph access, same as Telegram.
"""
from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any, Callable, Optional

from botbuilder.core import (
    BotFrameworkAdapter,
    BotFrameworkAdapterSettings,
    TurnContext,
)
from botbuilder.schema import Activity, ActivityTypes, InvokeResponse

from qorum.bot.base_adapter import BaseQorumAdapter, BotContext, ButtonAction
from qorum.bot.buttons import Button
from qorum.bot.cards.adaptive import (
    approval_card,
    button_to_action,
    buttons_to_action_set,
    card_attachment,
    diff_review_card,
    invoke_to_button_click,
    progress_card,
    simple_message_card,
)
from qorum.bot.events import ButtonClick, ChatContext, ChatMessage, ChatUser
from qorum.bot.message_store import MessageStore
from qorum.core.logger import get_logger

if TYPE_CHECKING:
    from qorum.config import QorumConfig
    from qorum.core.orchestrator import QorumOrchestrator

log = get_logger(__name__)

_PLATFORM = "teams"


class TeamsAdapter(BaseQorumAdapter):
    """
    Microsoft Teams bot using the Bot Framework SDK.
    Receives activities via POST /api/messages (wired by the server).
    """

    def __init__(
        self,
        config: "QorumConfig",
        orchestrator: "QorumOrchestrator",
        store: Optional[MessageStore] = None,
    ) -> None:
        super().__init__(config, orchestrator)

        app_id = config.qorum_teams_app_id if hasattr(config, "qorum_teams_app_id") else ""
        app_password = config.qorum_teams_app_password if hasattr(config, "qorum_teams_app_password") else ""

        self._settings = BotFrameworkAdapterSettings(app_id, app_password)
        self._bf_adapter = BotFrameworkAdapter(self._settings)
        self._store = store or MessageStore()

        # conversation_id → ConversationReference (for proactive messaging)
        self._conversation_refs: dict[str, Any] = {}

        # Phase 4 handlers
        self._mention_handlers: list[Callable] = []
        self._button_handlers: list[Callable] = []

        # Error handler
        async def _on_error(context: TurnContext, error: Exception) -> None:
            log.error("teams.bot_error", error=str(error))
            await context.send_activity("Sorry, an error occurred.")

        self._bf_adapter.on_turn_error = _on_error

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self) -> None:
        await self._store.init()
        log.info("teams.started")
        # Teams doesn't poll — it receives activities via HTTP
        # We stay alive by not returning until stopped
        self._stopped = asyncio.Event()
        await self._stopped.wait()

    async def stop(self) -> None:
        if hasattr(self, "_stopped"):
            self._stopped.set()
        log.info("teams.stopped")

    # ── Process incoming activity (called by /api/messages route) ─────────────

    async def process_activity(self, activity: Activity, auth_header: str) -> InvokeResponse | None:
        """
        Entry point from the FastAPI /api/messages route.
        Returns an InvokeResponse for Invoke activities, None otherwise.
        """
        invoke_response: list[InvokeResponse] = []

        async def _turn_handler(turn_context: TurnContext) -> None:
            await self._dispatch(turn_context, invoke_response)

        await self._bf_adapter.process_activity(activity, auth_header, _turn_handler)
        return invoke_response[0] if invoke_response else None

    async def _dispatch(self, ctx: TurnContext, invoke_response: list) -> None:
        activity = ctx.activity
        atype = activity.type

        # Store conversation reference for proactive messaging
        ref = TurnContext.get_conversation_reference(activity)
        if ref and hasattr(ref, "conversation") and ref.conversation:
            self._conversation_refs[ref.conversation.id] = ref

        if atype == ActivityTypes.message:
            await self._handle_message(ctx)

        elif atype == ActivityTypes.invoke:
            response = await self._handle_invoke(ctx)
            invoke_response.append(response)

        elif atype in (ActivityTypes.conversation_update,):
            # Bot added to team / member joined — no action needed for now
            pass

    # ── Message handler ───────────────────────────────────────────────────────

    async def _handle_message(self, ctx: TurnContext) -> None:
        activity = ctx.activity
        msg = _activity_to_chat_message(activity)
        if msg:
            await self._store.store(msg)

        text = (activity.text or "").strip()
        bot_id = self._settings.app_id or ""

        # Check if this is a @mention of the bot
        is_mention = any(
            getattr(e, "type", "") == "mention" and
            (getattr(getattr(e, "mentioned", None), "id", "") == bot_id)
            for e in (activity.entities or [])
        )

        if is_mention or _starts_with_command(text):
            # Fire Phase 4 mention handlers
            chat_ctx = _activity_to_chat_ctx(activity)
            if chat_ctx:
                for handler in self._mention_handlers:
                    asyncio.create_task(handler(chat_ctx))

                # Legacy command path
                clean_text = _strip_mention(text, bot_id)
                bot_ctx = _activity_to_bot_ctx(activity)
                asyncio.create_task(self.handle_command(bot_ctx, clean_text))

    # ── Invoke handler (Adaptive Card Action.Execute) ─────────────────────────

    async def _handle_invoke(self, ctx: TurnContext) -> InvokeResponse:
        """Handle Invoke activities — ack within Teams' 5s window, process async."""
        activity = ctx.activity
        click_data = invoke_to_button_click(activity, platform=_PLATFORM)

        if click_data is None:
            return InvokeResponse(status=200)

        user = ChatUser.from_platform(
            _PLATFORM,
            click_data["user_id"],
            click_data["display_name"],
        )
        click = ButtonClick(
            platform=_PLATFORM,
            channel_id=click_data["channel_id"],
            message_id=click_data["message_id"],
            user=user,
            action=click_data["action"],
            payload=click_data["payload"],
            raw=activity,
        )

        # Ack immediately — Teams requires a response within 5s
        # Fire handlers as background tasks
        for handler in self._button_handlers:
            asyncio.create_task(handler(click))
        asyncio.create_task(self.dispatch_button(click))

        # Return success + optional card update (universal actions pattern)
        return InvokeResponse(
            status=200,
            body={"statusCode": 200, "type": "application/vnd.microsoft.activity.message", "value": "OK"},
        )

    # ── Phase 4: history / thread ─────────────────────────────────────────────

    async def fetch_history(
        self,
        channel_id: str,
        *,
        thread_id: Optional[str] = None,
        anchor_message_id: Optional[str] = None,
        limit: int = 200,
    ) -> list[ChatMessage]:
        """Return messages from the rolling buffer (Teams Graph history requires extra perms)."""
        return await self._store.fetch_window(
            _PLATFORM, channel_id,
            limit=limit,
            before_id=anchor_message_id,
            thread_id=thread_id,
        )

    async def get_thread(self, channel_id: str, thread_id: str) -> list[ChatMessage]:
        return await self._store.fetch_window(_PLATFORM, channel_id, limit=500, thread_id=thread_id)

    async def buffer_oldest_ts(self, channel_id: str):
        return await self._store.oldest_ts(_PLATFORM, channel_id)

    # ── Phase 4: send_buttons / edit_message ──────────────────────────────────

    async def send_buttons(
        self,
        channel_id: str,
        text: str,
        buttons: list[Button],
        thread_id: Optional[str] = None,
    ) -> str:
        """Send an Adaptive Card with Action.Execute buttons."""
        card = _text_with_buttons_card(text, buttons)
        ref = self._conversation_refs.get(channel_id)
        if not ref:
            log.warning("teams.send_buttons.no_ref", channel_id=channel_id)
            return ""

        sent_id: list[str] = []

        async def _send(ctx: TurnContext) -> None:
            reply = Activity(
                type=ActivityTypes.message,
                attachments=[card_attachment(card)],
            )
            if thread_id:
                reply.reply_to_id = thread_id
            resource = await ctx.send_activity(reply)
            if resource:
                sent_id.append(resource.id or "")

        await self._bf_adapter.continue_conversation(
            ref,
            _send,
            self._settings.app_id,
        )
        return sent_id[0] if sent_id else ""

    async def edit_message(
        self,
        channel_id: str,
        message_id: str,
        text: str,
        buttons: Optional[list[Button]] = None,
    ) -> None:
        """Update an existing Teams activity (card) in-place."""
        ref = self._conversation_refs.get(channel_id)
        if not ref:
            return

        card = _text_with_buttons_card(text, buttons or [])

        async def _update(ctx: TurnContext) -> None:
            update = Activity(
                type=ActivityTypes.message,
                id=message_id,
                attachments=[card_attachment(card)],
            )
            try:
                await ctx.update_activity(update)
            except Exception as exc:
                log.warning("teams.edit_failed", message_id=message_id, error=str(exc))

        await self._bf_adapter.continue_conversation(ref, _update, self._settings.app_id)

    async def send_message(self, channel_id: str, text: str, **kwargs: Any) -> Any:
        """Send a plain text message proactively."""
        ref = self._conversation_refs.get(channel_id)
        if not ref:
            log.warning("teams.send_message.no_ref", channel_id=channel_id)
            return None

        result: list[Any] = []

        async def _send(ctx: TurnContext) -> None:
            resource = await ctx.send_activity(Activity(type=ActivityTypes.message, text=text))
            result.append(resource)

        await self._bf_adapter.continue_conversation(ref, _send, self._settings.app_id)
        return result[0] if result else None

    # ── Phase 4: on_mention / on_button ──────────────────────────────────────

    async def on_mention(self, handler: Callable) -> None:
        self._mention_handlers.append(handler)

    async def on_button(self, handler: Callable) -> None:
        self._button_handlers.append(handler)

    # ── Legacy approval methods ────────────────────────────────────────────────

    async def send_approval_buttons(
        self, channel_id: str, ticket_id: str, plan_paths: list[str], inline_summary: str
    ) -> Any:
        from qorum.bot.buttons import approval_buttons
        return await self.send_buttons(channel_id, inline_summary, approval_buttons(ticket_id))

    async def send_testing_ready(
        self, channel_id: str, ticket_id: str, testing_paths: list[str]
    ) -> Any:
        paths_text = "\n".join(f"• `{p}`" for p in testing_paths)
        return await self.send_message(
            channel_id,
            f"Plan approved! Testing guide ready for `{ticket_id}`.\n{paths_text}",
        )

    async def send_done(self, channel_id: str, ticket_id: str, walkthrough_path: str) -> Any:
        return await self.send_message(
            channel_id, f"✅ Ticket `{ticket_id}` complete! Walkthrough: `{walkthrough_path}`"
        )

    async def send_feedback_buttons(
        self, channel_id: str, ticket_id: str, artifact_type: str
    ) -> Any:
        from qorum.bot.buttons import feedback_buttons
        return await self.send_buttons(
            channel_id, f"How was this {artifact_type} for `{ticket_id}`?",
            feedback_buttons(ticket_id, artifact_type),
        )

    async def prompt_for_feedback(self, channel_id: str, ticket_id: str) -> Any:
        return await self.send_message(
            channel_id,
            f"Please reply with your feedback for `{ticket_id}` and I'll regenerate the plan.",
        )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _text_with_buttons_card(text: str, buttons: list[Button]) -> dict:
    """Build a minimal Adaptive Card with a text block + action set."""
    from qorum.bot.cards.adaptive import _wrap_card
    body = [{"type": "TextBlock", "text": text, "wrap": True}]
    if buttons:
        body.append(buttons_to_action_set(buttons))
    return _wrap_card(body)


def _activity_to_bot_ctx(activity: Activity) -> BotContext:
    from_prop = getattr(activity, "from_property", None)
    conv = getattr(activity, "conversation", None)
    return BotContext(
        platform=_PLATFORM,
        channel_id=getattr(conv, "id", "") if conv else "",
        user_id=getattr(from_prop, "id", "") if from_prop else "",
        username=getattr(from_prop, "name", None) if from_prop else None,
        raw=activity,
    )


def _activity_to_chat_message(activity: Activity) -> Optional[ChatMessage]:
    from datetime import datetime, timezone
    text = activity.text or ""
    if not text.strip():
        return None
    from_prop = getattr(activity, "from_property", None)
    conv = getattr(activity, "conversation", None)
    author = ChatUser.from_platform(
        _PLATFORM,
        getattr(from_prop, "id", "unknown") if from_prop else "unknown",
        getattr(from_prop, "name", None) if from_prop else None,
    )
    reply_to = getattr(activity, "reply_to_id", None)
    return ChatMessage(
        id=activity.id or "",
        author=author,
        text=text,
        ts=getattr(activity, "timestamp", None) or datetime.now(timezone.utc),
        reply_to_id=reply_to,
        thread_id=reply_to,
        platform=_PLATFORM,
        channel_id=getattr(conv, "id", "") if conv else "",
        is_bot=getattr(getattr(activity, "from_property", None), "role", "") == "bot",
    )


def _activity_to_chat_ctx(activity: Activity) -> Optional[ChatContext]:
    msg = _activity_to_chat_message(activity)
    if not msg:
        return None
    conv = getattr(activity, "conversation", None)
    channel_id = getattr(conv, "id", "") if conv else ""
    bot = ChatUser.from_platform(_PLATFORM, "bot", "Qorum")
    return ChatContext(
        platform=_PLATFORM,
        workspace_id=getattr(getattr(activity, "channel_data", None), "tenant_id", None),
        channel_id=channel_id,
        thread_id=msg.reply_to_id,
        trigger_message=msg,
        me=bot,
    )


def _starts_with_command(text: str) -> bool:
    return text.strip().lower().startswith(("/qorum", "/atlas"))


def _strip_mention(text: str, bot_id: str) -> str:
    """Remove the @mention prefix from the text."""
    import re
    cleaned = re.sub(r"<at>[^<]+</at>\s*", "", text).strip()
    return cleaned or text
