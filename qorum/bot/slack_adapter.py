"""
Qorum Slack Adapter — slack-bolt async implementation.

Ack-first pattern: HTTP 200 returned immediately, processing in background.
Approval buttons use Slack Block Kit interactive components.

Required env vars:
  SLACK_BOT_TOKEN   — Bot User OAuth Token (xoxb-...)
  SLACK_APP_TOKEN   — App-Level Token for Socket Mode (xapp-...)
"""
from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from slack_bolt.async_app import AsyncApp
from slack_bolt.adapter.socket_mode.async_handler import AsyncSocketModeHandler

from qorum.bot.actions import BotAction
from qorum.bot.base_adapter import BaseQorumAdapter, BotContext, ButtonAction
from qorum.bot.buttons import Button
from qorum.bot.cards.blockkit import (
    block_action_to_click,
    buttons_to_actions_block,
    text_with_buttons,
)
from qorum.bot.events import ButtonClick, ChatContext, ChatMessage, ChatUser
from qorum.bot.message_store import MessageStore
from qorum.core.logger import get_logger

if TYPE_CHECKING:
    from qorum.config import QorumConfig
    from qorum.core.orchestrator import QorumOrchestrator

log = get_logger(__name__)


class SlackAdapter(BaseQorumAdapter):
    """
    Slack bot adapter using slack-bolt with Socket Mode (no public HTTP endpoint needed).

    Registers:
      - /atlas slash command handler
      - Block Kit action handlers for approval buttons
      - Message event handler for feedback collection
    """

    _PLATFORM = "slack"

    def __init__(self, config: "QorumConfig", orchestrator: "QorumOrchestrator") -> None:
        super().__init__(config, orchestrator)
        self._app = AsyncApp(token=config.slack_bot_token)
        self._handler: AsyncSocketModeHandler | None = None
        self._store = MessageStore()
        # Tickets waiting for text feedback (request_changes flow)
        self._pending_feedback: dict[str, str] = {}  # channel_id → ticket_id
        # Phase 4 handlers
        self._mention_handlers: list = []
        self._button_handlers: list = []
        self._register_handlers()

    async def stop(self) -> None:
        if self._handler:
            await self._handler.close_async()
        log.info("slack.stopped")

    # ── Send methods ──────────────────────────────────────────────────────────

    async def send_message(self, channel_id: str, text: str, **kwargs: Any) -> Any:
        return await self._app.client.chat_postMessage(
            channel=channel_id,
            text=text,
            mrkdwn=True,
            **kwargs,
        )

    async def send_approval_buttons(
        self,
        channel_id: str,
        ticket_id: str,
        plan_paths: list[str],
        inline_summary: str,
    ) -> Any:
        paths_text = "\n".join(f"• `{p}`" for p in plan_paths)
        blocks = [
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": inline_summary},
            },
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": f"*Plan file(s):*\n{paths_text}"},
            },
            {"type": "divider"},
            {
                "type": "actions",
                "block_id": f"approval_{ticket_id}",
                "elements": [
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": "✅ Approve Plan"},
                        "style": "primary",
                        "action_id": ButtonAction.APPROVE,
                        "value": ticket_id,
                    },
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": "✏️ Request Changes"},
                        "action_id": ButtonAction.REQUEST_CHANGES,
                        "value": ticket_id,
                    },
                ],
            },
        ]
        return await self._app.client.chat_postMessage(
            channel=channel_id,
            text=f"Plan ready for `{ticket_id}` — please review and approve.",
            blocks=blocks,
        )

    async def send_testing_ready(
        self,
        channel_id: str,
        ticket_id: str,
        testing_paths: list[str],
    ) -> Any:
        paths_text = "\n".join(f"• `{p}`" for p in testing_paths)
        blocks = [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": (
                        f"*Plan approved!* Testing guide generated for `{ticket_id}`.\n\n"
                        f"*Testing file(s):*\n{paths_text}\n\n"
                        f"Click *Mark Done* after implementation is complete."
                    ),
                },
            },
            {"type": "divider"},
            {
                "type": "actions",
                "block_id": f"done_{ticket_id}",
                "elements": [
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": "🚀 Mark Done"},
                        "style": "primary",
                        "action_id": ButtonAction.MARK_DONE,
                        "value": ticket_id,
                    },
                ],
            },
        ]
        return await self._app.client.chat_postMessage(
            channel=channel_id,
            text=f"Testing guide ready for `{ticket_id}`.",
            blocks=blocks,
        )

    async def send_done(
        self,
        channel_id: str,
        ticket_id: str,
        walkthrough_path: str,
    ) -> Any:
        return await self.send_message(
            channel_id,
            f"*Ticket `{ticket_id}` complete!* :white_check_mark:\n"
            f"Walkthrough saved to: `{walkthrough_path}`",
        )

    async def send_feedback_buttons(
        self, channel_id: str, ticket_id: str, artifact_type: str
    ) -> Any:
        blocks = [
            {
                "type": "actions",
                "block_id": f"feedback_{artifact_type}_{ticket_id}",
                "elements": [
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": "👍 Helpful"},
                        "action_id": ButtonAction.FEEDBACK_HELPFUL,
                        "value": f"{ticket_id}:{artifact_type}",
                    },
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": "👎 Needs Work"},
                        "action_id": ButtonAction.FEEDBACK_NEEDS_WORK,
                        "value": f"{ticket_id}:{artifact_type}",
                    },
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": "✏️ Flag Issue"},
                        "action_id": ButtonAction.FEEDBACK_FLAG,
                        "value": f"{ticket_id}:{artifact_type}",
                    },
                ],
            }
        ]
        return await self._app.client.chat_postMessage(
            channel=channel_id,
            text=f"How was this {artifact_type} for `{ticket_id}`?",
            blocks=blocks,
        )

    async def prompt_for_feedback(self, channel_id: str, ticket_id: str) -> Any:
        self._pending_feedback[channel_id] = ticket_id
        return await self.send_message(
            channel_id,
            f"What changes would you like to the plan for `{ticket_id}`? "
            f"Reply in this channel and I'll regenerate.",
        )

    # ── Handler registration ──────────────────────────────────────────────────

    def _register_handlers(self) -> None:
        app = self._app
        bot_self = self

        @app.command("/atlas")
        async def handle_slash(ack, body):
            await ack()  # Ack within 3 seconds — processing continues async
            text = body.get("text", "")
            channel_id = body["channel_id"]
            user_id = body["user_id"]
            username = body.get("user_name")
            ctx = BotContext("slack", channel_id, user_id, username, body)
            asyncio.create_task(self.handle_command(ctx, f"/atlas {text}"))

        @app.action(ButtonAction.APPROVE)
        async def handle_approve(ack, body, action):
            await ack()
            ticket_id = action["value"]
            channel_id = body["channel"]["id"]
            user = body["user"]
            ctx = BotContext("slack", channel_id, user["id"], user.get("username"), body)
            asyncio.create_task(self.handle_approve(ctx, ticket_id))

        @app.action(ButtonAction.REQUEST_CHANGES)
        async def handle_request_changes(ack, body, action):
            await ack()
            ticket_id = action["value"]
            channel_id = body["channel"]["id"]
            user = body["user"]
            ctx = BotContext("slack", channel_id, user["id"], user.get("username"), body)
            asyncio.create_task(self.prompt_for_feedback(channel_id, ticket_id))
            # Feedback text comes in via next message event (see message handler below)
            self._pending_feedback[channel_id] = ticket_id
            self.__pending_ctx = {channel_id: ctx}

        @app.action(ButtonAction.MARK_DONE)
        async def handle_mark_done(ack, body, action):
            await ack()
            ticket_id = action["value"]
            channel_id = body["channel"]["id"]
            user = body["user"]
            ctx = BotContext("slack", channel_id, user["id"], user.get("username"), body)
            # Collect minimal walkthrough data — in production this would be a modal
            walkthrough_data = {
                "summary": f"Ticket {ticket_id} completed.",
                "how_to_run": [],
                "plan_vs_reality": [],
                "technical_decisions": [],
                "known_issues": [],
                "deployment_steps": [],
                "rollback_steps": [],
                "linked_prs": [],
                "signoff_checklist": [],
            }
            asyncio.create_task(
                self.handle_mark_done(ctx, ticket_id, walkthrough_data)
            )

        @app.event("message")
        async def handle_message(body, event):
            """Capture free-text replies for the request_changes feedback flow."""
            channel_id = event.get("channel", "")
            user_id = event.get("user", "")
            text = event.get("text", "")
            subtype = event.get("subtype")

            # Ignore bot messages and edits
            if subtype or not text or not user_id:
                return

            # Check if this channel is waiting for feedback
            ticket_id = self._pending_feedback.pop(channel_id, None)
            if not ticket_id:
                return

            pending_ctx = getattr(self, "_SlackAdapter__pending_ctx", {})
            ctx = pending_ctx.pop(channel_id, None)
            if ctx is None:
                ctx = BotContext("slack", channel_id, user_id, None, body)

            asyncio.create_task(
                self.handle_request_changes(ctx, ticket_id, text)
            )

        def _parse_feedback_value(value: str) -> tuple[str, str]:
            ticket_id, _, artifact_type = value.partition(":")
            return ticket_id, artifact_type

        @app.action(ButtonAction.FEEDBACK_HELPFUL)
        async def handle_feedback_helpful(ack, body, action):
            await ack()
            ticket_id, artifact_type = _parse_feedback_value(action["value"])
            channel_id = body["channel"]["id"]
            user = body["user"]
            ctx = BotContext("slack", channel_id, user["id"], user.get("username"), body)
            asyncio.create_task(
                self.handle_feedback(ctx, ticket_id, artifact_type, "helpful")
            )

        @app.action(ButtonAction.FEEDBACK_NEEDS_WORK)
        async def handle_feedback_needs_work(ack, body, action):
            await ack()
            ticket_id, artifact_type = _parse_feedback_value(action["value"])
            channel_id = body["channel"]["id"]
            user = body["user"]
            ctx = BotContext("slack", channel_id, user["id"], user.get("username"), body)
            asyncio.create_task(
                self.handle_feedback(ctx, ticket_id, artifact_type, "needs_work")
            )

        @app.action(ButtonAction.FEEDBACK_FLAG)
        async def handle_feedback_flag(ack, body, action):
            await ack()
            ticket_id, artifact_type = _parse_feedback_value(action["value"])
            channel_id = body["channel"]["id"]
            user = body["user"]
            ctx = BotContext("slack", channel_id, user["id"], user.get("username"), body)
            asyncio.create_task(
                self.handle_feedback(ctx, ticket_id, artifact_type, "needs_work",
                                     comment="Flagged via ✏️ button")
            )

        # Phase 4: @mention triggers boundary engine
        @app.event("app_mention")
        async def handle_mention(body, event):
            await self._store.init()
            channel_id = event.get("channel", "")
            user_id = event.get("user", "")
            text = event.get("text", "")
            ts = event.get("ts", "")
            thread_ts = event.get("thread_ts")

            # Buffer the message
            msg = _event_to_chat_message(event, self._PLATFORM)
            if msg:
                await self._store.store(msg)

            chat_ctx = _event_to_chat_ctx(event, self._PLATFORM, bot_self)
            if chat_ctx:
                for handler in bot_self._mention_handlers:
                    asyncio.create_task(handler(chat_ctx))

        # Phase 4: generic action handler for neutral Button[] actions
        @app.action(BotAction.BOUNDARY_PROCEED)
        async def handle_boundary_proceed(ack, body, action):
            await ack()
            click = block_action_to_click(body, action, platform=self._PLATFORM)
            _fire_click(bot_self, click)

        @app.action(BotAction.BOUNDARY_TRIM)
        async def handle_boundary_trim(ack, body, action):
            await ack()
            click = block_action_to_click(body, action, platform=self._PLATFORM)
            _fire_click(bot_self, click)

        @app.action(BotAction.BOUNDARY_EXPAND)
        async def handle_boundary_expand(ack, body, action):
            await ack()
            click = block_action_to_click(body, action, platform=self._PLATFORM)
            _fire_click(bot_self, click)

        @app.action(BotAction.BOUNDARY_CANCEL)
        async def handle_boundary_cancel(ack, body, action):
            await ack()
            click = block_action_to_click(body, action, platform=self._PLATFORM)
            _fire_click(bot_self, click)

    # ── Phase 4: event model methods ──────────────────────────────────────────

    async def start(self) -> None:
        await self._store.init()
        await self.on_mention(self.handle_mention)
        self._handler = AsyncSocketModeHandler(self._app, self._config.slack_app_token)
        log.info("slack.starting")
        await self._handler.start_async()

    async def on_mention(self, handler) -> None:
        self._mention_handlers.append(handler)

    async def on_button(self, handler) -> None:
        self._button_handlers.append(handler)

    async def fetch_history(
        self,
        channel_id: str,
        *,
        thread_id=None,
        anchor_message_id=None,
        limit: int = 200,
    ) -> list:
        """Fetch channel history via Slack conversations.history (real history API)."""
        try:
            kwargs: dict = {"channel": channel_id, "limit": limit}
            if anchor_message_id:
                kwargs["latest"] = anchor_message_id
                kwargs["inclusive"] = False
            resp = await self._app.client.conversations_history(**kwargs)
            messages = resp.get("messages", [])
            result = []
            for m in reversed(messages):   # oldest first
                msg = _slack_msg_to_chat_message(m, channel_id, self._PLATFORM)
                if msg:
                    result.append(msg)
            return result
        except Exception as exc:
            log.warning("slack.fetch_history_failed", channel=channel_id, error=str(exc))
            return []

    async def get_thread(self, channel_id: str, thread_id: str) -> list:
        """Fetch all replies in a Slack thread."""
        try:
            resp = await self._app.client.conversations_replies(
                channel=channel_id, ts=thread_id, limit=500
            )
            messages = resp.get("messages", [])
            return [
                msg for m in messages
                if (msg := _slack_msg_to_chat_message(m, channel_id, self._PLATFORM))
            ]
        except Exception as exc:
            log.warning("slack.get_thread_failed", thread=thread_id, error=str(exc))
            return []

    async def send_buttons(
        self, channel_id: str, text: str, buttons: list, thread_id=None
    ) -> str:
        blocks = text_with_buttons(text, buttons)
        kwargs: dict = {"channel": channel_id, "text": text, "blocks": blocks}
        if thread_id:
            kwargs["thread_ts"] = thread_id
        resp = await self._app.client.chat_postMessage(**kwargs)
        return resp.get("ts", "")

    async def edit_message(self, channel_id: str, message_id: str, text: str, buttons=None) -> None:
        try:
            blocks = text_with_buttons(text, buttons or [])
            await self._app.client.chat_update(
                channel=channel_id, ts=message_id, text=text, blocks=blocks
            )
        except Exception as exc:
            log.warning("slack.edit_message_failed", ts=message_id, error=str(exc))


