"""
Qorum Discord Adapter — nextcord slash commands with interactive buttons.

Uses nextcord (discord.py fork with first-class slash command support).
Approval buttons use Discord's component system (View + Button).

Required env vars:
  DISCORD_BOT_TOKEN — Bot token from Discord Developer Portal
"""
from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

import nextcord
from nextcord.ext import commands

from qorum.bot.base_adapter import BaseQorumAdapter, BotContext
from qorum.bot.buttons import Button
from qorum.bot.cards.discord_components import interaction_to_click, make_view
from qorum.bot.events import ButtonClick, ChatContext, ChatMessage, ChatUser
from qorum.bot.message_store import MessageStore
from qorum.core.logger import get_logger

if TYPE_CHECKING:
    from qorum.config import QorumConfig
    from qorum.core.orchestrator import QorumOrchestrator

log = get_logger(__name__)


# ── Discord UI components ─────────────────────────────────────────────────────

class ApprovalView(nextcord.ui.View):
    """Block Kit equivalent: approval buttons for Discord."""

    def __init__(self, adapter: "DiscordAdapter", ticket_id: str) -> None:
        super().__init__(timeout=86400)  # 24h timeout
        self._adapter = adapter
        self._ticket_id = ticket_id

    @nextcord.ui.button(label="✅ Approve Plan", style=nextcord.ButtonStyle.success)
    async def approve(self, _button: nextcord.ui.Button, interaction: nextcord.Interaction):
        await interaction.response.defer()
        ctx = _interaction_to_ctx(interaction)
        asyncio.create_task(self._adapter.handle_approve(ctx, self._ticket_id))

    @nextcord.ui.button(label="✏️ Request Changes", style=nextcord.ButtonStyle.secondary)
    async def request_changes(self, _button: nextcord.ui.Button, interaction: nextcord.Interaction):
        await interaction.response.send_modal(
            FeedbackModal(self._adapter, self._ticket_id, interaction)
        )


class FeedbackModal(nextcord.ui.Modal):
    """Modal dialog for collecting change request feedback text."""

    def __init__(
        self,
        adapter: "DiscordAdapter",
        ticket_id: str,
        source_interaction: nextcord.Interaction,
    ) -> None:
        super().__init__(title=f"Request Changes — {ticket_id}")
        self._adapter = adapter
        self._ticket_id = ticket_id
        self._source = source_interaction

        self.feedback = nextcord.ui.TextInput(
            label="What should be changed?",
            placeholder="Describe the changes you need...",
            style=nextcord.TextInputStyle.paragraph,
            required=True,
            max_length=1000,
        )
        self.add_item(self.feedback)

    async def callback(self, interaction: nextcord.Interaction):
        await interaction.response.defer()
        ctx = _interaction_to_ctx(interaction)
        asyncio.create_task(
            self._adapter.handle_request_changes(ctx, self._ticket_id, self.feedback.value)
        )


class MarkDoneView(nextcord.ui.View):
    """Mark Done button shown after testing.md is generated."""

    def __init__(self, adapter: "DiscordAdapter", ticket_id: str) -> None:
        super().__init__(timeout=None)  # Persistent until clicked
        self._adapter = adapter
        self._ticket_id = ticket_id

    @nextcord.ui.button(label="🚀 Mark Done", style=nextcord.ButtonStyle.primary)
    async def mark_done(self, _button: nextcord.ui.Button, interaction: nextcord.Interaction):
        await interaction.response.defer()
        ctx = _interaction_to_ctx(interaction)
        walkthrough_data = {
            "summary": f"Ticket {self._ticket_id} completed.",
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
            self._adapter.handle_mark_done(ctx, self._ticket_id, walkthrough_data)
        )


class FeedbackView(nextcord.ui.View):
    """👍 / 👎 / ✏️ feedback buttons shown after each artifact."""

    def __init__(self, adapter: "DiscordAdapter", ticket_id: str, artifact_type: str) -> None:
        super().__init__(timeout=86400)
        self._adapter = adapter
        self._ticket_id = ticket_id
        self._artifact_type = artifact_type

    @nextcord.ui.button(label="👍 Helpful", style=nextcord.ButtonStyle.success)
    async def helpful(self, _button: nextcord.ui.Button, interaction: nextcord.Interaction):
        await interaction.response.defer()
        ctx = _interaction_to_ctx(interaction)
        asyncio.create_task(
            self._adapter.handle_feedback(ctx, self._ticket_id, self._artifact_type, "helpful")
        )

    @nextcord.ui.button(label="👎 Needs Work", style=nextcord.ButtonStyle.danger)
    async def needs_work(self, _button: nextcord.ui.Button, interaction: nextcord.Interaction):
        await interaction.response.defer()
        ctx = _interaction_to_ctx(interaction)
        asyncio.create_task(
            self._adapter.handle_feedback(ctx, self._ticket_id, self._artifact_type, "needs_work")
        )

    @nextcord.ui.button(label="✏️ Flag Issue", style=nextcord.ButtonStyle.secondary)
    async def flag_issue(self, _button: nextcord.ui.Button, interaction: nextcord.Interaction):
        await interaction.response.defer()
        ctx = _interaction_to_ctx(interaction)
        asyncio.create_task(
            self._adapter.handle_feedback(
                ctx, self._ticket_id, self._artifact_type, "needs_work",
                comment="Flagged via ✏️ button",
            )
        )


