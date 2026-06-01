"""
GitHub Issues adapter — fetches issues via GitHub REST API v4.

Auth: Personal Access Token with scope "issues" (read-only).
Set GITHUB_TOKEN in .env.

API refs:
  Issue:     GET /repos/{owner}/{repo}/issues/{number}
  Comments:  GET /repos/{owner}/{repo}/issues/{number}/comments
  Linked:    Inferred from body mentions and timeline events
  Milestone: issue.milestone (used as "sprint" equivalent)
  Labels:    issue.labels (used as tags)
  Parent:    GitHub Issues has no native parent. We detect via linked issues in body.
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
    PrivateTicketError,
    RateLimitError,
    TicketNotFoundError,
)
from qorum.core.logger import get_logger
from qorum.core.retry import with_retry

if TYPE_CHECKING:
    from qorum.config import QorumConfig

log = get_logger(__name__)

_URL_RE = re.compile(
    r"https?://github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/issues/(?P<number>\d+)",
    re.IGNORECASE,
)

# Patterns for detecting issue/PR references in body text
# e.g. "closes #123", "fixes #456", "blocked by #789"
_ISSUE_REF_RE = re.compile(
    r"(?P<relationship>closes?|fixes?|resolves?|blocked?\s+by|blocks?|relates?\s+to|see\s+also)?\s*"
    r"(?:(?P<owner>[a-zA-Z0-9\-]+)/(?P<repo>[a-zA-Z0-9\-_.]+))?#(?P<number>\d+)",
    re.IGNORECASE,
)

_GITHUB_API_BASE = "https://api.github.com"


class GitHubIssuesAdapter(BaseTicketAdapter):
    """Fetches GitHub Issues with comments, labels, milestone, and linked issue references."""

    def __init__(self, config: "QorumConfig") -> None:
        self._config = config
        self._session: aiohttp.ClientSession | None = None

    @property
    def platform(self) -> Platform:
        return Platform.GITHUB_ISSUES

    def validate_url(self, url: str) -> bool:
        return bool(_URL_RE.match(url))

    async def fetch_item(self, url: str) -> NormalizedTicket:
        match = _URL_RE.match(url)
        if not match:
            raise AdapterError(f"Invalid GitHub Issues URL: {url}")

        owner = match.group("owner")
        repo = match.group("repo")
        number = match.group("number")

        log.info("github.fetch_item", owner=owner, repo=repo, number=number)

        raw = await with_retry(
            lambda: self._get_issue(owner, repo, number),
            label=f"github.issue.{owner}/{repo}#{number}",
        )
        comments_raw = await self._get_comments(owner, repo, number)

        # GitHub Issues has no native parent concept.
        # Check if this issue is a sub-issue (referenced in a parent task list).
        parent = None   # Phase 2+ could implement via Projects API if needed

        # Children: look for task list checkboxes in body that reference other issues
        children: list[NormalizedTicket] = []

        # Linked items: parse body text for issue references
        linked = self._extract_linked_items_from_body(
            raw.get("body") or "", owner, repo
        )

        return self._normalize(raw, comments_raw, children, linked, owner, repo, parent=parent)

    async def fetch_parent(self, item_id: str) -> NormalizedTicket | None:
        return None

    async def fetch_children(self, item_id: str) -> list[NormalizedTicket]:
        return []

    async def fetch_comments(self, item_id: str) -> list[Comment]:
        return []

    async def fetch_linked_items(self, item_id: str) -> list[LinkedItem]:
        return []

    # ── Internal helpers ──────────────────────────────────────────────────────

    async def _get_issue(self, owner: str, repo: str, number: str) -> dict[str, Any]:
        url = f"{_GITHUB_API_BASE}/repos/{owner}/{repo}/issues/{number}"
        return await self._get(url)

    async def _get_comments(self, owner: str, repo: str, number: str) -> list[dict]:
        url = f"{_GITHUB_API_BASE}/repos/{owner}/{repo}/issues/{number}/comments?per_page=100"
        try:
            return await with_retry(lambda: self._get_list(url), label=f"github.comments.{number}")
        except Exception:
            log.warning("github.comments_fetch_failed", number=number)
            return []

    async def _get(self, url: str) -> dict[str, Any]:
        session = await self._get_session()
        async with session.get(url) as resp:
            if resp.status == 401:
                raise AuthError(
                    "GitHub authentication failed. "
                    "Check that GITHUB_TOKEN is set and has 'issues' read scope."
                )
            if resp.status == 403:
                # Could be rate limit or permissions
                remaining = resp.headers.get("X-RateLimit-Remaining", "1")
                if remaining == "0":
                    retry_after = int(resp.headers.get("X-RateLimit-Reset", "30"))
                    raise RateLimitError("GitHub rate limit reached.", retry_after=60)
                raise PrivateTicketError(
                    "Access denied. This repository may be private or your token lacks access."
                )
            if resp.status == 404:
                raise TicketNotFoundError(
                    "Issue not found. The repository may be private or the issue number is wrong."
                )
            if resp.status == 429:
                raise RateLimitError("GitHub rate limit hit.", retry_after=60)
            if resp.status >= 400:
                text = await resp.text()
                raise AdapterError(f"GitHub API error {resp.status}: {text[:200]}")
            return await resp.json()

    async def _get_list(self, url: str) -> list[dict]:
        session = await self._get_session()
        async with session.get(url) as resp:
            if resp.status >= 400:
                return []
            return await resp.json()

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            token = self._config.github_token or ""
            self._session = aiohttp.ClientSession(
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                }
            )
        return self._session

    def _normalize(
        self,
        raw: dict[str, Any],
        comments_raw: list[dict],
        children: list[NormalizedTicket],
        linked: list[LinkedItem],
        owner: str,
        repo: str,
        parent: NormalizedTicket | None = None,
    ) -> NormalizedTicket:
        body = raw.get("body") or ""
        acceptance_criteria = self._extract_ac_from_body(body)
        description = self._clean_description(body, acceptance_criteria)

        comments = [
            Comment(
                author=(c.get("user") or {}).get("login", "unknown"),
                body=c.get("body", ""),
                created_at=self._parse_dt(c.get("created_at")),
                updated_at=self._parse_dt(c.get("updated_at")),
            )
            for c in comments_raw
        ]

        labels = [label.get("name", "") for label in (raw.get("labels") or [])]
        milestone = (raw.get("milestone") or {}).get("title")
        number = str(raw.get("number", ""))

        # Determine item type from labels (common GitHub conventions)
        item_type = "Issue"
        label_lower = [l.lower() for l in labels]
        if any(t in label_lower for t in ("epic", "initiative")):
            item_type = "Epic"
        elif "bug" in label_lower:
            item_type = "Bug"
        elif any(t in label_lower for t in ("feature", "enhancement")):
            item_type = "Feature"
        elif "task" in label_lower:
            item_type = "Task"

        # Priority from labels
        priority = None
        for label in label_lower:
            if "critical" in label or "p0" in label:
                priority = "Critical"
                break
            elif "high" in label or "p1" in label:
                priority = "High"
                break
            elif "medium" in label or "p2" in label:
                priority = "Medium"
                break
            elif "low" in label or "p3" in label:
                priority = "Low"
                break

        return NormalizedTicket(
            platform=Platform.GITHUB_ISSUES,
            id=number,
            url=raw.get("html_url", f"https://github.com/{owner}/{repo}/issues/{number}"),
            title=raw.get("title", "Untitled"),
            description=description,
            acceptance_criteria=acceptance_criteria,
            item_type=item_type,
            status="Open" if raw.get("state") == "open" else "Closed",
            assignee=(raw.get("assignee") or {}).get("login"),
            tags=labels,
            priority=priority,
            story_points=None,   # GitHub Issues has no native story points
            sprint=milestone,
            parent=parent,
            children=children,
            linked_items=linked,
            comments=comments,
            created_at=self._parse_dt(raw.get("created_at")),
            updated_at=self._parse_dt(raw.get("updated_at")),
            raw=raw,
        )

    def _extract_linked_items_from_body(
        self, body: str, default_owner: str, default_repo: str
    ) -> list[LinkedItem]:
        items = []
        seen: set[str] = set()

        relationship_map = {
            "close": "closes",
            "closes": "closes",
            "fix": "fixes",
            "fixes": "fixes",
            "resolve": "resolves",
            "resolves": "resolves",
            "blocked by": "is blocked by",
            "block": "blocks",
            "blocks": "blocks",
            "relate to": "related to",
            "relates to": "related to",
            "see also": "related to",
        }

        for match in _ISSUE_REF_RE.finditer(body):
            number = match.group("number")
            owner = match.group("owner") or default_owner
            repo = match.group("repo") or default_repo
            rel_raw = (match.group("relationship") or "").lower().strip()
            relationship = relationship_map.get(rel_raw, "related to")

            key = f"{owner}/{repo}#{number}"
            if key not in seen:
                seen.add(key)
                items.append(LinkedItem(
                    id=number,
                    title=f"{owner}/{repo}#{number}",
                    url=f"https://github.com/{owner}/{repo}/issues/{number}",
                    relationship=relationship,
                ))

        return items

    @staticmethod
    def _extract_ac_from_body(body: str) -> list[str]:
        """Extract acceptance criteria section from issue body (markdown)."""
        lines = body.splitlines()
        in_ac = False
        ac_items = []
        for line in lines:
            stripped = line.strip()
            if re.search(r"acceptance.criteria", stripped, re.IGNORECASE):
                in_ac = True
                continue
            if in_ac and stripped.startswith("#"):
                break
            if in_ac and stripped:
                clean = re.sub(r"^[-*•]\s*(\[ \])?\s*", "", stripped)
                if clean:
                    ac_items.append(clean)
        return ac_items

    @staticmethod
    def _clean_description(body: str, ac_items: list[str]) -> str:
        """Return body without the acceptance criteria section."""
        if not ac_items:
            return body.strip()
        lines = body.splitlines()
        result = []
        skip = False
        for line in lines:
            stripped = line.strip()
            if re.search(r"acceptance.criteria", stripped, re.IGNORECASE):
                skip = True
                continue
            if skip and stripped.startswith("#"):
                skip = False
            if not skip:
                result.append(line)
        return "\n".join(result).strip()

    @staticmethod
    def _parse_dt(value: str | None) -> datetime:
        if not value:
            return datetime.now(timezone.utc)
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except Exception:
            return datetime.now(timezone.utc)
