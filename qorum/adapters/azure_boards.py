"""
Azure Boards adapter — fetches work items via Azure DevOps REST API v7.1.

Auth: Personal Access Token (PAT) with scope "Work Items (Read)".
Set AZURE_DEVOPS_PAT in .env.

API refs:
  Work item:  GET /wit/workitems/{id}?$expand=all&api-version=7.1
  Comments:   GET /wit/workitems/{id}/comments?api-version=7.1-preview.3
  Relations:  Included in $expand=relations
  Hierarchy:  GET /_odata/v3.0/WorkItems?$expand=Children&$filter=WorkItemId eq {id}
"""
from __future__ import annotations

import base64
import re
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

import aiohttp

from qorum.adapters.base import (
    AdapterError,
    AuthError,
    BaseTicketAdapter,
    Comment,
    LinkedItem,
    NormalizedTicket,
    Platform,
    PrivateTicketError,
    RateLimitError,
    TicketNotFoundError,
)
from qorum.core.logger import get_logger
from qorum.core.retry import with_retry

if TYPE_CHECKING:
    from qorum.config import QorumConfig

log = get_logger(__name__)

# Azure Boards URL pattern: dev.azure.com/{org}/{project}/_workitems/edit/{id}
_URL_RE = re.compile(
    r"https?://(?:dev\.azure\.com/(?P<org1>[^/]+)|(?P<org2>[^.]+)\.visualstudio\.com)"
    r"/(?P<project>[^/]+)/_workitems/edit/(?P<id>\d+)",
    re.IGNORECASE,
)