# ── Module-level helpers ──────────────────────────────────────────────────────

def _fire_click(adapter, click_dict: dict) -> None:
    """Fire button handlers and dispatch_button from a block_action dict."""
    from qorum.bot.events import ButtonClick, ChatUser
    user = ChatUser.from_platform("slack", click_dict["user_id"], click_dict.get("display_name"))
    click = ButtonClick(
        platform="slack",
        channel_id=click_dict["channel_id"],
        message_id=click_dict["message_id"],
        user=user,
        action=click_dict["action"],
        payload=click_dict["payload"],
    )
    for handler in adapter._button_handlers:
        asyncio.create_task(handler(click))
    asyncio.create_task(adapter.dispatch_button(click))


def _event_to_chat_message(event: dict, platform: str) -> "ChatMessage | None":
    from datetime import datetime, timezone
    from qorum.bot.events import ChatMessage, ChatUser
    text = event.get("text", "")
    if not text.strip():
        return None
    user_id = event.get("user", "unknown")
    channel = event.get("channel", "")
    ts_str = event.get("ts", "")
    thread_ts = event.get("thread_ts")
    try:
        ts = datetime.fromtimestamp(float(ts_str), tz=timezone.utc)
    except (ValueError, TypeError):
        ts = datetime.now(timezone.utc)
    author = ChatUser.from_platform(platform, user_id, None)
    return ChatMessage(
        id=ts_str,
        author=author,
        text=text,
        ts=ts,
        reply_to_id=thread_ts,
        thread_id=thread_ts,
        platform=platform,
        channel_id=channel,
        is_bot=bool(event.get("bot_id")),
    )


def _event_to_chat_ctx(event: dict, platform: str, adapter) -> "ChatContext | None":
    from qorum.bot.events import ChatContext, ChatUser
    msg = _event_to_chat_message(event, platform)
    if not msg:
        return None
    bot = ChatUser.from_platform(platform, "bot", "Qorum")
    team_id = event.get("team")
    return ChatContext(
        platform=platform,
        workspace_id=team_id,
        channel_id=msg.channel_id,
        thread_id=msg.thread_id,
        trigger_message=msg,
        me=bot,
    )


def _slack_msg_to_chat_message(m: dict, channel_id: str, platform: str) -> "ChatMessage | None":
    return _event_to_chat_message({**m, "channel": channel_id}, platform)
