"""
Qorum .quorum/ memory schema — declarative definitions only.

Every project that Qorum works on gains a .quorum/ directory committed alongside
the source code. This module defines the shapes of all files in that directory
as Pydantic models and typed dicts so the rest of the engine can read/write them
with type safety.

No I/O lives here — writers are in Phases 6–8. This file is the single source
of truth for what a .quorum/ directory contains.

Layout:
  <repo>/
    .quorum/
      plan.md                              ← active execution plan (free markdown)
      task.md                              ← executable sub-task checklist
      BUGS.md                              ← all bugs ever found (free markdown)
      DEVGUIDE.md                          ← living architecture doc (free markdown)
      plan-index.json                      ← PlanIndex
      task-index.json                      ← TaskIndex
      nervous-system/
        actions.json                       ← list[ActionRecord]
        decisions.json                     ← list[DecisionRecord]
        reasoning.json                     ← list[ReasoningRecord]
        conflicts.json                     ← list[ConflictRecord]
        open-questions.json                ← list[OpenQuestion]
        bug-registry.json                  ← list[BugPattern]
        function-registry.json             ← list[FunctionRecord]
        env-registry.json                  ← list[EnvVar]
        test-coverage.json                 ← TestCoverage
        cached-instincts.json              ← list[Instinct]
      collaboration/
        config.json                        ← CollabConfig
        contributors.json                  ← list[Contributor]
        audit-trail.json                   ← list[AuditEvent]  (append-only)
        chat-summaries/
          {plan-id}-{date}.md              ← free markdown summary
        approvals/
          {plan-id}-approval.json          ← ApprovalRecord
          {plan-id}-plan.json              ← PlanSnapshot
      context/
        session-current.json               ← SessionState
        sessions/                          ← archived sessions
        budget-log.json                    ← list[BudgetEntry]
      rollback_points/                     ← git sha / stash ref snapshots
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


# ── Plan & task indexes ───────────────────────────────────────────────────────

class PlanIndex(BaseModel):
    """Tracks the current milestone / phase for a project."""
    current_version: int = 0
    last_updated: str = ""
    phases: list[str] = Field(default_factory=list)
    current_phase: str = ""
    current_milestone: str = "MVP"


class TaskEntry(BaseModel):
    id: str
    title: str
    status: Literal["TODO", "IN_PROGRESS", "COMPLETE", "BLOCKED", "ROLLED_BACK"] = "TODO"
    phase: str = ""
    folder: str = ""
    keywords: list[str] = Field(default_factory=list)
    depends_on: list[str] = Field(default_factory=list)
    affects_files: list[str] = Field(default_factory=list)
    milestone: str = "current"
    session_completed: str | None = None


class TaskSummary(BaseModel):
    complete: int = 0
    in_progress: int = 0
    blocked: int = 0
    todo: int = 0
    rolled_back: int = 0


class TaskIndex(BaseModel):
    total: int = 0
    last_updated: str = ""
    last_updated_date: str = ""
    summary: TaskSummary = Field(default_factory=TaskSummary)
    tasks: list[TaskEntry] = Field(default_factory=list)


# ── Nervous system ────────────────────────────────────────────────────────────

class ActionRecord(BaseModel):
    """One action taken by a Qorum agent (execution log)."""
    id: str
    type: str = "action"
    what: str
    agent: str
    status: Literal["completed", "failed", "partial"] = "completed"
    output: str = ""
    session: str = ""
    timestamp: str = ""


class DecisionRecord(BaseModel):
    """An architectural or implementation decision (ADR-style)."""
    id: str
    decision: str
    context: str = ""
    rationale: str = ""
    alternatives_rejected: list[str] = Field(default_factory=list)
    status: Literal["proposed", "accepted", "superseded", "deprecated"] = "accepted"
    session: str = ""
    timestamp: str = ""


class ReasoningRecord(BaseModel):
    """Full thought process behind a decision or action."""
    id: str
    for_decision_or_action: str
    thought_process: str
    session: str = ""
    timestamp: str = ""


class ConflictRecord(BaseModel):
    """A detected conflict between two concurrent writers or decisions."""
    id: str
    file: str
    description: str
    resolution: str = ""
    resolved: bool = False
    timestamp: str = ""


class OpenQuestion(BaseModel):
    id: str
    question: str
    context: str = ""
    owner: str = ""
    priority: Literal["must", "should", "can"] = "should"
    resolved: bool = False
    resolution: str = ""
    timestamp: str = ""


class BugPattern(BaseModel):
    """A known bug pattern; the critic agent checks new work against these."""
    id: str
    description: str
    pattern: str
    files_affected: list[str] = Field(default_factory=list)
    risk: Literal["low", "medium", "high"] = "medium"
    mitigation: str = ""
    first_seen: str = ""


class FunctionRecord(BaseModel):
    """Maps a function/class to its location — used by agents to avoid duplication."""
    name: str
    file: str
    line: int | None = None
    description: str = ""
    tags: list[str] = Field(default_factory=list)


class EnvVar(BaseModel):
    name: str
    required: bool = True
    description: str = ""
    example: str = ""
    used_in: list[str] = Field(default_factory=list)


class TestCoverageEntry(BaseModel):
    file: str
    coverage_pct: float | None = None
    last_tested: str = ""
    test_files: list[str] = Field(default_factory=list)


class TestCoverage(BaseModel):
    overall_pct: float | None = None
    last_run: str = ""
    entries: list[TestCoverageEntry] = Field(default_factory=list)


class Instinct(BaseModel):
    """A learned preference from developer corrections (observer system)."""
    id: str
    rule: str
    confidence: float = Field(ge=0.0, le=1.0, default=0.5)
    source: str = ""
    created: str = ""


# ── Collaboration ─────────────────────────────────────────────────────────────

class CollabConfig(BaseModel):
    """Per-project collaboration settings (.quorum/collaboration/config.json)."""
    quorum: Literal["any", "all", "majority", "lead-only"] = "any"
    approval_timeout_hours: int = 24
    auto_execute_on_approval: bool = False


class PlatformIds(BaseModel):
    teams_id: str | None = None
    slack_id: str | None = None
    discord_id: str | None = None
    telegram_id: str | None = None
    whatsapp_phone: str | None = None
    board_account: str | None = None


class Contributor(BaseModel):
    """A team member mapped across platforms."""
    id: str
    name: str
    email: str | None = None
    role: Literal["lead", "dev", "reviewer", "observer"] = "dev"
    platforms: PlatformIds = Field(default_factory=PlatformIds)


class AuditEvent(BaseModel):
    """One immutable entry in the append-only audit trail."""
    event: str       # plan_created | approved | rejected | executed | changes_requested | expired
    plan_id: str
    user_id: str
    details: str = ""
    timestamp: str = ""
    extra: dict[str, Any] = Field(default_factory=dict)


class ApprovalRecord(BaseModel):
    """Per-plan approval state (.quorum/collaboration/approvals/{id}-approval.json)."""
    status: Literal["pending", "approved", "rejected", "expired"] = "pending"
    rule: Literal["any", "all", "majority", "lead-only"] = "any"
    required: list[str] = Field(default_factory=list)   # contributor ids
    approved_by: list[str] = Field(default_factory=list)
    rejected_by: list[str] = Field(default_factory=list)
    rejection_reason: str = ""
    expires_at: str = ""
    created_at: str = ""


class PlanSnapshotMessage(BaseModel):
    id: str
    author: str
    timestamp: str
    content: str


class PlanSnapshot(BaseModel):
    """The chat messages + source that produced a plan ({id}-plan.json)."""
    plan_id: str
    source: Literal["chat", "board"] = "chat"
    chat_messages: list[PlanSnapshotMessage] = Field(default_factory=list)
    ticket_url: str | None = None
    created_at: str = ""


# ── Context / sessions ────────────────────────────────────────────────────────

class SessionState(BaseModel):
    session_id: str
    started_at: str = ""
    last_active: str = ""
    active_plan_id: str | None = None
    active_branch: str | None = None
    provider_used: str | None = None
    token_usage: dict[str, int] = Field(default_factory=dict)


class BudgetEntry(BaseModel):
    session: str
    role: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    timestamp: str = ""
