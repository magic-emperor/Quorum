"""
Phase 13 — WhatsApp Cloud API message renderer.

WhatsApp constraints vs Teams/Slack/Discord:
  - No threads, no rich cards
  - Interactive reply buttons: max 3 buttons, 20-char label limit
  - List messages: up to 10 rows (for >3 options)
  - Template messages: required outside the 24-hour service window
  - No history API → rolling buffer only

Approval UX tiers:
  1. ≤3 buttons → interactive reply_button message (preferred)
  2. >3 buttons → list message (collapsible sections)
  3. Fallback → numbered text reply ("reply A to approve, B to reject")
"""
from __future__ import annotations

import json
from typing import Optional

from qorum.bot.buttons import Button

_MAX_BUTTON_LABEL = 20
_MAX_INTERACTIVE_BUTTONS = 3
_MAX_LIST_ROWS = 10

# Separator between action and payload in a WhatsApp reply ID.
# Action names contain ':' (e.g. "qorum:approve"), so we use '|' which they never contain.
_ID_SEP = "|"


# ── Interactive button message (≤3 buttons) ───────────────────────────────────

def interactive_buttons(
    body_text: str,
    buttons: list[Button],
    header: Optional[str] = None,
    footer: Optional[str] = None,
) -> dict:
    """
    Build a WhatsApp interactive reply_button message payload.
    Truncates labels to 20 chars (WhatsApp limit).
    """
    assert len(buttons) <= _MAX_INTERACTIVE_BUTTONS, \
        f"WhatsApp supports max {_MAX_INTERACTIVE_BUTTONS} interactive buttons; use list_message for more"

    btn_list = []
    for i, btn in enumerate(buttons):
        label = btn.label[:_MAX_BUTTON_LABEL].strip()
        btn_list.append({
            "type": "reply",
            "reply": {
                "id": f"{btn.action}{_ID_SEP}{json.dumps(btn.payload)[:50]}",
                "title": label,
            },
        })

    payload: dict = {
        "type": "interactive",
        "interactive": {
            "type": "button",
            "body": {"text": body_text[:1024]},
            "action": {"buttons": btn_list},
        },
    }
    if header:
        payload["interactive"]["header"] = {"type": "text", "text": header[:60]}
    if footer:
        payload["interactive"]["footer"] = {"text": footer[:60]}
    return payload


# ── List message (>3 buttons) ─────────────────────────────────────────────────

def list_message(
    body_text: str,
    buttons: list[Button],
    button_label: str = "Options",
    section_title: str = "Actions",
) -> dict:
    """
    Build a WhatsApp list message for >3 options (up to 10).
    """
    rows = []
    for btn in buttons[:_MAX_LIST_ROWS]:
        rows.append({
            "id": f"{btn.action}{_ID_SEP}{json.dumps(btn.payload)[:40]}",
            "title": btn.label[:24].strip(),
            "description": btn.payload.get("ticket_id", "")[:72] if btn.payload else "",
        })

    return {
        "type": "interactive",
        "interactive": {
            "type": "list",
            "body": {"text": body_text[:1024]},
            "action": {
                "button": button_label[:20],
                "sections": [{"title": section_title[:24], "rows": rows}],
            },
        },
    }


# ── Numbered-reply fallback (>10 options or degraded path) ───────────────────

def numbered_reply_text(body_text: str, buttons: list[Button]) -> str:
    """
    Fallback text message with numbered replies.
    Used when interactive messages aren't available (template window, >10 options).
    """
    lines = [body_text, ""]
    for i, btn in enumerate(buttons, 1):
        lines.append(f"  *{i}.* {btn.label}")
    lines.append("")
    lines.append("_Reply with the number of your choice._")
    return "\n".join(lines)


def parse_numbered_reply(text: str, buttons: list[Button]) -> Optional[dict]:
    """
    Parse a user's numbered reply ("1", "2", etc.) back to a button.
    Returns the button's action+payload, or None if not a valid number.
    """
    stripped = text.strip()
    try:
        idx = int(stripped) - 1
        if 0 <= idx < len(buttons):
            btn = buttons[idx]
            return {"action": btn.action, "payload": btn.payload}
    except (ValueError, IndexError):
        pass
    return None


# ── Interactive response → ButtonClick dict ───────────────────────────────────

def interactive_reply_to_click(
    message: dict,
    from_phone: str,
    platform: str = "whatsapp",
) -> Optional[dict]:
    """
    Parse a WhatsApp interactive_button or list_reply webhook payload.
    Returns a ButtonClick-compatible dict or None if not parseable.
    """
    interactive = message.get("interactive", {})
    reply_type = interactive.get("type")

    if reply_type == "button_reply":
        reply = interactive.get("button_reply", {})
        raw_id = reply.get("id", "")
    elif reply_type == "list_reply":
        reply = interactive.get("list_reply", {})
        raw_id = reply.get("id", "")
    else:
        return None

    # raw_id format: "action|payload_json"
    action, _, payload_raw = raw_id.partition(_ID_SEP)
    try:
        payload = json.loads(payload_raw) if payload_raw else {}
    except json.JSONDecodeError:
        payload = {}

    return {
        "platform": platform,
        "channel_id": from_phone,
        "message_id": message.get("id", ""),
        "user_id": from_phone,
        "display_name": None,
        "action": action,
        "payload": payload,
    }


# ── 24-hour window check ──────────────────────────────────────────────────────

def is_within_service_window(last_user_message_ts: float) -> bool:
    """
    Return True if we're within the 24-hour service window for free-form messages.
    Outside this window, only pre-approved template messages can be sent.
    """
    import time
    return (time.time() - last_user_message_ts) < 86400


def build_approval_message(
    text: str,
    buttons: list[Button],
    last_user_ts: float,
    server_url: Optional[str] = None,
) -> dict:
    """
    Build the best available approval message based on button count and window.
    """
    # Add dashboard deep link to text if available
    display_text = text
    if server_url:
        display_text = f"{text}\n\n🔗 Dashboard: {server_url}"

    if not is_within_service_window(last_user_ts):
        # Outside 24h window — only template messages; return a plain text fallback
        return {
            "type": "text",
            "text": {"body": display_text[:4096]},
            "_fallback": True,
        }

    if len(buttons) <= _MAX_INTERACTIVE_BUTTONS:
        return interactive_buttons(display_text, buttons)

    if len(buttons) <= _MAX_LIST_ROWS:
        return list_message(display_text, buttons)

    # Last resort — numbered text
    return {
        "type": "text",
        "text": {"body": numbered_reply_text(display_text, buttons)},
        "_numbered_fallback": True,
    }
