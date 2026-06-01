"""
Phase 12 — Adaptive Card renderer for Microsoft Teams.

Converts the platform-neutral Button[] and card specs (Phase 4/7) into
Adaptive Card JSON that Teams renders natively.

Key Teams constraints:
  - Action.Execute with verb/data drives bot Invoke activities (not postBack)
  - User-specific card views (refresh on per-user basis) for approver-only actions
  - Card body width is fixed — keep concise; deep-link heavy content to Phase 10
  - Card update uses the activity.id from the original send

Adaptive Card spec: https://adaptivecards.io/
Action.Execute spec: https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/universal-actions-for-adaptive-cards/overview
"""
from __future__ import annotations

import json
from typing import Optional

from qorum.bot.buttons import Button


# ── Button → Action.Execute ────────────────────────────────────────────────────

def button_to_action(btn: Button) -> dict:
    """Convert a Qorum Button to an Adaptive Card Action.Execute."""
    style_map = {
        "primary": "positive",
        "success": "positive",
        "danger": "destructive",
        "secondary": "default",
    }
    return {
        "type": "Action.Execute",
        "title": btn.label,
        "verb": btn.action,
        "data": btn.payload,
        "style": style_map.get(btn.style, "default"),
        "isEnabled": not btn.disabled,
    }


def buttons_to_action_set(buttons: list[Button]) -> dict:
    """Wrap a list of Buttons in an ActionSet element."""
    return {
        "type": "ActionSet",
        "actions": [button_to_action(b) for b in buttons],
    }


# ── Card builders ─────────────────────────────────────────────────────────────

def approval_card(
    title: str,
    summary: str,
    details: list[str],
    buttons: list[Button],
    confidence: Optional[int] = None,
    target_label: Optional[str] = None,
    capture_info: Optional[str] = None,
    ambiguities: Optional[list[str]] = None,
    approvers_line: Optional[str] = None,
) -> dict:
    """Build the full plan approval Adaptive Card."""
    body = []

    # Header
    conf_icon = _conf_icon(confidence) if confidence is not None else ""
    body.append({
        "type": "TextBlock",
        "text": f"**Qorum Plan** — {title} {conf_icon}",
        "wrap": True,
        "size": "Medium",
        "weight": "Bolder",
    })

    # Summary
    body.append({
        "type": "TextBlock",
        "text": summary,
        "wrap": True,
        "spacing": "Small",
    })

    # Detail facts
    facts = []
    if target_label:
        facts.append({"title": "Target", "value": target_label})
    if capture_info:
        facts.append({"title": "Captured", "value": capture_info})
    if confidence is not None:
        facts.append({"title": "Confidence", "value": f"{confidence}%"})
    if facts:
        body.append({"type": "FactSet", "facts": facts})

    # Ambiguities
    if ambiguities:
        body.append({"type": "TextBlock", "text": "**Ambiguities:**", "wrap": True})
        for a in ambiguities[:2]:
            body.append({"type": "TextBlock", "text": f"• {a}", "wrap": True, "spacing": "None"})

    # Approvers
    if approvers_line:
        body.append({
            "type": "TextBlock",
            "text": approvers_line,
            "wrap": True,
            "color": "Accent",
            "spacing": "Small",
        })

    # Extra detail lines
    for d in details:
        body.append({"type": "TextBlock", "text": d, "wrap": True, "isSubtle": True, "spacing": "None"})

    body.append(buttons_to_action_set(buttons))
    return _wrap_card(body)


def progress_card(
    run_id: str,
    current_action: str,
    files_touched: int = 0,
    build_status: Optional[str] = None,
    test_status: Optional[str] = None,
    server_url: Optional[str] = None,
) -> dict:
    """Live progress card — updated as execution proceeds (via edit_message)."""
    body = [
        {"type": "TextBlock", "text": "**Qorum — Executing…**", "weight": "Bolder"},
        {"type": "TextBlock", "text": current_action, "wrap": True, "spacing": "Small"},
    ]

    facts = [{"title": "Files touched", "value": str(files_touched)}]
    if build_status:
        facts.append({"title": "Build", "value": build_status})
    if test_status:
        facts.append({"title": "Tests", "value": test_status})
    body.append({"type": "FactSet", "facts": facts})

    if server_url:
        body.append({
            "type": "ActionSet",
            "actions": [{
                "type": "Action.OpenUrl",
                "title": "Open Dashboard",
                "url": f"{server_url}/runs/{run_id}",
            }]
        })

    return _wrap_card(body)


