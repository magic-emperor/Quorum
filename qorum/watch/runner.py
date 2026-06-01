"""
Phase 11 — quorum watch runner.

Polls a board for items matching a keyword/JQL/WIQL, builds a board Intent for
each new match, and routes it through the full pipeline:
  detect → classify → locate → plan → post approval card to channel.

Write-back events are fired at each pipeline stage.
Runs indefinitely (poll loop); a background task per project.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Optional

from qorum.adapters.base import BaseTicketAdapter, NormalizedTicket
from qorum.bot.events import ChatUser
from qorum.collaboration.intent import Intent
from qorum.core.logger import get_logger
from qorum.watch.state import WatchState

if TYPE_CHECKING:
    from qorum.config import QorumConfig

log = get_logger(__name__)


class WatchRunner:
    """
    Polls a board for new matching tickets and routes them to the pipeline.
    One instance per `quorum watch --tool=<tool> --project=<project>` invocation.
    """

    def __init__(
        self,
        adapter: BaseTicketAdapter,
        config: "QorumConfig",
        project: str,
        keyword: str = "[QORUM]",
        poll_seconds: int = 60,
        state_path: Optional[Path] = None,
        on_intent: Optional[Callable] = None,
    ) -> None:
        self._adapter = adapter
        self._config = config
        self._project = project
        self._keyword = keyword
        self._poll_seconds = poll_seconds
        self._state = WatchState(
            state_path or (Path(".quorum") / f"watch-state-{project}.json")
        )
        self._on_intent = on_intent   # async callable(Intent) → routes to pipeline
        self._running = False

    async def run_once(self) -> list[Intent]:
        """Run one poll cycle. Returns newly-processed Intents."""
        tickets = await self._fetch_matching()
        new_intents: list[Intent] = []

        for ticket in tickets:
            if self._state.is_processed(ticket.id):
                log.debug("watch.already_processed", ticket=ticket.id)
                continue

            log.info("watch.new_ticket", ticket=ticket.id, title=ticket.title[:60])
            self._state.mark_processed(ticket.id)

            bot_user = ChatUser.from_platform(
                self._adapter.platform.value, "watch-bot", "Qorum Watch"
            )
            intent = Intent.from_ticket(ticket, bot_user)
            new_intents.append(intent)

            if self._on_intent:
                try:
                    await self._on_intent(intent)
                except Exception as exc:
                    log.error("watch.pipeline_failed", ticket=ticket.id, error=str(exc))

        return new_intents

    async def run(self) -> None:
        """Poll loop — runs until stop() is called."""
        self._running = True
        log.info(
            "watch.started",
            project=self._project,
            keyword=self._keyword,
            poll_seconds=self._poll_seconds,
        )
        while self._running:
            try:
                new = await self.run_once()
                if new:
                    log.info("watch.processed", count=len(new), project=self._project)
            except Exception as exc:
                log.error("watch.poll_failed", project=self._project, error=str(exc))
            await asyncio.sleep(self._poll_seconds)

    def stop(self) -> None:
        self._running = False

    # ── Board query ───────────────────────────────────────────────────────────

    async def _fetch_matching(self) -> list[NormalizedTicket]:
        """
        Query the board for items matching the keyword in the project.
        Uses JQL for Jira, WIQL for Azure, text search for others.
        """
        try:
            return await _query_board(self._adapter, self._project, self._keyword, self._config)
        except Exception as exc:
            log.warning("watch.query_failed", project=self._project, error=str(exc))
            return []


# ── Board query helpers ───────────────────────────────────────────────────────

async def _query_board(
    adapter: BaseTicketAdapter,
    project: str,
    keyword: str,
    config: "QorumConfig",
) -> list[NormalizedTicket]:
    """
    Query the board for items matching keyword in project.
    Dispatches to the right API based on adapter type.
    """
    from qorum.adapters.base import Platform

    if adapter.platform in (Platform.JIRA_CLOUD, Platform.JIRA_SERVER):
        return await _jira_query(adapter, project, keyword, config)

    if adapter.platform == Platform.AZURE_BOARDS:
        return await _azure_query(adapter, project, keyword, config)

    if adapter.platform == Platform.GITHUB_ISSUES:
        return await _github_query(adapter, project, keyword, config)

    # Generic fallback — platforms not yet implemented return empty
    log.info("watch.query_not_implemented", platform=adapter.platform.value)
    return []


async def _jira_query(adapter, project: str, keyword: str, config) -> list[NormalizedTicket]:
    """Search Jira using JQL for items containing the keyword in the project."""
    base_url = (config.jira_cloud_base_url or config.jira_server_base_url or "").rstrip("/")
    if not base_url:
        return []

    jql = f'project = "{project}" AND text ~ "{keyword}" AND status != Done ORDER BY updated DESC'
    url = f"{base_url}/rest/api/3/search?jql={jql}&maxResults=20&fields=summary,status,description"

    try:
        data = await adapter._get(url)
        issues = data.get("issues", [])
        results = []
        for issue in issues:
            try:
                ticket = await adapter.fetch_item(
                    f"{base_url}/browse/{issue['key']}"
                )
                results.append(ticket)
            except Exception:
                pass
        return results
    except Exception as exc:
        log.warning("watch.jira_query_failed", error=str(exc))
        return []


async def _azure_query(adapter, project: str, keyword: str, config) -> list[NormalizedTicket]:
    """Search Azure Boards using WIQL."""
    org = config.azure_devops_org
    if not org:
        return []

    wiql = {
        "query": (
            f"SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '{project}' "
            f"AND [System.Description] CONTAINS '{keyword}' "
            f"AND [System.State] <> 'Closed' ORDER BY [System.ChangedDate] DESC"
        )
    }
    url = f"https://dev.azure.com/{org}/{project}/_apis/wit/wiql?api-version=7.1"

    try:
        data = await adapter._post(url, wiql)
        items = data.get("workItems", [])[:20]
        results = []
        for item in items:
            try:
                item_url = f"https://dev.azure.com/{org}/{project}/_workitems/edit/{item['id']}"
                ticket = await adapter.fetch_item(item_url)
                results.append(ticket)
            except Exception:
                pass
        return results
    except Exception as exc:
        log.warning("watch.azure_query_failed", error=str(exc))
        return []


async def _github_query(adapter, project: str, keyword: str, config) -> list[NormalizedTicket]:
    """Search GitHub issues for keyword in the repo."""
    if not config.github_token:
        return []

    # project format: "owner/repo"
    if "/" not in project:
        return []

    url = f"https://api.github.com/search/issues?q={keyword}+repo:{project}+is:open+is:issue&per_page=20"

    try:
        data = await adapter._get(url)
        items = data.get("items", [])[:20]
        results = []
        for item in items:
            try:
                ticket = await adapter.fetch_item(item["html_url"])
                results.append(ticket)
            except Exception:
                pass
        return results
    except Exception as exc:
        log.warning("watch.github_query_failed", error=str(exc))
        return []
