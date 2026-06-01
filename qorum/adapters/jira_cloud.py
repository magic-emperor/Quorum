"""
Jira Cloud adapter — fetches issues via Atlassian REST API v3.

Auth (Cloud):  Email + API token (Basic auth, base64 encoded)
Auth (Server): Personal Access Token (Bearer token)

Set in .env:
  Cloud:  JIRA_CLOUD_EMAIL, JIRA_CLOUD_API_TOKEN, JIRA_CLOUD_BASE_URL
  Server: JIRA_SERVER_PAT, JIRA_SERVER_BASE_URL

API refs:
  Issue:    GET /rest/api/3/issue/{key}?expand=renderedFields,names,changelog
  Comments: GET /rest/api/3/issue/{key}/comment
  Links:    Embedded in issue.fields.issuelinks
  Epic:     issue.fields.parent (next-gen) or customfield_10014 (classic)
  Children: GET /rest/api/3/search?jql=parent={key}
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

_CLOUD_URL_RE = re.compile(r"https?://(?P<org>[^.]+)\.atlassian\.net/browse/(?P<key>[A-Z][A-Z0-9]+-\d+)", re.IGNORECASE)
_SERVER_URL_RE = re.compile(r"https?://(?P<host>[^/]+)/browse/(?P<key>[A-Z][A-Z0-9]+-\d+)", re.IGNORECASE)


class JiraCloudAdapter(BaseTicketAdapter):
    """
    Fetches Jira Cloud or Jira Server issues with full context.
    The same class handles both — auth method differs.
    """

    def __init__(self, config: "QorumConfig") -> None:
        self._config = config
        self._session: aiohttp.ClientSession | None = None

    @property
    def platform(self) -> Platform:
        return Platform.JIRA_CLOUD

    def validate_url(self, url: str) -> bool:
        return bool(_CLOUD_URL_RE.match(url) or _SERVER_URL_RE.match(url))

    def _parse_url(self, url: str) -> tuple[str, str]:
        """Returns (base_url, issue_key)."""
        m = _CLOUD_URL_RE.match(url)
        if m:
            return f"https://{m.group('org')}.atlassian.net", m.group("key").upper()
        m = _SERVER_URL_RE.match(url)
        if m:
            base = self._config.jira_server_base_url or f"https://{m.group('host')}"
            return base, m.group("key").upper()
        raise AdapterError(f"Invalid Jira URL: {url}")

    async def fetch_item(self, url: str) -> NormalizedTicket:
        base_url, key = self._parse_url(url)
        log.info("jira.fetch_item", key=key, base_url=base_url)

        raw = await with_retry(
            lambda: self._get_issue(base_url, key),
            label=f"jira.issue.{key}",
        )
        comments_raw = await self._get_comments(base_url, key)

        # Parent
        parent: NormalizedTicket | None = None
        parent_key = self._extract_parent_key(raw)
        if parent_key:
            try:
                parent_raw = await self._get_issue(base_url, parent_key)
                parent = self._normalize(parent_raw, [], [], [], base_url)
            except Exception:
                log.warning("jira.parent_fetch_failed", parent_key=parent_key)

        # Children (sub-tasks + next-gen children)
        children: list[NormalizedTicket] = []
        child_keys = self._extract_child_keys(raw)

        # Also fetch via JQL for epics (children not always in issue.fields)
        if raw.get("fields", {}).get("issuetype", {}).get("name", "").lower() in ("epic", "initiative"):
            jql_children = await self._search_children_by_jql(base_url, key)
            child_keys = list(dict.fromkeys(child_keys + jql_children))  # dedup, preserve order

        for child_key in child_keys[: self._config.qorum_max_children]:
            try:
                child_raw = await self._get_issue(base_url, child_key)
                children.append(self._normalize(child_raw, [], [], [], base_url))
            except Exception:
                log.warning("jira.child_fetch_failed", child_key=child_key)

        linked = self._extract_linked_items(raw, base_url)
        return self._normalize(raw, comments_raw, children, linked, base_url, parent=parent)

    async def fetch_parent(self, item_id: str) -> NormalizedTicket | None:
        return None

    async def fetch_children(self, item_id: str) -> list[NormalizedTicket]:
        return []

    async def fetch_comments(self, item_id: str) -> list[Comment]:
        return []

    async def fetch_linked_items(self, item_id: str) -> list[LinkedItem]:
        return []

    # ── Phase 11: Write-back ──────────────────────────────────────────────────

    async def post_comment(self, ticket_id: str, body: str) -> None:
        """Post a Markdown comment to a Jira issue (ADF-wrapped for Cloud)."""
        base_url, key = ticket_id, ticket_id   # ticket_id may be a key like PAY-123
        # Determine base_url from config
        if self._config.jira_cloud_base_url:
            base_url = self._config.jira_cloud_base_url.rstrip("/")
        elif self._config.jira_server_base_url:
            base_url = self._config.jira_server_base_url.rstrip("/")
        else:
            log.warning("jira.post_comment.no_base_url", ticket=ticket_id)
            return
        url = f"{base_url}/rest/api/3/issue/{key}/comment"
        payload = {
            "body": {
                "type": "doc",
                "version": 1,
                "content": [{"type": "paragraph", "content": [{"type": "text", "text": body}]}]
            }
        }
        try:
            await self._post(url, payload)
            log.info("jira.comment_posted", ticket=ticket_id)
        except Exception as exc:
            log.warning("jira.post_comment_failed", ticket=ticket_id, error=str(exc))

    async def update_status(self, ticket_id: str, status: str) -> None:
        """Transition a Jira issue to a new status by name (looks up transition id)."""
        if not self._config.jira_cloud_base_url and not self._config.jira_server_base_url:
            return
        base_url = (self._config.jira_cloud_base_url or self._config.jira_server_base_url or "").rstrip("/")
        try:
            transitions_url = f"{base_url}/rest/api/3/issue/{ticket_id}/transitions"
            data = await self._get(transitions_url)
            transitions = data.get("transitions", [])
            match = next(
                (t for t in transitions if t.get("name", "").lower() == status.lower()),
                None
            )
            if not match:
                log.warning("jira.transition_not_found", ticket=ticket_id, status=status,
                            available=[t.get("name") for t in transitions])
                return
            await self._post(
                f"{base_url}/rest/api/3/issue/{ticket_id}/transitions",
                {"transition": {"id": match["id"]}}
            )
            log.info("jira.status_updated", ticket=ticket_id, status=status)
        except Exception as exc:
            log.warning("jira.update_status_failed", ticket=ticket_id, error=str(exc))

    async def _post(self, url: str, payload: dict) -> dict:
        import json
        session = await self._get_session()
        headers = await self._auth_headers()
        headers["Content-Type"] = "application/json"
        async with session.post(url, data=json.dumps(payload), headers=headers) as resp:
            resp.raise_for_status()
            text = await resp.text()
            return json.loads(text) if text.strip() else {}

    # ── Internal helpers ──────────────────────────────────────────────────────

    async def _get_issue(self, base_url: str, key: str) -> dict[str, Any]:
        url = f"{base_url}/rest/api/3/issue/{key}?expand=renderedFields,names"
        return await self._get(url)

    async def _get_comments(self, base_url: str, key: str) -> list[dict]:
        url = f"{base_url}/rest/api/3/issue/{key}/comment?maxResults=50&orderBy=created"
        try:
            data = await with_retry(lambda: self._get(url), label=f"jira.comments.{key}")
            return data.get("comments", [])
        except Exception:
            log.warning("jira.comments_fetch_failed", key=key)
            return []

    async def _search_children_by_jql(self, base_url: str, epic_key: str) -> list[str]:
        jql = f'"Epic Link" = {epic_key} OR parent = {epic_key}'
        url = f"{base_url}/rest/api/3/search?jql={jql}&fields=key&maxResults=50"
        try:
            data = await with_retry(lambda: self._get(url), label=f"jira.jql.{epic_key}")
            return [issue["key"] for issue in data.get("issues", [])]
        except Exception:
            return []

    async def _get(self, url: str) -> dict[str, Any]:
        session = await self._get_session(url)
        async with session.get(url) as resp:
            if resp.status == 401:
                raise AuthError(
                    "Jira authentication failed. "
                    "Check JIRA_CLOUD_EMAIL + JIRA_CLOUD_API_TOKEN (or JIRA_SERVER_PAT)."
                )
            if resp.status == 403:
                raise PrivateTicketError("Access denied. Check your Jira token permissions.")
            if resp.status == 404:
                raise TicketNotFoundError("Issue not found. The key may be wrong or the project deleted.")
            if resp.status == 429:
                retry_after = int(resp.headers.get("Retry-After", 30))
                raise RateLimitError(f"Jira rate limit hit. Retrying in {retry_after}s.", retry_after=retry_after)
            if resp.status >= 400:
                text = await resp.text()
                raise AdapterError(f"Jira API error {resp.status}: {text[:200]}")
            return await resp.json()

    async def _get_session(self, url: str) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            # Cloud: email + API token → Basic auth
            # Server: PAT → Bearer auth
            parsed = urlparse(url)
            is_cloud = "atlassian.net" in parsed.netloc

            if is_cloud and self._config.jira_cloud_email and self._config.jira_cloud_api_token:
                creds = f"{self._config.jira_cloud_email}:{self._config.jira_cloud_api_token}"
                token = base64.b64encode(creds.encode()).decode()
                headers = {"Authorization": f"Basic {token}", "Accept": "application/json"}
            elif self._config.jira_server_pat:
                headers = {"Authorization": f"Bearer {self._config.jira_server_pat}", "Accept": "application/json"}
            else:
                raise AuthError("No Jira credentials configured. Set JIRA_CLOUD_EMAIL + JIRA_CLOUD_API_TOKEN or JIRA_SERVER_PAT.")

            self._session = aiohttp.ClientSession(headers=headers)
        return self._session

    def _normalize(
        self,
        raw: dict[str, Any],
        comments_raw: list[dict],
        children: list[NormalizedTicket],
        linked: list[LinkedItem],
        base_url: str,
        parent: NormalizedTicket | None = None,
    ) -> NormalizedTicket:
        fields = raw.get("fields", {})
        key = raw.get("key", "")

        # Acceptance criteria — often in description or a custom field
        description = self._adf_to_text(fields.get("description") or {})
        # customfield_10155 is the standard AC field; 10016 is story points on many Jira configs.
        # Only treat a field as an ADF document if it's a dict (not a number/string).
        ac_field = fields.get("customfield_10155")
        if not isinstance(ac_field, dict):
            ac_field = None
        acceptance_criteria = (
            self._adf_to_list(ac_field) if ac_field
            else self._extract_ac_from_description(description)
        )

        comments = [
            Comment(
                author=(c.get("author") or {}).get("displayName", "Unknown"),
                body=self._adf_to_text(c.get("body") or {}),
                created_at=self._parse_dt(c.get("created")),
                updated_at=self._parse_dt(c.get("updated")),
            )
            for c in comments_raw
        ]

        story_points = (
            fields.get("story_points")
            or fields.get("customfield_10016")   # Classic SP field
            or fields.get("customfield_10028")   # Story points (some configs)
        )
        try:
            story_points = int(float(story_points)) if story_points else None
        except (TypeError, ValueError):
            story_points = None

        sprint_field = fields.get("customfield_10020") or []
        sprint_name = None
        if isinstance(sprint_field, list) and sprint_field:
            sprint_name = sprint_field[-1].get("name")

        return NormalizedTicket(
            platform=Platform.JIRA_CLOUD,
            id=key,
            url=f"{base_url}/browse/{key}",
            title=fields.get("summary", "Untitled"),
            description=description,
            acceptance_criteria=acceptance_criteria,
            item_type=(fields.get("issuetype") or {}).get("name", "Story"),
            status=(fields.get("status") or {}).get("name", "Unknown"),
            assignee=(fields.get("assignee") or {}).get("displayName"),
            tags=[label for label in (fields.get("labels") or [])],
            priority=(fields.get("priority") or {}).get("name"),
            story_points=story_points,
            sprint=sprint_name,
            parent=parent,
            children=children,
            linked_items=linked,
            comments=comments,
            created_at=self._parse_dt(fields.get("created")),
            updated_at=self._parse_dt(fields.get("updated")),
            raw=raw,
        )

    def _extract_parent_key(self, raw: dict) -> str | None:
        fields = raw.get("fields", {})
        parent = fields.get("parent")
        if parent:
            return parent.get("key")
        # Classic Jira: Epic Link custom field
        epic_link = fields.get("customfield_10014")
        return epic_link if isinstance(epic_link, str) else None

    def _extract_child_keys(self, raw: dict) -> list[str]:
        fields = raw.get("fields", {})
        subtasks = fields.get("subtasks") or []
        return [s.get("key") for s in subtasks if s.get("key")]

    def _extract_linked_items(self, raw: dict, base_url: str) -> list[LinkedItem]:
        fields = raw.get("fields", {})
        items = []
        for link in fields.get("issuelinks") or []:
            link_type = link.get("type", {})
            if "outwardIssue" in link:
                issue = link["outwardIssue"]
                items.append(LinkedItem(
                    id=issue.get("key", ""),
                    title=(issue.get("fields") or {}).get("summary", ""),
                    url=f"{base_url}/browse/{issue.get('key', '')}",
                    relationship=link_type.get("outward", "related"),
                    status=(issue.get("fields") or {}).get("status", {}).get("name"),
                ))
            elif "inwardIssue" in link:
                issue = link["inwardIssue"]
                items.append(LinkedItem(
                    id=issue.get("key", ""),
                    title=(issue.get("fields") or {}).get("summary", ""),
                    url=f"{base_url}/browse/{issue.get('key', '')}",
                    relationship=link_type.get("inward", "related"),
                    status=(issue.get("fields") or {}).get("status", {}).get("name"),
                ))
        return items

    @staticmethod
    def _adf_to_text(adf: dict | str | None) -> str:
        """Convert Atlassian Document Format (ADF) to plain text."""
        if not adf:
            return ""
        if isinstance(adf, str):
            return adf

        texts: list[str] = []

        def _walk(node: dict) -> None:
            if node.get("type") == "text":
                texts.append(node.get("text", ""))
            elif node.get("type") == "hardBreak":
                texts.append("\n")
            for child in node.get("content") or []:
                _walk(child)
            if node.get("type") in ("paragraph", "heading", "listItem", "bulletList", "orderedList"):
                texts.append("\n")

        _walk(adf)
        return "".join(texts).strip()

    @staticmethod
    def _adf_to_list(adf: dict | str | None) -> list[str]:
        """Extract bullet/ordered list items from ADF as a list of strings."""
        if not adf:
            return []
        if isinstance(adf, str):
            return [line.strip() for line in adf.splitlines() if line.strip()]

        items: list[str] = []

        def _walk(node: dict) -> None:
            if node.get("type") == "listItem":
                texts: list[str] = []
                for child in node.get("content") or []:
                    if child.get("type") == "paragraph":
                        for t in child.get("content") or []:
                            if t.get("type") == "text":
                                texts.append(t.get("text", ""))
                item_text = "".join(texts).strip()
                if item_text:
                    items.append(item_text)
            else:
                for child in node.get("content") or []:
                    _walk(child)

        _walk(adf)
        return items

    @staticmethod
    def _extract_ac_from_description(description: str) -> list[str]:
        """Try to extract acceptance criteria section from description text."""
        lines = description.splitlines()
        in_ac = False
        ac_items = []
        for line in lines:
            line_stripped = line.strip()
            if re.search(r"acceptance.criteria", line_stripped, re.IGNORECASE):
                in_ac = True
                continue
            if in_ac and re.match(r"^#{1,3}\s", line_stripped):
                break  # Next section started
            if in_ac and line_stripped:
                ac_items.append(re.sub(r"^[-*•]\s*", "", line_stripped))
        return ac_items

    @staticmethod
    def _parse_dt(value: str | None) -> datetime:
        if not value:
            return datetime.now(timezone.utc)
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except Exception:
            return datetime.now(timezone.utc)
