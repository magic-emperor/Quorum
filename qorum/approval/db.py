"""
Qorum Approval DB — async SQLite layer for ticket state persistence.

All state transitions are stored here so the pipeline survives bot restarts.
Schema is intentionally minimal: ticket IDs + states + timestamps, no content.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

import aiosqlite

from qorum.core.logger import get_logger

if TYPE_CHECKING:
    from qorum.approval.state_machine import TicketState

log = get_logger(__name__)

# Default path — overridden by QorumConfig.qorum_db_path in practice
DEFAULT_DB_PATH = Path("qorum.db")

_CREATE_TABLES = """
CREATE TABLE IF NOT EXISTS ticket_sessions (
    ticket_id       TEXT PRIMARY KEY,
    url             TEXT NOT NULL,
    channel_id      TEXT,
    ticket_json     TEXT NOT NULL,      -- NormalizedTicket.to_json()
    result_json     TEXT NOT NULL,      -- GenerationResult Pydantic JSON
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_states (
    ticket_id       TEXT PRIMARY KEY,
    platform        TEXT NOT NULL,
    state           TEXT NOT NULL,
    phase_count     INTEGER NOT NULL DEFAULT 1,
    plan_paths      TEXT NOT NULL DEFAULT '[]',   -- JSON list of paths
    testing_paths   TEXT NOT NULL DEFAULT '[]',   -- JSON list of paths
    walkthrough_path TEXT,
    feedback_text   TEXT,
    approved_by     TEXT,
    completed_by    TEXT,
    pr_links        TEXT NOT NULL DEFAULT '[]',   -- JSON list
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS state_transitions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id       TEXT NOT NULL,
    from_state      TEXT,
    to_state        TEXT NOT NULL,
    actor           TEXT,
    note            TEXT,
    occurred_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact_feedback (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id       TEXT NOT NULL,
    artifact_type   TEXT NOT NULL,   -- 'plan' | 'testing' | 'walkthrough'
    rating          TEXT NOT NULL,   -- 'helpful' | 'needs_work'
    flagged         INTEGER NOT NULL DEFAULT 0,  -- 1 = flagged for prompt review
    sections_flagged TEXT NOT NULL DEFAULT '[]', -- JSON list of section names
    comment         TEXT,
    actor           TEXT,
    occurred_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_votes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id         TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    display_name    TEXT,
    verdict         TEXT NOT NULL,   -- 'APPROVED' | 'REJECTED'
    note            TEXT,
    occurred_at     TEXT NOT NULL,
    UNIQUE(plan_id, user_id)         -- idempotent: one vote per user per plan
);

CREATE TABLE IF NOT EXISTS audit_trail (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id         TEXT NOT NULL,
    event_type      TEXT NOT NULL,   -- plan_created | vote | approved | rejected | expired | change_request
    actor           TEXT,
    detail          TEXT,            -- JSON blob with event-specific data
    occurred_at     TEXT NOT NULL
);
"""


class ApprovalDB:
    """
    Async SQLite wrapper for Qorum approval state.

    Usage:
        db = ApprovalDB(Path("qorum.db"))
        await db.init()
        await db.upsert_ticket(ticket_id, platform, state, ...)
    """

    def __init__(self, db_path: Path = DEFAULT_DB_PATH) -> None:
        self._path = db_path

    async def init(self) -> None:
        """Create tables if they don't exist. Call once at startup."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self._path) as conn:
            await conn.executescript(_CREATE_TABLES)
            await conn.commit()
        log.info("approval_db.initialized", path=str(self._path))

    # ── Session persistence (B2) ─────────────────────────────────────────────

    async def save_session(
        self,
        ticket_id: str,
        url: str,
        ticket_json: str,
        result_json: str,
        channel_id: str | None = None,
    ) -> None:
        """Persist ticket + generation result so approve/refresh survive bot restart."""
        now = _now()
        async with aiosqlite.connect(self._path) as conn:
            await conn.execute(
                """
                INSERT INTO ticket_sessions
                    (ticket_id, url, channel_id, ticket_json, result_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(ticket_id) DO UPDATE SET
                    url        = excluded.url,
                    channel_id = excluded.channel_id,
                    ticket_json = excluded.ticket_json,
                    result_json = excluded.result_json,
                    updated_at  = excluded.updated_at
                """,
                (ticket_id, url, channel_id, ticket_json, result_json, now, now),
            )
            await conn.commit()

    async def load_session(self, ticket_id: str) -> "dict[str, Any] | None":
        """Load a persisted session, or None if not found."""
        async with aiosqlite.connect(self._path) as conn:
            conn.row_factory = aiosqlite.Row
            async with conn.execute(
                "SELECT * FROM ticket_sessions WHERE ticket_id = ?", (ticket_id,)
            ) as cursor:
                row = await cursor.fetchone()
        return dict(row) if row else None

    async def delete_session(self, ticket_id: str) -> None:
        """Remove a session record (called after mark_done)."""
        async with aiosqlite.connect(self._path) as conn:
            await conn.execute(
                "DELETE FROM ticket_sessions WHERE ticket_id = ?", (ticket_id,)
            )
            await conn.commit()

    # ── Ticket state ──────────────────────────────────────────────────────────

    async def upsert_ticket(
        self,
        ticket_id: str,
        platform: str,
        state: "TicketState",
        phase_count: int = 1,
        plan_paths: list[str] | None = None,
        testing_paths: list[str] | None = None,
        walkthrough_path: str | None = None,
        feedback_text: str | None = None,
        approved_by: str | None = None,
        completed_by: str | None = None,
        pr_links: list[str] | None = None,
    ) -> None:
        """Insert or update a ticket's full state record."""
        now = _now()
        async with aiosqlite.connect(self._path) as conn:
            await conn.execute(
                """
                INSERT INTO ticket_states
                    (ticket_id, platform, state, phase_count, plan_paths, testing_paths,
                     walkthrough_path, feedback_text, approved_by, completed_by, pr_links,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(ticket_id) DO UPDATE SET
                    state            = excluded.state,
                    phase_count      = excluded.phase_count,
                    plan_paths       = excluded.plan_paths,
                    testing_paths    = excluded.testing_paths,
                    walkthrough_path = COALESCE(excluded.walkthrough_path, ticket_states.walkthrough_path),
                    feedback_text    = COALESCE(excluded.feedback_text, ticket_states.feedback_text),
                    approved_by      = COALESCE(excluded.approved_by, ticket_states.approved_by),
                    completed_by     = COALESCE(excluded.completed_by, ticket_states.completed_by),
                    pr_links         = excluded.pr_links,
                    updated_at       = excluded.updated_at
                """,
                (
                    ticket_id,
                    platform,
                    state.value,
                    phase_count,
                    json.dumps(plan_paths or []),
                    json.dumps(testing_paths or []),
                    walkthrough_path,
                    feedback_text,
                    approved_by,
                    completed_by,
                    json.dumps(pr_links or []),
                    now,
                    now,
                ),
            )
            await conn.commit()

    async def get_ticket(self, ticket_id: str) -> dict[str, Any] | None:
        """Return the ticket's state record as a dict, or None if not found."""
        async with aiosqlite.connect(self._path) as conn:
            conn.row_factory = aiosqlite.Row
            async with conn.execute(
                "SELECT * FROM ticket_states WHERE ticket_id = ?", (ticket_id,)
            ) as cursor:
                row = await cursor.fetchone()

        if row is None:
            return None

        d = dict(row)
        d["plan_paths"] = json.loads(d["plan_paths"])
        d["testing_paths"] = json.loads(d["testing_paths"])
        d["pr_links"] = json.loads(d["pr_links"])
        return d

    async def get_state(self, ticket_id: str) -> "TicketState | None":
        """Return current state enum, or None if ticket not found."""
        from qorum.approval.state_machine import TicketState

        row = await self.get_ticket(ticket_id)
        if row is None:
            return None
        return TicketState(row["state"])

    async def list_tickets(
        self,
        limit: int = 20,
        state_filter: "TicketState | None" = None,
    ) -> list[dict[str, Any]]:
        """Return most recent tickets, optionally filtered by state."""
        query = "SELECT * FROM ticket_states"
        params: list[Any] = []
        if state_filter is not None:
            query += " WHERE state = ?"
            params.append(state_filter.value)
        query += " ORDER BY updated_at DESC LIMIT ?"
        params.append(limit)

        async with aiosqlite.connect(self._path) as conn:
            conn.row_factory = aiosqlite.Row
            async with conn.execute(query, params) as cursor:
                rows = await cursor.fetchall()

        result = []
        for row in rows:
            d = dict(row)
            d["plan_paths"] = json.loads(d["plan_paths"])
            d["testing_paths"] = json.loads(d["testing_paths"])
            d["pr_links"] = json.loads(d["pr_links"])
            result.append(d)
        return result

    # ── Transition log ────────────────────────────────────────────────────────

    async def log_transition(
        self,
        ticket_id: str,
        from_state: "TicketState | None",
        to_state: "TicketState",
        actor: str | None = None,
        note: str | None = None,
    ) -> None:
        """Append a state transition to the audit log."""
        async with aiosqlite.connect(self._path) as conn:
            await conn.execute(
                """
                INSERT INTO state_transitions
                    (ticket_id, from_state, to_state, actor, note, occurred_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    ticket_id,
                    from_state.value if from_state else None,
                    to_state.value,
                    actor,
                    note,
                    _now(),
                ),
            )
            await conn.commit()

    async def get_transitions(self, ticket_id: str) -> list[dict[str, Any]]:
        """Return full transition history for a ticket."""
        async with aiosqlite.connect(self._path) as conn:
            conn.row_factory = aiosqlite.Row
            async with conn.execute(
                "SELECT * FROM state_transitions WHERE ticket_id = ? ORDER BY occurred_at",
                (ticket_id,),
            ) as cursor:
                rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    # ── Feedback ──────────────────────────────────────────────────────────────

    async def record_feedback(
        self,
        ticket_id: str,
        artifact_type: str,
        rating: str,
        sections_flagged: list[str] | None = None,
        comment: str | None = None,
        actor: str | None = None,
    ) -> None:
        """
        Store in-chat feedback for a generated artifact.

        Args:
            ticket_id:       The ticket this feedback is about.
            artifact_type:   'plan' | 'testing' | 'walkthrough'
            rating:          'helpful' | 'needs_work'
            sections_flagged: Names of plan sections the user flagged as problematic.
            comment:         Optional free-text comment.
            actor:           User who gave the feedback.
        """
        flagged = 1 if rating == "needs_work" else 0
        async with aiosqlite.connect(self._path) as conn:
            await conn.execute(
                """
                INSERT INTO artifact_feedback
                    (ticket_id, artifact_type, rating, flagged, sections_flagged,
                     comment, actor, occurred_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    ticket_id,
                    artifact_type,
                    rating,
                    flagged,
                    json.dumps(sections_flagged or []),
                    comment,
                    actor,
                    _now(),
                ),
            )
            await conn.commit()
        log.info(
            "feedback.recorded",
            ticket_id=ticket_id,
            artifact=artifact_type,
            rating=rating,
        )

    async def get_feedback(self, ticket_id: str) -> list[dict[str, Any]]:
        """Return all feedback entries for a ticket."""
        async with aiosqlite.connect(self._path) as conn:
            conn.row_factory = aiosqlite.Row
            async with conn.execute(
                "SELECT * FROM artifact_feedback WHERE ticket_id = ? ORDER BY occurred_at",
                (ticket_id,),
            ) as cursor:
                rows = await cursor.fetchall()
        result = []
        for row in rows:
            d = dict(row)
            d["sections_flagged"] = json.loads(d["sections_flagged"])
            result.append(d)
        return result

    async def get_flagged_plans(self, limit: int = 20) -> list[dict[str, Any]]:
        """Return plans that received 'needs_work' feedback — for prompt improvement review."""
        async with aiosqlite.connect(self._path) as conn:
            conn.row_factory = aiosqlite.Row
            async with conn.execute(
                """
                SELECT ticket_id, artifact_type, COUNT(*) as flag_count,
                       GROUP_CONCAT(sections_flagged) as all_sections,
                       MAX(occurred_at) as last_flagged
                FROM artifact_feedback
                WHERE flagged = 1
                GROUP BY ticket_id, artifact_type
                ORDER BY flag_count DESC, last_flagged DESC
                LIMIT ?
                """,
                (limit,),
            ) as cursor:
                rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    # ── Phase 7: votes + audit trail ──────────────────────────────────────────

    async def upsert_vote(
        self,
        plan_id: str,
        user_id: str,
        display_name: str | None,
        verdict: str,       # "APPROVED" | "REJECTED"
        note: str | None = None,
    ) -> None:
        """Record or replace a user's vote (idempotent per plan+user)."""
        async with aiosqlite.connect(self._path) as conn:
            await conn.execute(
                """
                INSERT INTO approval_votes
                    (plan_id, user_id, display_name, verdict, note, occurred_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(plan_id, user_id) DO UPDATE SET
                    verdict      = excluded.verdict,
                    display_name = excluded.display_name,
                    note         = excluded.note,
                    occurred_at  = excluded.occurred_at
                """,
                (plan_id, user_id, display_name, verdict, note, _now()),
            )
            await conn.commit()

    async def get_votes(self, plan_id: str) -> list[dict[str, Any]]:
        """Return all votes for a plan."""
        async with aiosqlite.connect(self._path) as conn:
            conn.row_factory = aiosqlite.Row
            async with conn.execute(
                "SELECT * FROM approval_votes WHERE plan_id = ? ORDER BY occurred_at",
                (plan_id,),
            ) as cursor:
                rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def append_audit_event(
        self,
        plan_id: str,
        event_type: str,
        actor: str | None = None,
        detail: dict | None = None,
    ) -> None:
        """Append an immutable event to the audit trail."""
        async with aiosqlite.connect(self._path) as conn:
            await conn.execute(
                """
                INSERT INTO audit_trail (plan_id, event_type, actor, detail, occurred_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (plan_id, event_type, actor, json.dumps(detail or {}), _now()),
            )
            await conn.commit()

    async def get_audit_trail(self, plan_id: str) -> list[dict[str, Any]]:
        """Return full audit trail for a plan."""
        async with aiosqlite.connect(self._path) as conn:
            conn.row_factory = aiosqlite.Row
            async with conn.execute(
                "SELECT * FROM audit_trail WHERE plan_id = ? ORDER BY occurred_at",
                (plan_id,),
            ) as cursor:
                rows = await cursor.fetchall()
        result = []
        for row in rows:
            d = dict(row)
            d["detail"] = json.loads(d["detail"])
            result.append(d)
        return result

    # ── Stats ─────────────────────────────────────────────────────────────────

    async def get_stats(self) -> dict[str, Any]:
        """Return aggregate usage stats for /atlas stats command."""
        async with aiosqlite.connect(self._path) as conn:
            conn.row_factory = aiosqlite.Row

            async with conn.execute("SELECT COUNT(*) as total FROM ticket_states") as c:
                total = (await c.fetchone())["total"]

            async with conn.execute(
                "SELECT state, COUNT(*) as n FROM ticket_states GROUP BY state"
            ) as c:
                by_state = {row["state"]: row["n"] for row in await c.fetchall()}

            async with conn.execute(
                "SELECT COUNT(*) as n FROM state_transitions WHERE to_state = 'DONE'"
            ) as c:
                done_count = (await c.fetchone())["n"]

            async with conn.execute(
                "SELECT COUNT(*) as total, "
                "SUM(CASE WHEN rating='helpful' THEN 1 ELSE 0 END) as helpful, "
                "SUM(CASE WHEN rating='needs_work' THEN 1 ELSE 0 END) as needs_work "
                "FROM artifact_feedback"
            ) as c:
                fb_row = await c.fetchone()
                feedback = {
                    "total": fb_row["total"] or 0,
                    "helpful": fb_row["helpful"] or 0,
                    "needs_work": fb_row["needs_work"] or 0,
                }

        return {
            "total_plans": total,
            "by_state": by_state,
            "completed": done_count,
            "feedback": feedback,
        }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
