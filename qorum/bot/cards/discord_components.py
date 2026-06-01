"""
Phase 13 — Discord component renderer.

Converts platform-neutral Button[] to nextcord View/Button components,
and parses interaction callbacks back to ButtonClick-compatible dicts.
"""
from __future__ import annotations

import asyncio
from typing import Callable, Optional

from qorum.bot.buttons import Button
from qorum.bot.actions import BotAction


def button_style(btn: Button) -> "int":
    """Map Qorum style to nextcord ButtonStyle integer."""
    try:
        import nextcord
        style_map = {
            "success": nextcord.ButtonStyle.success,
            "primary": nextcord.ButtonStyle.primary,
            "danger": nextcord.ButtonStyle.danger,
            "secondary": nextcord.ButtonStyle.secondary,
        }
        return style_map.get(btn.style, nextcord.ButtonStyle.secondary)
    except ImportError:
        return 2  # secondary


def make_view(
    buttons: list[Button],
    on_click: Callable,
    timeout: int = 86400,
) -> "Any":
    """
    Build a nextcord View with the given buttons.
    on_click: async callback(button_click_dict, interaction)
    """
    try:
        import nextcord

        class QorumView(nextcord.ui.View):
            def __init__(self):
                super().__init__(timeout=timeout)

        view = QorumView()

        for btn in buttons:
            import json
            import functools

            async def _handler(
                _b: nextcord.ui.Button,
                interaction: nextcord.Interaction,
                _action: str = btn.action,
                _payload: dict = btn.payload,
            ) -> None:
                await interaction.response.defer()
                click = interaction_to_click(interaction, _action, _payload)
                await on_click(click, interaction)

            discord_btn = nextcord.ui.Button(
                label=btn.label,
                style=button_style(btn),
                custom_id=f"qorum:{btn.action}:{json.dumps(btn.payload)[:80]}",
                disabled=btn.disabled,
            )
            discord_btn.callback = _handler
            view.add_item(discord_btn)

        return view

    except ImportError:
        return None


def interaction_to_click(
    interaction: "Any",
    action: str,
    payload: dict,
    platform: str = "discord",
) -> dict:
    """Convert a Discord Interaction to a ButtonClick-compatible dict."""
    user = getattr(interaction, "user", None)
    channel = getattr(interaction, "channel", None)
    message = getattr(interaction, "message", None)
    return {
        "platform": platform,
        "channel_id": str(getattr(channel, "id", "")) if channel else "",
        "message_id": str(getattr(message, "id", "")) if message else "",
        "user_id": str(getattr(user, "id", "")) if user else "",
        "display_name": getattr(user, "display_name", None) if user else None,
        "action": action,
        "payload": payload,
    }


# ── Embed builder (for rich messages) ────────────────────────────────────────

def approval_embed(
    title: str,
    summary: str,
    target_label: Optional[str] = None,
    confidence: Optional[int] = None,
    approvers_line: Optional[str] = None,
) -> "Any":
    """Build a Discord Embed for the approval card."""
    try:
        import nextcord

        conf_color = {
            "green": 0x3fb950,
            "yellow": 0xe3b341,
            "red": 0xf85149,
        }
        color = conf_color["green" if (confidence or 0) >= 85 else ("yellow" if (confidence or 0) >= 70 else "red")]

        embed = nextcord.Embed(
            title=f"Qorum Plan — {title}",
            description=summary,
            color=color,
        )
        if target_label:
            embed.add_field(name="Target", value=target_label, inline=True)
        if confidence is not None:
            icon = "🟢" if confidence >= 85 else ("🟡" if confidence >= 70 else "🔴")
            embed.add_field(name="Confidence", value=f"{icon} {confidence}%", inline=True)
        if approvers_line:
            embed.add_field(name="Approvers", value=approvers_line, inline=False)
        embed.set_footer(text="Qorum — approve or request changes")
        return embed
    except ImportError:
        return None
