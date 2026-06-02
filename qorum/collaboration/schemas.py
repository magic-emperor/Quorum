"""
Phase 5 — Chat ingestion schemas (CaptureWindow, ChatSummary).
Phase 6 — Classification + location schemas (Classification, LocateResult).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, Field


# ── CaptureWindow ─────────────────────────────────────────────────────────────

CaptureStrategy = Literal["thread", "from_here", "lookback"]


@dataclass
class CaptureWindow:
    """
    A resolved slice of conversation ready for noise stripping + summarisation.

    strategy explains how the boundary was resolved:
      - "thread"    — all messages in a reply thread (unambiguous)
      - "from_here" — messages from an anchor message to the trigger
      - "lookback"  — last N messages / X minutes before the trigger
    """
    messages: list                      # list[ChatMessage] — imported lazily to avoid cycles
    start_ts: datetime
    end_ts: datetime
    strategy: CaptureStrategy
    channel_id: str
    thread_id: Optional[str] = None
    capture_id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    buffer_limited: bool = False        # True if Telegram buffer didn't reach the full window
    buffer_oldest_ts: Optional[datetime] = None   # earliest available if buffer_limited

    @property
    def message_count(self) -> int:
        return len(self.messages)

    def confirm_card_text(self) -> str:
        """Summary line shown on the confirm card."""
        start = self.start_ts.strftime("%H:%M")
        end = self.end_ts.strftime("%H:%M")
        n = self.message_count
        strat_label = {
            "thread": "reply thread",
            "from_here": "anchor range",
            "lookback": "recent window",
        }[self.strategy]

        text = f"I read *{n} message{'s' if n != 1 else ''}* ({start}–{end}) via {strat_label}."

        if self.buffer_limited and self.buffer_oldest_ts:
            oldest = self.buffer_oldest_ts.strftime("%H:%M on %b %d")
            text += f"\n_⚠ I've only been active since {oldest} — earlier history is unavailable._"

        return text


# ── ChatSummary ───────────────────────────────────────────────────────────────

class ChatSummary(BaseModel):
    """
    Structured extraction from a cleaned CaptureWindow.
    Produced by the summarizer agent; persisted as JSON + Markdown.
    """
    decisions: list[str] = Field(
        default_factory=list,
        description="Concrete things the team agreed to build or change.",
    )
    open_questions: list[str] = Field(
        default_factory=list,
        description="Unresolved points that need clarification.",
    )
    context: str = Field(
        default="",
        description="2-3 sentence description of the problem or situation.",
    )
    candidate_titles: list[str] = Field(
        default_factory=list,
        description="Short candidate titles for the resulting ticket or plan.",
    )
    assignees: list[str] = Field(
        default_factory=list,
        description="@mentioned people identified as owners.",
    )
    referenced_paths: list[str] = Field(
        default_factory=list,
        description="File/module names or code symbols mentioned in the conversation.",
    )
    links: list[str] = Field(
        default_factory=list,
        description="Any board links, PR URLs, or ticket references mentioned.",
    )

    @property
    def is_actionable(self) -> bool:
        """True if there's at least one decision or meaningful context to plan from."""
        return bool(self.decisions or (self.context and len(self.context) > 20))

    def to_markdown(
        self,
        capture: CaptureWindow,
        capture_id: str,
    ) -> str:
        """Render a human-readable Markdown file for .quorum/collaboration/."""
        lines = [
            f"# Chat Summary — {capture_id}",
            f"",
            f"**Strategy:** {capture.strategy}  |  "
            f"**Messages:** {capture.message_count}  |  "
            f"**Range:** {capture.start_ts.strftime('%Y-%m-%d %H:%M')} – "
            f"{capture.end_ts.strftime('%H:%M')}",
            f"",
        ]

        if self.context:
            lines += ["## Context", self.context, ""]

        if self.decisions:
            lines += ["## Decisions"]
            lines += [f"- {d}" for d in self.decisions]
            lines += [""]

        if self.open_questions:
            lines += ["## Open Questions"]
            lines += [f"- {q}" for q in self.open_questions]
            lines += [""]

        if self.assignees:
            lines += ["## Assignees", ", ".join(self.assignees), ""]

        if self.referenced_paths:
            lines += ["## Referenced Paths"]
            lines += [f"- `{p}`" for p in self.referenced_paths]
            lines += [""]

        if self.links:
            lines += ["## Links"]
            lines += [f"- {lnk}" for lnk in self.links]
            lines += [""]

        if self.candidate_titles:
            lines += [
                "## Candidate Titles",
                "_These are suggestions — Phase 7 will confirm the final title._",
            ]
            lines += [f"- {t}" for t in self.candidate_titles]

        return "\n".join(lines)


# ── Classification (Phase 6) ──────────────────────────────────────────────────

WorkType = Literal["bug", "feature", "enhancement", "refactor", "chore", "question", "version_bump"]
ComplexityLevel = Literal["SIMPLE", "COMPLEX"]
ModelTier = Literal["fast", "default", "premium"]

# Routing map: work_type → ordered agent list consumed by Phase 8 executor
AGENT_ROUTE: dict[str, list[str]] = {
    "bug":         ["coder", "tester"],
    "feature":     ["planner", "coder", "reviewer", "tester"],
    "enhancement": ["planner", "coder", "reviewer", "tester"],
    "refactor":    ["reviewer", "coder", "tester"],
    "chore":       ["coder"],
    "question":    [],   # answered inline; no execution
}


class Classification(BaseModel):
    """Result of the classifier agent for a single Intent."""
    actionable: bool
    work_type: Optional[WorkType] = None
    complexity: Optional[ComplexityLevel] = None
    model_tier: Optional[ModelTier] = None
    agent_route: list[str] = Field(default_factory=list)
    reasoning: str = ""
    clarifying_question: Optional[str] = None

    @property
    def needs_clarification(self) -> bool:
        return not self.actionable and bool(self.clarifying_question)

    @property
    def is_question_only(self) -> bool:
        return self.actionable and self.work_type == "question"


# ── LocateResult (Phase 6) ────────────────────────────────────────────────────

LocateMode = Literal["ENHANCEMENT", "NEW_PROJECT", "MULTI", "UNRESOLVED"]


class LocateResult(BaseModel):
    """Where the work lands — which repo, which .quorum/ dir, new vs existing."""
    mode: LocateMode
    target_repo: Optional[Path] = None        # resolved path to existing repo root
    scaffold_path: Optional[Path] = None      # for NEW_PROJECT: where to scaffold
    plan_dir: Optional[Path] = None           # target .quorum/ directory
    default_branch: str = "main"
    confidence: float = 0.0                   # 0.0–1.0
    why: str = ""
    evidence: list[str] = Field(default_factory=list)
    clarifying_question: Optional[str] = None  # for MULTI / UNRESOLVED

    @property
    def is_resolved(self) -> bool:
        return self.mode in ("ENHANCEMENT", "NEW_PROJECT") and self.plan_dir is not None

    @property
    def needs_human_input(self) -> bool:
        return self.mode in ("MULTI", "UNRESOLVED")
