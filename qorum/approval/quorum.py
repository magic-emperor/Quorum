"""
Phase 7 — Quorum rules engine.

Evaluates votes against configurable approval rules:
  any        — any one required approver has approved
  all        — every required approver has approved
  majority   — more than half of required approvers have approved
  lead-only  — exactly the designated lead must approve

Also handles EXPIRED when approval_timeout_hours is exceeded.

Configuration is read from .quorum/collaboration/config.json inside the target repo:
  { "approval_rule": "any", "required_approvers": ["@alice", "@bob"],
    "approval_timeout_hours": 24 }

If no config file exists, defaults are used (any + 24h timeout).
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path
from typing import Optional

from qorum.core.logger import get_logger

log = get_logger(__name__)

ApprovalRule = str   # "any" | "all" | "majority" | "lead-only"

_DEFAULT_RULE: ApprovalRule = "any"
_DEFAULT_TIMEOUT_HOURS = 24
_CONFIG_FILE = "collaboration/config.json"


class QuorumVerdict(str, Enum):
    APPROVED  = "APPROVED"
    REJECTED  = "REJECTED"
    PENDING   = "PENDING"
    EXPIRED   = "EXPIRED"


@dataclass
class QuorumConfig:
    rule: ApprovalRule = _DEFAULT_RULE
    required_approvers: list[str] = field(default_factory=list)
    approval_timeout_hours: int = _DEFAULT_TIMEOUT_HOURS
    lead: Optional[str] = None   # required when rule="lead-only"

    @classmethod
    def from_plan_dir(cls, plan_dir: Path) -> "QuorumConfig":
        """Load from .quorum/collaboration/config.json; fall back to defaults."""
        config_path = plan_dir.parent / _CONFIG_FILE
        if not config_path.exists():
            return cls()
        try:
            data = json.loads(config_path.read_text(encoding="utf-8"))
            return cls(
                rule=data.get("approval_rule", _DEFAULT_RULE),
                required_approvers=data.get("required_approvers", []),
                approval_timeout_hours=int(data.get("approval_timeout_hours", _DEFAULT_TIMEOUT_HOURS)),
                lead=data.get("lead"),
            )
        except (json.JSONDecodeError, KeyError, ValueError) as exc:
            log.warning("quorum_config.load_failed", error=str(exc), using="defaults")
            return cls()


@dataclass
class ApprovalVote:
    user_id: str
    display_name: Optional[str]
    verdict: QuorumVerdict       # APPROVED or REJECTED
    occurred_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    note: Optional[str] = None


@dataclass
class QuorumState:
    """Snapshot of approval progress for one plan."""
    plan_id: str
    config: QuorumConfig
    votes: list[ApprovalVote] = field(default_factory=list)
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    trigger_user_id: Optional[str] = None   # the person who triggered the plan

    @property
    def expires_at(self) -> datetime:
        return self.created_at + timedelta(hours=self.config.approval_timeout_hours)

    @property
    def is_expired(self) -> bool:
        return datetime.now(timezone.utc) > self.expires_at

    @property
    def approved_by(self) -> list[str]:
        return [v.user_id for v in self.votes if v.verdict == QuorumVerdict.APPROVED]

    @property
    def rejected_by(self) -> list[str]:
        return [v.user_id for v in self.votes if v.verdict == QuorumVerdict.REJECTED]

    def add_vote(self, vote: ApprovalVote) -> None:
        """Add or replace a vote (idempotent per user)."""
        self.votes = [v for v in self.votes if v.user_id != vote.user_id]
        self.votes.append(vote)


def evaluate(state: QuorumState) -> QuorumVerdict:
    """
    Apply the quorum rule to the current vote state.
    Returns APPROVED, REJECTED, PENDING, or EXPIRED.
    """
    if state.is_expired and _evaluate_rule(state) == QuorumVerdict.PENDING:
        return QuorumVerdict.EXPIRED

    return _evaluate_rule(state)


def _evaluate_rule(state: QuorumState) -> QuorumVerdict:
    cfg = state.config
    approved = set(state.approved_by)
    rejected = set(state.rejected_by)

    # Any rejection blocks in "all" mode
    if cfg.rule == "all" and rejected:
        return QuorumVerdict.REJECTED

    # Lead-only: only the designated lead's vote counts
    if cfg.rule == "lead-only":
        lead = cfg.lead
        if not lead:
            log.warning("quorum.lead_not_set", plan_id=state.plan_id)
            return QuorumVerdict.PENDING
        if lead in rejected:
            return QuorumVerdict.REJECTED
        if lead in approved:
            return QuorumVerdict.APPROVED
        return QuorumVerdict.PENDING

    required = set(cfg.required_approvers) if cfg.required_approvers else set()

    if cfg.rule == "any":
        # Any one person (from required if set, else anyone) approves
        if required:
            if required & approved:
                return QuorumVerdict.APPROVED
            if required & rejected and not (required - rejected):
                return QuorumVerdict.REJECTED  # all required have rejected
        else:
            if approved:
                return QuorumVerdict.APPROVED
        return QuorumVerdict.PENDING

    if cfg.rule == "all":
        if not required:
            return QuorumVerdict.APPROVED if approved else QuorumVerdict.PENDING
        if required <= approved:
            return QuorumVerdict.APPROVED
        return QuorumVerdict.PENDING

    if cfg.rule == "majority":
        if not required:
            return QuorumVerdict.APPROVED if approved else QuorumVerdict.PENDING
        threshold = len(required) / 2
        if len(approved & required) > threshold:
            return QuorumVerdict.APPROVED
        # Majority rejected only when strictly more than half have rejected
        if len(rejected & required) > threshold:
            return QuorumVerdict.REJECTED
        return QuorumVerdict.PENDING

    # Unknown rule — treat as "any"
    log.warning("quorum.unknown_rule", rule=cfg.rule, plan_id=state.plan_id)
    return QuorumVerdict.APPROVED if approved else QuorumVerdict.PENDING
