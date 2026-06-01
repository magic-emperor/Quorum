"""
Phase 13 — Slack Block Kit renderer.

Converts platform-neutral Button[] and card content to Block Kit JSON.
Also parses block_actions payloads back to ButtonClick-compatible dicts.
"""
from __future__ import annotations

import json
from typing import Optional

from qorum.bot.buttons import Button


# ── Button → Block Kit element ────────────────────────────────────────────────

def button_to_element(btn: Button, value_override: Optional[str] = None) -> dict:
    """Convert a Qorum Button to a Block Kit button element."""
    style_map = {"success": "primary", "danger": "danger"}
    element = {
        "type": "button",
        "text": {"type": "plain_text", "text": btn.label, "emoji": True},
        "action_id": btn.action,
        "value": value_override or json.dumps(btn.payload)[:2000],
    }
    style = style_map.get(btn.style)
    if style:
        element["style"] = style
    return element


def buttons_to_actions_block(buttons: list[Button], block_id: str = "qorum_actions") -> dict:
    """Wrap Button[] in a Block Kit actions block."""
    return {
        "type": "actions",
        "block_id": block_id,
        "elements": [button_to_element(b) for b in buttons],
    }


# ── Card builders ─────────────────────────────────────────────────────────────

def text_with_buttons(
    text: str,
    buttons: list[Button],
    block_id: str = "qorum_actions",
) -> list[dict]:
    """Return a Block Kit blocks list: text section + optional actions block."""
    blocks: list[dict] = [
        {"type": "section", "text": {"type": "mrkdwn", "text": text}},
    ]
    if buttons:
        blocks.append({"type": "divider"})
        blocks.append(buttons_to_actions_block(buttons, block_id=block_id))
    return blocks


def approval_blocks(
    title: str,
    summary: str,
    buttons: list[Button],
    details: Optional[list[str]] = None,
    target_label: Optional[str] = None,
    confidence: Optional[int] = None,
) -> list[dict]:
    """Full approval card as Block Kit blocks."""
    conf_icon = _conf_icon(confidence) if confidence is not None else ""
    header = f"*QORUM Plan* — {title} {conf_icon}"
    blocks: list[dict] = [
        {"type": "header", "text": {"type": "plain_text", "text": f"Qorum Plan — {title}"}},
        {"type": "section", "text": {"type": "mrkdwn", "text": f"{header}\n\n{summary}"}},
    ]
    fields = []
    if target_label:
        fields.append({"type": "mrkdwn", "text": f"*Target:*\n{target_label}"})
    if confidence is not None:
        fields.append({"type": "mrkdwn", "text": f"*Confidence:*\n{confidence}%"})
    if fields:
        blocks.append({"type": "section", "fields": fields})
    if details:
        for d in details[:3]:
            blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": d}]})
    blocks.append({"type": "divider"})
    blocks.append(buttons_to_actions_block(buttons))
    return blocks


def diff_review_blocks(
    branch: str,
    lines_added: int,
    lines_removed: int,
    files_changed: int,
    gate_verdict: Optional[str],
    change_entries: list[dict],
    buttons: list[Button],
    server_url: Optional[str] = None,
) -> list[dict]:
    """Diff review blocks."""
    blocks = [
        {"type": "header", "text": {"type": "plain_text", "text": f"Diff ready — {branch}"}},
        {"type": "section", "fields": [
            {"type": "mrkdwn", "text": f"*Changes:*\n+{lines_added}/-{lines_removed} in {files_changed} file(s)"},
            {"type": "mrkdwn", "text": f"*Gate:*\n{gate_verdict or 'n/a'}"},
        ]},
    ]
    if change_entries:
        entry_text = "\n".join(
            f"• `{e.get('path', '')}` — {e.get('action', '')} — {e.get('reason', '')}"
            for e in change_entries[:5]
        )
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": entry_text}})
    if server_url:
        blocks.append({"type": "section", "text": {"type": "mrkdwn",
                        "text": f"<{server_url}|View full diff on dashboard>"}})
    blocks.append({"type": "divider"})
    blocks.append(buttons_to_actions_block(buttons))
    return blocks


# ── Inbound action → ButtonClick dict ────────────────────────────────────────

def block_action_to_click(body: dict, action: dict, platform: str = "slack") -> dict:
    """Parse a Slack block_actions body+action into a ButtonClick-compatible dict."""
    user = body.get("user", {})
    channel = body.get("channel", {})
    message = body.get("message", {})

    action_id = action.get("action_id", "")
    raw_value = action.get("value", "{}")
    try:
        payload = json.loads(raw_value)
    except (json.JSONDecodeError, TypeError):
        # Legacy: value is a plain ticket_id string
        payload = {"ticket_id": raw_value}

    return {
        "platform": platform,
        "channel_id": channel.get("id", ""),
        "message_id": message.get("ts", ""),
        "user_id": user.get("id", ""),
        "display_name": user.get("name") or user.get("username"),
        "action": action_id,
        "payload": payload,
    }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _conf_icon(confidence: int) -> str:
    if confidence >= 85:
        return ":large_green_circle:"
    if confidence >= 70:
        return ":large_yellow_circle:"
    return ":red_circle:"