def _interaction_to_ctx(interaction: nextcord.Interaction) -> BotContext:
    channel_id = str(interaction.channel_id or "")
    return BotContext(
        platform="discord",
        channel_id=channel_id,
        user_id=str(interaction.user.id),
        username=interaction.user.name,
        raw=interaction,
    )


# ── Discord Adapter ───────────────────────────────────────────────────────────

class DiscordAdapter(BaseQorumAdapter):
    """
    Discord bot using nextcord with slash commands.
    Application commands are registered globally (may take up to 1h to propagate)
    or per-guild for instant registration during development.
    """

    _PLATFORM = "discord"

    def __init__(self, config: "QorumConfig", orchestrator: "QorumOrchestrator") -> None:
        super().__init__(config, orchestrator)
        intents = nextcord.Intents.default()
        intents.message_content = True
        self._bot = commands.Bot(command_prefix="!", intents=intents)
        self._store = MessageStore()
        self._mention_handlers: list = []
        self._button_handlers: list = []
        self._register_handlers()

    # ── Bot lifecycle ─────────────────────────────────────────────────────────

    async def start(self) -> None:
        log.info("discord.starting")
        await self._bot.start(self._config.discord_bot_token)

    async def stop(self) -> None:
        await self._bot.close()
        log.info("discord.stopped")

    # ── Send methods ──────────────────────────────────────────────────────────

    async def send_message(self, channel_id: str, text: str, **kwargs: Any) -> Any:
        channel = self._bot.get_channel(int(channel_id))
        if channel is None:
            channel = await self._bot.fetch_channel(int(channel_id))
        return await channel.send(text, **kwargs)

    async def send_approval_buttons(
        self,
        channel_id: str,
        ticket_id: str,
        plan_paths: list[str],
        inline_summary: str,
    ) -> Any:
        paths_text = "\n".join(f"• `{p}`" for p in plan_paths)
        text = f"{inline_summary}\n\n**Plan file(s):**\n{paths_text}"
        view = ApprovalView(self, ticket_id)
        return await self.send_message(channel_id, text, view=view)

    async def send_testing_ready(
        self,
        channel_id: str,
        ticket_id: str,
        testing_paths: list[str],
    ) -> Any:
        paths_text = "\n".join(f"• `{p}`" for p in testing_paths)
        text = (
            f"**Plan approved!** Testing guide generated for `{ticket_id}`.\n\n"
            f"**Testing file(s):**\n{paths_text}\n\n"
            f"Click **Mark Done** after implementation."
        )
        view = MarkDoneView(self, ticket_id)
        return await self.send_message(channel_id, text, view=view)

    async def send_done(
        self,
        channel_id: str,
        ticket_id: str,
        walkthrough_path: str,
    ) -> Any:
        return await self.send_message(
            channel_id,
            f"**Ticket `{ticket_id}` complete!** ✅\nWalkthrough saved to: `{walkthrough_path}`",
        )

    async def send_feedback_buttons(
        self, channel_id: str, ticket_id: str, artifact_type: str
    ) -> Any:
        view = FeedbackView(self, ticket_id, artifact_type)
        return await self.send_message(
            channel_id,
            f"How was this {artifact_type} for `{ticket_id}`?",
            view=view,
        )

    async def prompt_for_feedback(self, channel_id: str, ticket_id: str) -> Any:
        # Discord uses modals for feedback — this is handled inline via FeedbackModal.
        # This method is a fallback for non-interactive contexts.
        return await self.send_message(
            channel_id,
            f"What changes would you like for `{ticket_id}`? "
            f"Use the **Request Changes** button to open the feedback form.",
        )

    # ── Handler registration ──────────────────────────────────────────────────

    def _register_handlers(self) -> None:
        bot = self._bot

        @bot.event
        async def on_ready():
            log.info("discord.ready", user=str(bot.user))

        @bot.slash_command(name="qorum", description="Qorum — generate plans from ticket URLs")
        async def atlas_command(interaction: nextcord.Interaction, text: str = ""):
            await interaction.response.defer()
            ctx = _interaction_to_ctx(interaction)
            asyncio.create_task(self.handle_command(ctx, f"/atlas {text}"))

        @bot.event
        async def on_message(message: nextcord.Message):
            if message.author.bot:
                return
            # Buffer the message
            msg = _discord_msg_to_chat_message(message)
            if msg:
                asyncio.create_task(self._store.store(msg))

            # Check for @mention of the bot
            if bot.user and bot.user.mentioned_in(message):
                chat_ctx = _discord_msg_to_chat_ctx(message, bot)
                if chat_ctx:
                    for handler in self._mention_handlers:
                        asyncio.create_task(handler(chat_ctx))

            await bot.process_commands(message)

    # ── Phase 4: lifecycle + event model ──────────────────────────────────────

    async def start(self) -> None:
        await self._store.init()
        await self.on_mention(self.handle_mention)
        log.info("discord.starting")
        await self._bot.start(self._config.discord_bot_token)

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
        """Fetch Discord channel message history."""
        try:
            channel = self._bot.get_channel(int(channel_id)) or \
                      await self._bot.fetch_channel(int(channel_id))
            kwargs = {"limit": limit}
            if anchor_message_id:
                anchor = await channel.fetch_message(int(anchor_message_id))
                kwargs["before"] = anchor
            messages = [m async for m in channel.history(**kwargs)]
            messages.reverse()   # oldest first
            return [
                msg for m in messages
                if (msg := _discord_msg_to_chat_message(m))
            ]
        except Exception as exc:
            log.warning("discord.fetch_history_failed", channel=channel_id, error=str(exc))
            return []

    async def get_thread(self, channel_id: str, thread_id: str) -> list:
        """Fetch a Discord thread's messages."""
        try:
            thread = self._bot.get_channel(int(thread_id)) or \
                     await self._bot.fetch_channel(int(thread_id))
            messages = [m async for m in thread.history(limit=500)]
            messages.reverse()
            return [msg for m in messages if (msg := _discord_msg_to_chat_message(m))]
        except Exception as exc:
            log.warning("discord.get_thread_failed", thread_id=thread_id, error=str(exc))
            return []

    async def send_buttons(
        self, channel_id: str, text: str, buttons: list, thread_id=None
    ) -> str:
        """Send a message with Discord component buttons via make_view."""
        async def on_click(click_dict: dict, _interaction) -> None:
            user = ChatUser.from_platform(self._PLATFORM,
                                          click_dict["user_id"], click_dict.get("display_name"))
            click = ButtonClick(
                platform=self._PLATFORM,
                channel_id=click_dict["channel_id"],
                message_id=click_dict["message_id"],
                user=user,
                action=click_dict["action"],
                payload=click_dict["payload"],
            )
            for handler in self._button_handlers:
                asyncio.create_task(handler(click))
            asyncio.create_task(self.dispatch_button(click))

        view = make_view(buttons, on_click)
        channel = self._bot.get_channel(int(channel_id)) or \
                  await self._bot.fetch_channel(int(channel_id))
        kwargs = {"content": text}
        if view:
            kwargs["view"] = view
        msg = await channel.send(**kwargs)
        return str(msg.id)

    async def edit_message(
        self, channel_id: str, message_id: str, text: str, buttons=None
    ) -> None:
        try:
            channel = self._bot.get_channel(int(channel_id)) or \
                      await self._bot.fetch_channel(int(channel_id))
            message = await channel.fetch_message(int(message_id))
            view = make_view(buttons, lambda c, i: None) if buttons else None
            await message.edit(content=text, view=view)
        except Exception as exc:
            log.warning("discord.edit_message_failed", message_id=message_id, error=str(exc))


