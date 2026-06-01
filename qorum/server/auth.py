"""
Phase 10 — Simple token auth for the server.

Run tokens are scoped per run_id — only the run creator and configured admins
can approve/discard. The QORUM_SERVER_TOKEN env var is the master token for
admin access (listing runs, etc.).

In Phase 14, this gets hardened with proper auth (OAuth / JWT).
"""
from __future__ import annotations

import hashlib
import os
import secrets
from typing import Optional

from fastapi import Header, HTTPException, status

_MASTER_TOKEN: Optional[str] = None
_RUN_TOKENS: dict[str, str] = {}   # run_id → token


def get_master_token() -> str:
    global _MASTER_TOKEN
    if _MASTER_TOKEN is None:
        _MASTER_TOKEN = os.environ.get("QORUM_SERVER_TOKEN", "")
    return _MASTER_TOKEN


def issue_run_token(run_id: str) -> str:
    """Generate and store a per-run token. Return it to the caller to share via chat deep link."""
    token = secrets.token_urlsafe(24)
    _RUN_TOKENS[run_id] = token
    return token


def verify_run_token(run_id: str, token: str) -> bool:
    """Return True if token is valid for the run or is the master token."""
    master = get_master_token()
    if master and secrets.compare_digest(token, master):
        return True
    stored = _RUN_TOKENS.get(run_id, "")
    return bool(stored and secrets.compare_digest(token, stored))


async def require_run_auth(
    run_id: str,
    authorization: str = Header(default=""),
) -> str:
    """FastAPI dependency — raises 401 if token is missing/invalid."""
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        # Development fallback: allow if no master token is set
        if not get_master_token():
            return "anon"
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token")
    if not verify_run_token(run_id, token):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid token")
    return token
