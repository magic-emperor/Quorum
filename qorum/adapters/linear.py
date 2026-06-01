"""
Linear adapter — fetches issues via Linear GraphQL API.

Auth: API key (Bearer token).
Set LINEAR_API_KEY in .env.
Create at: https://linear.app/settings/api

API: POST https://api.linear.app/graphql
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

import aiohttp

from qorum.adapters.base import (
    AdapterError,
    AuthError,
    BaseTicketAdapter,
    Comment,
    LinkedItem,
    NormalizedTicket,
    Platform,
    RateLimitError,
    TicketNotFoundError,
)
from qorum.core.logger import get_logger
from qorum.core.retry import with_retry

if TYPE_CHECKING:
    from qorum.config import QorumConfig

log = get_logger(__name__)

_URL_RE = re.compile(
    r"https?://linear\.app/(?P<team>[^/]+)/issue/(?P<id>[A-Z0-9]+-\d+)",
    re.IGNORECASE,
)

_LINEAR_API = "https://api.linear.app/graphql"

# GraphQL query: fetch issue with parent, children, comments, relations
_ISSUE_QUERY = """
query GetIssue($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    state { name type }
    assignee { displayName }
    priority
    estimate
    labels { nodes { name } }
    cycle { name number startsAt endsAt }
    team { name }
    createdAt
    updatedAt
    url
    parent {
      id
      identifier
      title
      description
      state { name }
      assignee { displayName }
      priority
      estimate
      url
      createdAt
      updatedAt
    }
    children(first: 20) {
      nodes {
        id
        identifier
        title
        state { name }
        priority
        estimate
        url
        createdAt
        updatedAt
      }
    }
    comments(first: 50, orderBy: createdAt) {
      nodes {
        id
        body
        user { displayName }
        createdAt
        updatedAt
      }
    }
    relations {
      nodes {
        type
        relatedIssue {
          identifier
          title
          url
          state { name }
        }
      }
    }
  }
}
"""


class LinearAdapter(BaseTicketAdapter):
    """Fetches Linear issues with full context via GraphQL API."""

    def __init__(self, config: "QorumConfig") -> None:
        self._config = config
        self._session: aiohttp.ClientSession | None = None

    @property
    def platform(self) -> Platform:
        return Platform.LINEAR

    def validate_url(self, url: str) -> bool:
        return bool(_URL_RE.match(url))

    async def fetch_item(self, url: str) -> NormalizedTicket:
        match = _URL_RE.match(url)
        if not match:
            raise AdapterError(f"Invalid Linear URL: {url}")

        issue_id = match.group("id")
        log.info("linear.fetch_item", issue_id=issue_id)

        raw = await with_retry(
            lambda: self._query_issue(issue_id),
            label=f"linear.issue.{issue_id}",
        )

        issue_data = raw.get("data", {}).get("issue")
        if not issue_data:
            errors = raw.get("errors", [])
            if errors:
                msg = errors[0].get("message", "Unknown error")
                if "not found" in msg.lower():
                    raise TicketNotFoundError(f"Linear issue {issue_id} not found.")
                raise AdapterError(f"Linear GraphQL error: {msg}")
            raise TicketNotFoundError(f"Linear issue {issue_id} not found.")

        return self._normalize(issue_data)

    async def fetch_parent(self, item_id: str) -> NormalizedTicket | None:
        return None

    async def fetch_children(self, item_id: str) -> list[NormalizedTicket]:
        return []

    async def fetch_comments(self, item_id: str) -> list[Comment]:
        return []

    async def fetch_linked_items(self, item_id: str) -> list[LinkedItem]:
        return []

    # ── Internal helpers ──────────────────────────────────────────────────────

    async def _query_issue(self, issue_id: str) -> dict[str, Any]:
        session = await self._get_session()
        payload = {"query": _ISSUE_QUERY, "variables": {"id": issue_id}}

        async with session.post(_LINEAR_API, json=payload) as resp:
            if resp.status == 401:
                raise AuthError(
                    "Linear authentication failed. "
                    "Check that LINEAR_API_KEY is set correctly."
                )
            if resp.status == 429:
                retry_after = int(resp.headers.get("Retry-After", 60))
                raise RateLimitError(f"Linear rate limit hit.", retry_after=retry_after)
            if resp.status >= 400:
                text = await resp.text()
                raise AdapterError(f"Linear API error {resp.status}: {text[:200]}")
            return await resp.json()

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            api_key = self._config.linear_api_key or ""
            self._session = aiohttp.ClientSession(
                headers={
                    "Authorization": api_key,
                    "Content-Type": "application/json",
                }
            )
        return self._session

    def _normalize(self, data: dict[str, Any]) -> NormalizedTicket:
        # Parent
        parent: NormalizedTicket | None = None
        if data.get("parent"):
            parent = self._normalize_minimal(data["parent"])

        # Children
        children = [
            self._normalize_minimal(child)
            for child in (data.get("children") or {}).get("nodes", [])
        ][: self._config.qorum_max_children]

        # Comments
        comments = [
            Comment(
                author=(c.get("user") or {}).get("displayName", "Unknown"),
                body=c.get("body", ""),
                created_at=self._parse_dt(c.get("createdAt")),
                updated_at=self._parse_dt(c.get("updatedAt")),
            )
            for c in (data.get("comments") or {}).get("nodes", [])
        ]

        # Relations
        relation_type_map = {
            "blocks": "blocks",
            "blocked_by": "is blocked by",
            "related": "related to",
            "duplicate": "duplicate of",
        }
        linked = []
        for rel in (data.get("relations") or {}).get("nodes", []):
            related = rel.get("relatedIssue") or {}
            linked.append(LinkedItem(
                id=related.get("identifier", ""),
                title=related.get("title", ""),
                url=related.get("url", ""),
                relationship=relation_type_map.get(rel.get("type", ""), "related to"),
                status=(related.get("state") or {}).get("name"),
            ))

        # Labels → tags
        tags = [l.get("name", "") for l in (data.get("labels") or {}).get("nodes", [])]

        # Priority mapping (Linear uses 0-4: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low)
        priority_map = {0: None, 1: "Urgent", 2: "High", 3: "Medium", 4: "Low"}
        priority = priority_map.get(data.get("priority", 0))

        # Sprint (cycle)
        sprint = None
        cycle = data.get("cycle")
        if cycle:
            sprint = cycle.get("name") or f"Cycle {cycle.get('number', '')}"

        # Item type from state type
        state_type = (data.get("state") or {}).get("type", "").lower()
        item_type_map = {
            "backlog": "Story",
            "unstarted": "Story",
            "started": "Story",
            "completed": "Story",
            "cancelled": "Story",
        }
        item_type = item_type_map.get(state_type, "Issue")

        # Check if it's a parent (has children) — treat as Epic
        if (data.get("children") or {}).get("nodes"):
            item_type = "Epic"

        description = data.get("description") or ""
        acceptance_criteria = self._extract_ac(description)

        return NormalizedTicket(
            platform=Platform.LINEAR,
            id=data.get("identifier", data.get("id", "")),
            url=data.get("url", ""),
            title=data.get("title", "Untitled"),
            description=description,
            acceptance_criteria=acceptance_criteria,
            item_type=item_type,
            status=(data.get("state") or {}).get("name", "Unknown"),
            assignee=(data.get("assignee") or {}).get("displayName"),
            tags=tags,
            priority=priority,
            story_points=data.get("estimate"),
            sprint=sprint,
            parent=parent,
            children=children,
            linked_items=linked,
            comments=comments,
            created_at=self._parse_dt(data.get("createdAt")),
            updated_at=self._parse_dt(data.get("updatedAt")),
            raw=data,
        )

    def _normalize_minimal(self, data: dict[str, Any]) -> NormalizedTicket:
        """Create a minimal NormalizedTicket from partial issue data (parent/child nodes)."""
        return NormalizedTicket(
            platform=Platform.LINEAR,
            id=data.get("identifier", data.get("id", "")),
            url=data.get("url", ""),
            title=data.get("title", "Untitled"),
            description=data.get("description") or "",
            acceptance_criteria=[],
            item_type="Issue",
            status=(data.get("state") or {}).get("name", "Unknown"),
            assignee=(data.get("assignee") or {}).get("displayName"),
            tags=[],
            priority=None,
            story_points=data.get("estimate"),
            sprint=None,
            parent=None,
            children=[],
            linked_items=[],
            comments=[],
            created_at=self._parse_dt(data.get("createdAt")),
            updated_at=self._parse_dt(data.get("updatedAt")),
            raw=data,
        )

    @staticmethod
    def _extract_ac(description: str) -> list[str]:
        """Extract acceptance criteria section from Linear markdown description."""
        lines = description.splitlines()
        in_ac = False
        items = []
        for line in lines:
            stripped = line.strip()
            if re.search(r"acceptance.criteria", stripped, re.IGNORECASE):
                in_ac = True
                continue
            if in_ac and stripped.startswith("#"):
                break
            if in_ac and stripped:
                clean = re.sub(r"^[-*•]\s*(\[[ x]\])?\s*", "", stripped)
                if clean:
                    items.append(clean)
        return items

    @staticmethod
    def _parse_dt(value: str | None) -> datetime:
        if not value:
            return datetime.now(timezone.utc)
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except Exception:
            return datetime.now(timezone.utc)