def diff_review_card(
    branch: str,
    lines_added: int,
    lines_removed: int,
    files_changed: int,
    gate_verdict: Optional[str],
    change_entries: list[dict],
    buttons: list[Button],
    server_url: Optional[str] = None,
) -> dict:
    """Diff review card — shown after execution, before commit."""
    body = [
        {"type": "TextBlock", "text": f"**Diff ready** — branch `{branch}`", "weight": "Bolder"},
        {"type": "FactSet", "facts": [
            {"title": "Changes", "value": f"+{lines_added} / -{lines_removed} lines in {files_changed} file(s)"},
            {"title": "Gate", "value": gate_verdict or "n/a"},
        ]},
    ]

    if change_entries:
        body.append({"type": "TextBlock", "text": "**Changed files:**", "wrap": True})
        for e in change_entries[:6]:
            body.append({
                "type": "TextBlock",
                "text": f"• `{e.get('path', '')}` — {e.get('action', '')} — {e.get('reason', '')}",
                "wrap": True, "spacing": "None", "isSubtle": True,
            })
        if len(change_entries) > 6:
            body.append({
                "type": "TextBlock",
                "text": f"_…and {len(change_entries) - 6} more_",
                "isSubtle": True, "spacing": "None",
            })

    if server_url:
        body.append({
            "type": "ActionSet",
            "actions": [{"type": "Action.OpenUrl", "title": "View full diff", "url": server_url}],
        })

    body.append(buttons_to_action_set(buttons))
    return _wrap_card(body)


def confirm_range_card(
    card_text: str,
    buttons: list[Button],
) -> dict:
    """Confirm-range card for Phase 5 boundary engine."""
    body = [
        {"type": "TextBlock", "text": card_text, "wrap": True},
        buttons_to_action_set(buttons),
    ]
    return _wrap_card(body)


def simple_message_card(text: str) -> dict:
    """Plain message wrapped in an Adaptive Card."""
    return _wrap_card([{"type": "TextBlock", "text": text, "wrap": True}])


# ── Invoke payload → ButtonClick ──────────────────────────────────────────────

def invoke_to_button_click(
    activity,
    platform: str = "teams",
) -> Optional[dict]:
    """
    Parse a Teams Invoke activity (adaptiveCard/action) into a dict
    suitable for constructing a ButtonClick.
    Returns None if the activity is not an adaptive card action.
    """
    if getattr(activity, "name", "") != "adaptiveCard/action":
        return None

    value = getattr(activity, "value", {}) or {}
    verb = value.get("action", {}).get("verb", "") or value.get("verb", "")
    data = value.get("action", {}).get("data", {}) or value.get("data", {}) or {}

    from_user = getattr(activity, "from_property", None)
    user_id = getattr(from_user, "aad_object_id", "") or getattr(from_user, "id", "unknown")
    display_name = getattr(from_user, "name", None)

    conversation = getattr(activity, "conversation", None)
    channel_id = getattr(conversation, "id", "")
    message_id = getattr(activity, "reply_to_id", "") or getattr(activity, "id", "")

    return {
        "platform": platform,
        "channel_id": channel_id,
        "message_id": message_id,
        "user_id": user_id,
        "display_name": display_name,
        "action": verb,
        "payload": data,
    }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _wrap_card(body: list) -> dict:
    """Wrap body elements in an Adaptive Card v1.5 envelope."""
    return {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.5",
        "body": body,
        "msteams": {"width": "Full"},
    }


def _conf_icon(confidence: int) -> str:
    if confidence >= 85:
        return "🟢"
    if confidence >= 70:
        return "🟡"
    return "🔴"


def card_attachment(card: dict) -> dict:
    """Wrap an Adaptive Card dict in a Bot Framework attachment."""
    return {
        "contentType": "application/vnd.microsoft.card.adaptive",
        "content": card,
    }
