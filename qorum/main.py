"""
Qorum — Application Entry Point

Usage:
    python main.py                  # Start all configured bots
    python main.py --platform slack # Start Slack bot only
    python main.py --test-url <url> # Test URL detection + context fetch (no bot)
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from qorum.core.logger import configure_logging, get_logger

log = get_logger(__name__)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="qorum",
        description="Qorum — AI agent for team chat and issue boards",
    )
    subparsers = parser.add_subparsers(dest="command")

    # ── qorum bot ─────────────────────────────────────────────────────────────
    bot_p = subparsers.add_parser("bot", help="Start the chat bot on one or more platforms")
    bot_p.add_argument(
        "--platform",
        choices=["slack", "discord", "telegram", "teams", "whatsapp", "all"],
        default="all",
        help="Which platform to start (default: all configured)",
    )
    bot_p.add_argument(
        "--log-level",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        default=None,
    )

    # ── qorum serve ───────────────────────────────────────────────────────────
    serve_p = subparsers.add_parser("serve", help="Start the visibility server (WS + web dashboard)")
    serve_p.add_argument("--host", default="127.0.0.1")
    serve_p.add_argument("--port", type=int, default=7432)
    serve_p.add_argument("--reload", action="store_true")
    serve_p.add_argument("--log-level", choices=["DEBUG", "INFO", "WARNING", "ERROR"], default=None)

    # ── qorum watch ───────────────────────────────────────────────────────────
    watch_p = subparsers.add_parser("watch", help="Watch a board project for [QORUM] items")
    watch_p.add_argument("--tool", required=True, choices=["jira", "azure", "github"], help="Board platform")
    watch_p.add_argument("--project", required=True, help="Project key or owner/repo")
    watch_p.add_argument("--keyword", default="[QORUM]", help="Keyword to watch for (default: [QORUM])")
    watch_p.add_argument("--poll", type=int, default=60, metavar="SECONDS")
    watch_p.add_argument("--log-level", choices=["DEBUG", "INFO", "WARNING", "ERROR"], default=None)

    # ── qorum test-url ────────────────────────────────────────────────────────
    url_p = subparsers.add_parser("test-url", help="Test URL detection without starting a bot")
    url_p.add_argument("url", help="Full ticket URL to test")
    url_p.add_argument("--log-level", choices=["DEBUG", "INFO", "WARNING", "ERROR"], default=None)

    # ── Legacy top-level flags (backward compat with old entry point) ─────────
    parser.add_argument(
        "--platform",
        choices=["slack", "discord", "telegram", "all"],
        default=None,
    )
    parser.add_argument("--test-url", metavar="URL", default=None)
    parser.add_argument(
        "--log-level",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        default=None,
    )

    return parser.parse_args()


async def _start_watch(args) -> None:
    """Start a quorum watch runner for a board project."""
    from qorum.config import settings
    from qorum.watch.runner import WatchRunner

    tool_adapters = {
        "jira":   lambda: __import__("qorum.adapters.jira_cloud", fromlist=["JiraCloudAdapter"]).JiraCloudAdapter(settings),
        "azure":  lambda: __import__("qorum.adapters.azure_boards", fromlist=["AzureBoardsAdapter"]).AzureBoardsAdapter(settings),
        "github": lambda: __import__("qorum.adapters.github_issues", fromlist=["GitHubIssuesAdapter"]).GitHubIssuesAdapter(settings),
    }
    adapter = tool_adapters[args.tool]()
    runner = WatchRunner(
        adapter=adapter,
        config=settings,
        project=args.project,
        keyword=args.keyword,
        poll_seconds=args.poll,
    )
    print(f"\nQorum Watch — {args.tool} project {args.project!r} (keyword: {args.keyword})")
    print(f"Polling every {args.poll}s. Ctrl+C to stop.\n")
    await runner.run()


async def test_url(url: str) -> None:
    """Developer utility: test URL detection and context fetch without starting a bot."""
    from qorum.adapters.detector import UnsupportedPlatformError, detect_platform, extract_ticket_id_from_url
    from qorum.config import settings

    print(f"\nQorum URL Test\n{'=' * 40}")
    print(f"URL: {url}")

    try:
        platform = detect_platform(url, override=settings.qorum_platform_override)
        ticket_id = extract_ticket_id_from_url(url, platform)
        print(f"Platform: {platform.value}")
        print(f"Ticket ID: {ticket_id}")
        print(f"Token configured: {settings.has_platform_token(platform.value)}")
        print("\nURL detection: OK")
    except UnsupportedPlatformError as exc:
        print(f"URL detection FAILED: {exc}")
        sys.exit(1)


def _build_bots(platform: str, orchestrator) -> list:
    """Instantiate all configured bot adapters for the requested platform(s)."""
    from qorum.config import settings
    from qorum.bot.slack_adapter import SlackAdapter
    from qorum.bot.discord_adapter import DiscordAdapter
    from qorum.bot.telegram_adapter import TelegramAdapter

    want_slack    = platform in ("slack", "all")
    want_discord  = platform in ("discord", "all")
    want_telegram = platform in ("telegram", "all")

    bots = []

    if want_slack and settings.slack_bot_token and settings.slack_app_token:
        bots.append(SlackAdapter(settings, orchestrator))
        log.info("qorum.bot.registered", platform="slack")
    elif want_slack:
        log.warning("qorum.bot.skipped", platform="slack", reason="SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set")

    if want_discord and settings.discord_bot_token:
        bots.append(DiscordAdapter(settings, orchestrator))
        log.info("qorum.bot.registered", platform="discord")
    elif want_discord:
        log.warning("qorum.bot.skipped", platform="discord", reason="DISCORD_BOT_TOKEN not set")

    if want_telegram and settings.telegram_bot_token:
        bots.append(TelegramAdapter(settings, orchestrator))
        log.info("qorum.bot.registered", platform="telegram")
    elif want_telegram:
        log.warning("qorum.bot.skipped", platform="telegram", reason="TELEGRAM_BOT_TOKEN not set")

    want_teams = platform in ("teams", "all")
    if want_teams and settings.qorum_teams_app_id and settings.qorum_teams_app_password:
        from qorum.bot.teams_adapter import TeamsAdapter as _TeamsAdapter
        teams_bot = _TeamsAdapter(settings, orchestrator)
        bots.append(teams_bot)
        # Register with the visibility server for /api/messages
        try:
            from qorum.server.app import set_teams_adapter
            set_teams_adapter(teams_bot)
        except ImportError:
            pass
        log.info("qorum.bot.registered", platform="teams")
    elif want_teams and platform == "teams":
        log.warning("qorum.bot.skipped", platform="teams",
                    reason="QORUM_TEAMS_APP_ID or QORUM_TEAMS_APP_PASSWORD not set")

    want_whatsapp = platform in ("whatsapp", "all")
    if want_whatsapp and settings.qorum_whatsapp_token and settings.qorum_whatsapp_phone_id:
        from qorum.bot.whatsapp_adapter import WhatsAppAdapter as _WAAdapter
        wa_bot = _WAAdapter(settings, orchestrator)
        bots.append(wa_bot)
        try:
            from qorum.server.webhooks import set_whatsapp_adapter
            set_whatsapp_adapter(wa_bot)
        except ImportError:
            pass
        log.info("qorum.bot.registered", platform="whatsapp")
    elif want_whatsapp and platform == "whatsapp":
        log.warning("qorum.bot.skipped", platform="whatsapp",
                    reason="QORUM_WHATSAPP_TOKEN or QORUM_WHATSAPP_PHONE_ID not set")

    return bots


async def start_bots(platform: str) -> None:
    """Start the configured bot platform(s)."""
    from qorum.config import settings
    from qorum.core.orchestrator import QorumOrchestrator

    warnings = settings.validate_tokens_on_startup()
    for w in warnings:
        log.warning("qorum.startup.warning", message=w)

    settings.ensure_output_dir()

    # Initialise orchestrator + DB
    orchestrator = QorumOrchestrator(settings)
    await orchestrator.init()
    log.info("qorum.startup", output_path=str(settings.qorum_output_path))

    bots = _build_bots(platform, orchestrator)

    if not bots:
        print(
            "\nNo bot tokens configured. Set at least one of:\n"
            "  SLACK_BOT_TOKEN + SLACK_APP_TOKEN\n"
            "  DISCORD_BOT_TOKEN\n"
            "  TELEGRAM_BOT_TOKEN\n\n"
            "Use --test-url <url> to test URL detection without a bot.\n"
        )
        return

    print(f"\nQorum starting — {len(bots)} bot(s) active")
    print(f"Output folder: {settings.qorum_output_path}\n")

    # Start all bots concurrently
    try:
        await asyncio.gather(*(bot.start() for bot in bots))
    except (KeyboardInterrupt, asyncio.CancelledError):
        log.info("qorum.shutdown.requested")
    finally:
        await asyncio.gather(*(bot.stop() for bot in bots), return_exceptions=True)
        log.info("qorum.shutdown.complete")


def main() -> None:
    args = parse_args()

    from qorum.config import settings
    log_level = args.log_level or settings.qorum_log_level
    configure_logging(log_level)

    command = getattr(args, "command", None)

    if command == "bot":
        asyncio.run(start_bots(args.platform))
    elif command == "serve":
        import uvicorn
        from qorum.server.event_bus import init_bus
        from qorum.config import settings
        sessions_dir = settings.qorum_output_path / "context" / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)
        init_bus(sessions_dir)
        uvicorn.run(
            "qorum.server.app:app",
            host=args.host,
            port=args.port,
            reload=args.reload,
            log_level=(args.log_level or "info").lower(),
        )
    elif command == "watch":
        asyncio.run(_start_watch(args))
    elif command == "test-url":
        asyncio.run(test_url(args.url))
    elif args.test_url:          # legacy flag
        asyncio.run(test_url(args.test_url))
    elif args.platform:          # legacy flag
        asyncio.run(start_bots(args.platform))
    else:
        # Default: start all bots
        asyncio.run(start_bots("all"))


if __name__ == "__main__":
    main()