class AzureBoardsAdapter(BaseTicketAdapter):
    """Fetches Azure Boards work items with full context graph traversal."""

    def __init__(self, config: "QorumConfig") -> None:
        self._config = config
        self._session: aiohttp.ClientSession | None = None

    @property
    def platform(self) -> Platform:
        return Platform.AZURE_BOARDS

    def validate_url(self, url: str) -> bool:
        return bool(_URL_RE.match(url))

    async def fetch_item(self, url: str) -> NormalizedTicket:
        match = _URL_RE.match(url)
        if not match:
            raise AdapterError(f"Invalid Azure Boards URL: {url}")

        org = match.group("org1") or match.group("org2")
        project = match.group("project")
        item_id = match.group("id")

        log.info("azure_boards.fetch_item", org=org, project=project, item_id=item_id)

        raw = await self._get_work_item(org, project, item_id)
        comments = await self.fetch_comments_raw(org, project, item_id)

        # Build parent (fetch 1 level up)
        parent: NormalizedTicket | None = None
        parent_id = self._extract_parent_id(raw)
        if parent_id:
            try:
                parent_raw = await self._get_work_item(org, project, str(parent_id))
                parent = self._normalize(parent_raw, [], [], [], org, project)
            except Exception:
                log.warning("azure_boards.parent_fetch_failed", parent_id=parent_id)

        # Build children (fetch 1 level down, capped at config limit)
        children: list[NormalizedTicket] = []
        child_ids = self._extract_child_ids(raw)
        for child_id in child_ids[: self._config.qorum_max_children]:
            try:
                child_raw = await self._get_work_item(org, project, str(child_id))
                children.append(self._normalize(child_raw, [], [], [], org, project))
            except Exception:
                log.warning("azure_boards.child_fetch_failed", child_id=child_id)

        linked = self._extract_linked_items(raw)

        return self._normalize(raw, comments, children, linked, org, project, parent=parent)

    async def fetch_parent(self, item_id: str) -> NormalizedTicket | None:
        # Called standalone; full context already fetched in fetch_item
        return None

    async def fetch_children(self, item_id: str) -> list[NormalizedTicket]:
        return []

    async def fetch_comments(self, item_id: str) -> list[Comment]:
        return []

    async def fetch_linked_items(self, item_id: str) -> list[LinkedItem]:
        return []

    # ── Phase 11: Write-back ──────────────────────────────────────────────────

    async def post_comment(self, ticket_id: str, body: str) -> None:
        """Post a comment to an Azure Boards work item."""
        cfg = self._config
        if not cfg.azure_devops_org or not cfg.azure_devops_pat:
            log.warning("azure.post_comment.no_creds", ticket=ticket_id)
            return
        org = cfg.azure_devops_org
        # item_id may be "PROJECT-123" or just "123"
        numeric_id = ticket_id.split("-")[-1] if "-" in ticket_id else ticket_id
        project = ticket_id.split("-")[0] if "-" in ticket_id else "default"
        url = (
            f"https://dev.azure.com/{org}/{project}/_apis/wit/workItems/{numeric_id}/comments"
            f"?api-version=7.1-preview.3"
        )
        import json
        try:
            await self._post(url, {"text": body})
            log.info("azure.comment_posted", ticket=ticket_id)
        except Exception as exc:
            log.warning("azure.post_comment_failed", ticket=ticket_id, error=str(exc))

    async def update_status(self, ticket_id: str, status: str) -> None:
        """Update the State field of an Azure Boards work item."""
        cfg = self._config
        if not cfg.azure_devops_org or not cfg.azure_devops_pat:
            return
        org = cfg.azure_devops_org
        numeric_id = ticket_id.split("-")[-1] if "-" in ticket_id else ticket_id
        project = ticket_id.split("-")[0] if "-" in ticket_id else "default"
        url = (
            f"https://dev.azure.com/{org}/{project}/_apis/wit/workItems/{numeric_id}"
            f"?api-version=7.1"
        )
        import json
        patch = [{"op": "replace", "path": "/fields/System.State", "value": status}]
        try:
            await self._patch(url, patch)
            log.info("azure.status_updated", ticket=ticket_id, status=status)
        except Exception as exc:
            log.warning("azure.update_status_failed", ticket=ticket_id, error=str(exc))

    async def _post(self, url: str, payload: dict) -> dict:
        import json
        session = self._get_session()
        async with session.post(url, json=payload) as resp:
            resp.raise_for_status()
            text = await resp.text()
            return json.loads(text) if text.strip() else {}

    async def _patch(self, url: str, payload: list) -> dict:
        import json
        session = self._get_session()
        headers = {"Content-Type": "application/json-patch+json"}
        data = json.dumps(payload)
        async with session.request("PATCH", url, data=data, headers=headers) as resp:
            resp.raise_for_status()
            text = await resp.text()
            return json.loads(text) if text.strip() else {}

    # ── Internal helpers ──────────────────────────────────────────────────────

    async def _get_work_item(self, org: str, project: str, item_id: str) -> dict[str, Any]:
        url = (
            f"https://dev.azure.com/{org}/{project}/_apis/wit/workitems/{item_id}"
            f"?$expand=all&api-version=7.1"
        )
        return await with_retry(
            lambda: self._get(url),
            label=f"azure_boards.workitem.{item_id}",
        )

    async def fetch_comments_raw(self, org: str, project: str, item_id: str) -> list[dict]:
        url = (
            f"https://dev.azure.com/{org}/{project}/_apis/wit/workitems/{item_id}"
            f"/comments?api-version=7.1-preview.3"
        )
        try:
            data = await with_retry(lambda: self._get(url), label=f"azure_boards.comments.{item_id}")
            return data.get("comments", [])
        except Exception:
            log.warning("azure_boards.comments_fetch_failed", item_id=item_id)
            return []

    async def _get(self, url: str) -> dict[str, Any]:
        session = await self._get_session()
        async with session.get(url) as resp:
            if resp.status == 401:
                raise AuthError(
                    "Azure Boards authentication failed. "
                    "Check that AZURE_DEVOPS_PAT is set and has 'Work Items (Read)' scope."
                )
            if resp.status == 403:
                raise PrivateTicketError(
                    "Access denied. This work item is in a project your PAT cannot access."
                )
            if resp.status == 404:
                raise TicketNotFoundError(
                    "Work item not found. It may have been deleted or the URL is incorrect."
                )
            if resp.status == 429:
                retry_after = int(resp.headers.get("Retry-After", 30))
                raise RateLimitError(
                    f"Azure Boards rate limit hit. Retrying in {retry_after}s.",
                    retry_after=retry_after,
                )
            if resp.status >= 400:
                text = await resp.text()
                raise AdapterError(f"Azure Boards API error {resp.status}: {text[:200]}")
            return await resp.json()

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            pat = self._config.azure_devops_pat or ""
            token = base64.b64encode(f":{pat}".encode()).decode()
            self._session = aiohttp.ClientSession(
                headers={
                    "Authorization": f"Basic {token}",
                    "Content-Type": "application/json",
                }
            )
        return self._session

    def _normalize(
        self,
        raw: dict[str, Any],
        comments_raw: list[dict],
        children: list[NormalizedTicket],
        linked: list[LinkedItem],
        org: str,
        project: str,
        parent: NormalizedTicket | None = None,
    ) -> NormalizedTicket:
        fields = raw.get("fields", {})
        item_id = str(raw.get("id", ""))

        # Acceptance criteria lives in different fields across process templates
        ac_text = (
            fields.get("Microsoft.VSTS.Common.AcceptanceCriteria")
            or fields.get("System.Description", "")
            or ""
        )
        acceptance_criteria = self._parse_html_list(ac_text)
        description = self._strip_html(fields.get("System.Description", "") or "")

        comments = [
            Comment(
                author=c.get("createdBy", {}).get("displayName", "Unknown"),
                body=self._strip_html(c.get("text", "") or ""),
                created_at=self._parse_dt(c.get("createdDate")),
            )
            for c in comments_raw
        ]

        return NormalizedTicket(
            platform=Platform.AZURE_BOARDS,
            id=item_id,
            url=f"https://dev.azure.com/{org}/{project}/_workitems/edit/{item_id}",
            title=fields.get("System.Title", "Untitled"),
            description=description,
            acceptance_criteria=acceptance_criteria,
            item_type=fields.get("System.WorkItemType", "Task"),
            status=fields.get("System.State", "Unknown"),
            assignee=(fields.get("System.AssignedTo") or {}).get("displayName"),
            tags=[t.strip() for t in (fields.get("System.Tags") or "").split(";") if t.strip()],
            priority=str(fields.get("Microsoft.VSTS.Common.Priority", "")) or None,
            story_points=fields.get("Microsoft.VSTS.Scheduling.StoryPoints")
                         or fields.get("Microsoft.VSTS.Scheduling.Effort"),
            sprint=fields.get("System.IterationPath"),
            parent=parent,
            children=children,
            linked_items=linked,
            comments=comments,
            created_at=self._parse_dt(fields.get("System.CreatedDate")),
            updated_at=self._parse_dt(fields.get("System.ChangedDate")),
            raw=raw,
        )

    def _extract_parent_id(self, raw: dict) -> int | None:
        for rel in raw.get("relations", []) or []:
            if rel.get("rel") == "System.LinkTypes.Hierarchy-Reverse":
                url = rel.get("url", "")
                m = re.search(r"/(\d+)$", url)
                if m:
                    return int(m.group(1))
        return None

    def _extract_child_ids(self, raw: dict) -> list[int]:
        ids = []
        for rel in raw.get("relations", []) or []:
            if rel.get("rel") == "System.LinkTypes.Hierarchy-Forward":
                url = rel.get("url", "")
                m = re.search(r"/(\d+)$", url)
                if m:
                    ids.append(int(m.group(1)))
        return ids

    def _extract_linked_items(self, raw: dict) -> list[LinkedItem]:
        rel_type_map = {
            "System.LinkTypes.Dependency-Forward": "blocks",
            "System.LinkTypes.Dependency-Reverse": "is blocked by",
            "System.LinkTypes.Related": "related",
            "System.LinkTypes.Duplicate-Forward": "duplicate of",
            "System.LinkTypes.Duplicate-Reverse": "duplicated by",
        }
        items = []
        for rel in raw.get("relations", []) or []:
            rel_type = rel.get("rel", "")
            relationship = rel_type_map.get(rel_type)
            if relationship:
                url = rel.get("url", "")
                m = re.search(r"/(\d+)$", url)
                item_id = m.group(1) if m else url
                items.append(LinkedItem(
                    id=item_id,
                    title=rel.get("attributes", {}).get("comment", f"Work item {item_id}"),
                    url=url,
                    relationship=relationship,
                ))
        return items

    @staticmethod
    def _parse_dt(value: str | None) -> datetime:
        if not value:
            return datetime.now(timezone.utc)
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except Exception:
            return datetime.now(timezone.utc)

    @staticmethod
    def _strip_html(html: str) -> str:
        """Remove HTML tags from Azure Boards rich text fields."""
        return re.sub(r"<[^>]+>", "", html).strip()

    @staticmethod
    def _parse_html_list(html: str) -> list[str]:
        """Extract list items from HTML acceptance criteria fields."""
        items = re.findall(r"<li[^>]*>(.*?)</li>", html, re.IGNORECASE | re.DOTALL)
        if items:
            return [re.sub(r"<[^>]+>", "", item).strip() for item in items if item.strip()]
        # Fallback: split by newlines if no list tags
        plain = re.sub(r"<[^>]+>", "", html).strip()
        return [line.strip() for line in plain.splitlines() if line.strip()]
