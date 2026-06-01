"""
Phase 11 — Board webhook routes on the Phase 10 server.

Receives webhook payloads from Jira / Azure Boards and converts them to
WatchRunner.run_once() calls (same pipeline as the poll mode).

Mount on the Phase 10 FastAPI app:
  POST /webhooks/jira       — Jira Cloud webhook (HMAC-SHA256 signature)
  POST /webhooks/azure      — Azure Boards service hook (secret token)

Signature verification is always enforced in production.
Configure: QORUM_JIRA_WEBHOOK_SECRET, QORUM_AZURE_WEBHOOK_SECRET env vars.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, status

from qorum.core.logger import get_logger
from qorum.tools.events import ToolEvent
from qorum.server.event_bus import get_bus

log = get_logger(__name__)

router = APIRouter(prefix="/webhooks", tags=["webhooks"])

# Registered watch callbacks: platform → async callable(ticket_id, event_type)
_watchers: dict[str, list] = {}


def register_watcher(platform: str, callback) -> None:
    """Register an async callback for a platform's webhook events."""
    _watchers.setdefault(platform, []).append(callback)


# ── Jira ──────────────────────────────────────────────────────────────────────

@router.post("/jira")
async def jira_webhook(request: Request) -> dict:
    """
    Jira Cloud webhook endpoint.
    Expects X-Hub-Signature-256 header when QORUM_JIRA_WEBHOOK_SECRET is set.
    """
    body = await request.body()
    secret = os.environ.get("QORUM_JIRA_WEBHOOK_SECRET", "")

    if secret:
        sig_header = request.headers.get("X-Hub-Signature-256", "")
        if not _verify_hmac(body, secret, sig_header):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid signature")

    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid JSON")

    event_type = payload.get("webhookEvent", "")
    issue = payload.get("issue", {})
    ticket_id = issue.get("key", "")

    log.info("webhook.jira", event_type=event_type, ticket=ticket_id)

    # Publish to event bus for live visibility
    if ticket_id:
        get_bus().publish(f"watch-{ticket_id}", ToolEvent(
            kind="status", agent="webhook",
            summary=f"Jira webhook: {event_type} on {ticket_id}",
        ))

    # Notify registered watchers
    for cb in _watchers.get("jira", []):
        try:
            await cb(ticket_id, event_type, payload)
        except Exception as exc:
            log.error("webhook.jira_handler_failed", ticket=ticket_id, error=str(exc))

    return {"received": True, "ticket": ticket_id, "event": event_type}


# ── Azure Boards ──────────────────────────────────────────────────────────────

@router.post("/azure")
async def azure_webhook(request: Request) -> dict:
    """
    Azure Boards service hook endpoint.
    Verifies secret token from QORUM_AZURE_WEBHOOK_SECRET if set.
    """
    body = await request.body()
    secret = os.environ.get("QORUM_AZURE_WEBHOOK_SECRET", "")

    if secret:
        # Azure sends the secret as a Basic auth password or in the payload — check header
        auth = request.headers.get("Authorization", "")
        token = auth.removeprefix("Basic ").strip()
        import base64
        try:
            decoded = base64.b64decode(token).decode("utf-8")
            _, payload_secret = decoded.split(":", 1)
        except Exception:
            payload_secret = token
        if not hmac.compare_digest(payload_secret, secret):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid token")

    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid JSON")

    event_type = payload.get("eventType", "")
    resource = payload.get("resource", {})
    ticket_id = str(resource.get("id", ""))

    log.info("webhook.azure", event_type=event_type, ticket=ticket_id)

    if ticket_id:
        get_bus().publish(f"watch-{ticket_id}", ToolEvent(
            kind="status", agent="webhook",
            summary=f"Azure webhook: {event_type} on #{ticket_id}",
        ))

    for cb in _watchers.get("azure", []):
        try:
            await cb(ticket_id, event_type, payload)
        except Exception as exc:
            log.error("webhook.azure_handler_failed", ticket=ticket_id, error=str(exc))

    return {"received": True, "ticket": ticket_id, "event": event_type}


# ── WhatsApp Cloud API ────────────────────────────────────────────────────────

_whatsapp_adapter = None


def set_whatsapp_adapter(adapter) -> None:
    global _whatsapp_adapter
    _whatsapp_adapter = adapter


@router.get("/whatsapp")
async def whatsapp_verify(request: Request) -> str:
    """
    WhatsApp webhook verification challenge.
    Meta sends a GET with hub.challenge; we echo it back if hub.verify_token matches.
    """
    params = dict(request.query_params)
    verify_token = os.environ.get("QORUM_WHATSAPP_VERIFY_TOKEN", "")
    if params.get("hub.verify_token") == verify_token:
        return params.get("hub.challenge", "")
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid verify token")


@router.post("/whatsapp")
async def whatsapp_webhook(request: Request) -> dict:
    """
    WhatsApp Cloud API inbound messages webhook.
    Verifies X-Hub-Signature-256 when QORUM_WHATSAPP_APP_SECRET is set.
    """
    body = await request.body()
    secret = os.environ.get("QORUM_WHATSAPP_APP_SECRET", "")

    if secret:
        sig = request.headers.get("X-Hub-Signature-256", "")
        if not _verify_hmac(body, secret, sig):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid signature")

    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid JSON")

    log.info("webhook.whatsapp", entries=len(payload.get("entry", [])))

    if _whatsapp_adapter:
        try:
            await _whatsapp_adapter.process_webhook(payload)
        except Exception as exc:
            log.error("webhook.whatsapp_handler_failed", error=str(exc))

    # Notify registered watchers
    for cb in _watchers.get("whatsapp", []):
        try:
            await cb("", "message", payload)
        except Exception as exc:
            log.error("webhook.whatsapp_watcher_failed", error=str(exc))

    return {"received": True}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _verify_hmac(body: bytes, secret: str, signature: str) -> bool:
    """Verify HMAC-SHA256 signature (GitHub/Jira style)."""
    expected = "sha256=" + hmac.new(
        secret.encode("utf-8"), body, hashlib.sha256  # type: ignore[arg-type]
    ).hexdigest()
    return hmac.compare_digest(expected, signature)