# ── Module-level helpers ──────────────────────────────────────────────────────

def _discord_msg_to_chat_message(message: "nextcord.Message") -> "ChatMessage | None":
    from datetime import timezone
    from qorum.bot.events import ChatMessage, ChatUser
    if not message.content:
        return None
    author = ChatUser.from_platform(
        "discord", str(message.author.id), message.author.display_name
    )
    ref = message.reference
    reply_to = str(ref.message_id) if ref and ref.message_id else None
    return ChatMessage(
        id=str(message.id),
        author=author,
        text=message.content,
        ts=message.created_at.replace(tzinfo=timezone.utc) if message.created_at.tzinfo is None
           else message.created_at,
        reply_to_id=reply_to,
        thread_id=str(message.channel.id) if hasattr(message.channel, "parent_id") else reply_to,
        platform="discord",
        channel_id=str(message.channel.id),
        is_bot=message.author.bot,
    )


def _discord_msg_to_chat_ctx(message: "nextcord.Message", bot) -> "ChatContext | None":
    from qorum.bot.events import ChatContext, ChatUser
    msg = _discord_msg_to_chat_message(message)
    if not msg:
        return None
    qorum_bot = ChatUser.from_platform("discord", str(bot.user.id) if bot.user else "bot", "Qorum")
    return ChatContext(
        platform="discord",
        workspace_id=str(message.guild.id) if message.guild else None,
        channel_id=str(message.channel.id),
        thread_id=msg.thread_id,
        trigger_message=msg,
        me=qorum_bot,
    )
