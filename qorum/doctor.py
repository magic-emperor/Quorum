"""
qorum doctor — pre-flight health check.

Validates every configured integration before the server starts:
AI providers, bot tokens, database, board adapters, output directory.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from qorum.config import QorumConfig

_W = 42   # label column width


def _row(label: str, detail: str, ok: bool) -> None:
    status = "PASS" if ok else "FAIL"
    print(f"  {label:<{_W}} {detail:<20}  {status}")


async def run(config: "QorumConfig") -> bool:
    """Run all checks. Returns True if everything passes."""
    print("\nQorum Doctor\n" + "-" * 72)
    all_ok = True

    # ── AI providers ─────────────────────────────────────────────────────────
    from qorum.providers.registry import ProviderRegistry
    registry = ProviderRegistry(config)
    configured = registry.configured_providers()
    if configured:
        _row("AI provider", configured[0], True)
    else:
        _row("AI provider", "no key set", False)
        all_ok = False

    # ── Bot tokens ───────────────────────────────────────────────────────────
    bot_checks = [
        ("Teams", config.qorum_teams_app_id and config.qorum_teams_app_password),
        ("Slack", config.slack_bot_token and config.slack_app_token),
        ("Discord", config.discord_bot_token),
        ("Telegram", config.telegram_bot_token),
        ("WhatsApp", config.qorum_whatsapp_token and config.qorum_whatsapp_phone_id),
    ]
    any_bot = False
    for name, has_token in bot_checks:
        if has_token:
            _row(f"Bot token", name, True)
            any_bot = True
    if not any_bot:
        _row("Bot token", "none configured", False)
        all_ok = False

    # ── Database ─────────────────────────────────────────────────────────────
    try:
        import aiosqlite
        db_path = config.qorum_db_path
        async with aiosqlite.connect(db_path) as db:
            await db.execute("SELECT 1")
        _row("Database", f"sqlite {db_path.name}", True)
    except Exception as exc:
        _row("Database", f"error: {exc}", False)
        all_ok = False

    # ── Board adapters ────────────────────────────────────────────────────────
    board_checks = [
        ("Jira Cloud",    config.jira_cloud_email and config.jira_cloud_api_token),
        ("Jira Server",   config.jira_server_pat),
        ("Azure Boards",  config.azure_devops_pat),
        ("GitHub Issues", config.github_token),
        ("Linear",        config.linear_api_key),
    ]
    for name, has_token in board_checks:
        if has_token:
            _row("Board", name, True)

    # ── Output directory ─────────────────────────────────────────────────────
    try:
        config.ensure_output_dir()
        test_file = config.qorum_output_path / ".doctor_write_test"
        test_file.write_text("ok")
        test_file.unlink()
        _row("Output dir", str(config.qorum_output_path), True)
    except Exception as exc:
        _row("Output dir", f"not writable: {exc}", False)
        all_ok = False

    # ── Summary ───────────────────────────────────────────────────────────────
    print("-" * 72)
    if all_ok:
        print("  All checks passed. Run: qorum\n")
    else:
        print("  Some checks failed. Fix the issues above, then run: qorum\n")

    return all_ok
