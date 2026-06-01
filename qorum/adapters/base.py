"""
Base adapter interface and shared data models for all ticket platform adapters.
Every platform adapter must implement BaseTicketAdapter and return NormalizedTicket.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class Platform(str, Enum):
    AZURE_BOARDS = "azure_boards"
    JIRA_CLOUD = "jira_cloud"
    JIRA_SERVER = "jira_server"
    GITHUB_ISSUES = "github_issues"
    LINEAR = "linear"
    CLICKUP = "clickup"
    TRELLO = "trello"
    ASANA = "asana"
    YOUTRACK = "youtrack"
    NOTION = "notion"
    UNKNOWN = "unknown"


class TicketSize(str, Enum):
    STANDARD = "standard"
    LARGE = "large"


@dataclass
class Comment:
    author: str
    body: str
    created_at: datetime
    updated_at: datetime | None = None


@dataclass
class LinkedItem:
    id: str
    title: str
    url: str
    relationship: str  # e.g. "blocks", "is blocked by", "related", "duplicate", "parent", "child"
    status: str | None = None


@dataclass
class NormalizedTicket:
    """
    Platform-agnostic representation of a ticket/work item.
    Every adapter returns this regardless of source platform.
    """
    platform: Platform
    id: str
    url: str
    title: str
    description: str
    acceptance_criteria: list[str]
    item_type: str                    # Story, Bug, Epic, Task, Feature, Issue, etc.
    status: str
    assignee: str | None
    tags: list[str]
    priority: str | None
    story_points: int | None
    sprint: str | None
    parent: NormalizedTicket | None
    children: list[NormalizedTicket]
    linked_items: list[LinkedItem]
    comments: list[Comment]
    created_at: datetime
    updated_at: datetime
    raw: dict[str, Any]               # Original API response preserved for debugging

    # Computed fields (set post-init)
    size: TicketSize = field(default=TicketSize.STANDARD, init=False)

    def __post_init__(self) -> None:
        self.size = _detect_size(self)

    def to_json(self) -> str:
        """Serialize to JSON for DB persistence (B2)."""
        import json as _json
        import dataclasses as _dc
        from datetime import datetime as _dt

        def _convert(obj: Any) -> Any:
            if isinstance(obj, _dt):
                return obj.isoformat()
            if isinstance(obj, Enum):
                return obj.value
            if _dc.is_dataclass(obj) and not isinstance(obj, type):
                return {k: _convert(v) for k, v in _dc.asdict(obj).items()}
            if isinstance(obj, list):
                return [_convert(i) for i in obj]
            if isinstance(obj, dict):
                return {k: _convert(v) for k, v in obj.items()}
            return obj

        d = _convert(self)
        d.pop("size", None)  # recomputed on deserialize
        return _json.dumps(d)

    @classmethod
    def from_json(cls, data: str) -> "NormalizedTicket":
        """Deserialize from JSON (B2). Nested tickets reconstructed recursively."""
        import json as _json
        from datetime import datetime as _dt

        def _parse_dt(v: str | None) -> _dt:
            return _dt.fromisoformat(v) if v else _dt.now()

        def _build(d: dict) -> "NormalizedTicket":
            return cls(
                platform=Platform(d["platform"]),
                id=d["id"],
                url=d["url"],
                title=d["title"],
                description=d.get("description") or "",
                acceptance_criteria=d.get("acceptance_criteria") or [],
                item_type=d.get("item_type") or "",
                status=d.get("status") or "",
                assignee=d.get("assignee"),
                tags=d.get("tags") or [],
                priority=d.get("priority"),
                story_points=d.get("story_points"),
                sprint=d.get("sprint"),
                parent=_build(d["parent"]) if d.get("parent") else None,
                children=[_build(c) for c in d.get("children") or []],
                linked_items=[
                    LinkedItem(
                        id=li["id"], title=li["title"], url=li["url"],
                        relationship=li["relationship"], status=li.get("status"),
                    )
                    for li in d.get("linked_items") or []
                ],
                comments=[
                    Comment(
                        author=c["author"], body=c["body"],
                        created_at=_parse_dt(c.get("created_at")),
                        updated_at=_parse_dt(c.get("updated_at")) if c.get("updated_at") else None,
                    )
                    for c in d.get("comments") or []
                ],
                created_at=_parse_dt(d.get("created_at")),
                updated_at=_parse_dt(d.get("updated_at")),
                raw=d.get("raw") or {},
            )

        return _build(_json.loads(data))


def _detect_size(ticket: NormalizedTicket) -> TicketSize:
    """
    Classify a ticket as STANDARD or LARGE based on complexity signals.
    LARGE tickets will be auto-split into phases during plan generation.
    """
    signals = 0

    if ticket.item_type.lower() in ("epic", "feature", "initiative", "theme"):
        signals += 2

    if ticket.story_points is not None and ticket.story_points > 13:
        signals += 1

    if len(ticket.acceptance_criteria) > 7:
        signals += 1

    if len(ticket.children) > 5:
        signals += 1

    if len((ticket.description or "").split()) > 400:
        signals += 1

    return TicketSize.LARGE if signals >= 2 else TicketSize.STANDARD


class AdapterError(Exception):
    """Base exception for all adapter errors."""


class AuthError(AdapterError):
    """Raised when authentication fails (401/403)."""


class TicketNotFoundError(AdapterError):
    """Raised when the ticket does not exist or was deleted (404)."""


class RateLimitError(AdapterError):
    """Raised when the platform rate limit is hit. Includes retry_after seconds."""

    def __init__(self, message: str, retry_after: int = 30) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class PrivateTicketError(AdapterError):
    """Raised when the ticket exists but is in a private project the token cannot access."""


class BaseTicketAdapter(ABC):
    """
    Abstract base class for all ticket platform adapters.
    Implement one concrete adapter per platform.
    """

    @property
    @abstractmethod
    def platform(self) -> Platform:
        """The platform this adapter handles."""

    @abstractmethod
    async def fetch_item(self, url: str) -> NormalizedTicket:
        """
        Fetch a work item by URL and return a fully populated NormalizedTicket.
        Must also fetch parent (1 level up), children (1 level down),
        linked items, and comments.

        Raises:
            AuthError: Token missing or invalid.
            TicketNotFoundError: Item does not exist.
            RateLimitError: Rate limit hit.
            PrivateTicketError: Item is in inaccessible project.
            AdapterError: Any other platform error.
        """

    @abstractmethod
    async def fetch_parent(self, item_id: str) -> NormalizedTicket | None:
        """Fetch the direct parent of a work item. Returns None if no parent."""

    @abstractmethod
    async def fetch_children(self, item_id: str) -> list[NormalizedTicket]:
        """Fetch direct child items (1 level down). Returns empty list if none."""

    @abstractmethod
    async def fetch_comments(self, item_id: str) -> list[Comment]:
        """Fetch all comments/discussion on a work item."""

    @abstractmethod
    async def fetch_linked_items(self, item_id: str) -> list[LinkedItem]:
        """Fetch all items linked to this work item with their relationship type."""

    @abstractmethod
    def validate_url(self, url: str) -> bool:
        """Return True if this URL belongs to this adapter's platform."""

    # ── Phase 11: Bidirectional write-back ────────────────────────────────────
    # Default implementations are no-ops so existing adapters don't break.
    # Jira + Azure override these; GitHub + Linear in a follow-on.

    async def post_comment(self, ticket_id: str, body: str) -> None:
        """Post a comment to the ticket. No-op if not implemented."""

    async def update_status(self, ticket_id: str, status: str) -> None:
        """Update the ticket status using the configured status-map. No-op if not implemented."""

    async def link_pr(self, ticket_id: str, pr_url: str) -> None:
        """Attach a PR URL to the ticket (where the platform supports it). No-op if not."""
