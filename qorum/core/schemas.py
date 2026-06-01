"""
Pydantic schemas for Qorum AI output.

Claude returns structured JSON matching these schemas.
We validate before rendering — malformed output is caught here, not in templates.

Three artifact schemas:
  - PlanOutput      → plan.md
  - TestingOutput   → testing.md
  - WalkthroughOutput → walkthrough.md (Phase 4, filled by developer)
"""
from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field, field_validator


# ── Confidence thresholds (single source of truth — B11) ─────────────────────

CONF_WARN = 70   # below this → low_confidence_warning=True
CONF_GOOD = 85   # at/above this → green indicator in UI


# ── Shared enums ──────────────────────────────────────────────────────────────

class Effort(str, Enum):
    S = "S"
    M = "M"
    L = "L"
    XL = "XL"


class Likelihood(str, Enum):
    LOW = "Low"
    MEDIUM = "Medium"
    HIGH = "High"


class AmbiguityOwner(str, Enum):
    BA = "BA"
    PO = "PO"
    TECH_LEAD = "Tech Lead"
    DEVELOPER = "Developer"
    QA = "QA"
    STAKEHOLDER = "Stakeholder"


# ── Phase breakdown schema — defined BEFORE PlanOutput uses it (B10) ──────────

class PhaseDefinition(BaseModel):
    number: int
    name: str = Field(description="Short slug-style name e.g. 'backend-api', 'frontend-ui'")
    title: str = Field(description="Human-readable title")
    scope: str = Field(description="What this phase covers in 1-2 sentences")
    sub_task_titles: list[str] = Field(
        description="High-level tasks in this phase (used to slice context for per-phase planning)"
    )
    estimated_effort: Effort
    depends_on_phases: list[int] = Field(default_factory=list)


class PhaseProposal(BaseModel):
    """
    Proposed phase breakdown for a large ticket.
    Qorum proposes this first, then generates a PlanOutput per phase.
    """
    total_phases: int = Field(ge=2, le=5)
    rationale: str = Field(description="Why this breakdown makes sense")
    phases: list[PhaseDefinition]


# ── Plan schema ───────────────────────────────────────────────────────────────

class SubTask(BaseModel):
    id: str = Field(description="Short ID like T1, T2")
    title: str
    description: str
    effort: Effort
    dependencies: list[str] = Field(default_factory=list, description="List of sub-task IDs this depends on")
    confidence: int = Field(ge=0, le=100, description="How confident Qorum is about this sub-task, 0-100")
    notes: str | None = None

    @field_validator("confidence")
    @classmethod
    def confidence_in_range(cls, v: int) -> int:
        return max(0, min(100, v))


class NonFunctionalRequirements(BaseModel):
    performance: str | None = None
    security: str | None = None
    accessibility: str | None = None
    scalability: str | None = None
    observability: str | None = None
    reliability: str | None = None
    notes: str | None = None


class Ambiguity(BaseModel):
    id: str = Field(description="Short ID like A1, A2")
    question: str = Field(description="Specific, answerable question — not a vague concern")
    impact: str = Field(description="What sub-tasks or decisions this blocks")
    suggested_owner: AmbiguityOwner
    priority: Literal["Must resolve before dev", "Should resolve before dev", "Can resolve during dev"] = "Should resolve before dev"


class Risk(BaseModel):
    description: str
    likelihood: Likelihood
    mitigation: str


class PlanOutput(BaseModel):
    """
    Structured output from the AI plan generator.
    Validated before being rendered to plan.md.
    """
    # Meta
    prompt_version: str = Field(description="Which prompt version produced this plan, e.g. plan_v1")
    confidence_overall: int = Field(ge=0, le=100)
    low_confidence_warning: bool = Field(
        description=f"True if overall confidence < {CONF_WARN} — renderer adds WARNING header"
    )

    # Core sections
    summary: str = Field(description="2-4 sentence plain-English summary of what needs to be built")
    sub_tasks: list[SubTask] = Field(min_length=1)
    non_functional_requirements: NonFunctionalRequirements
    definition_of_done: list[str] = Field(min_length=3, description="Checklist items")
    ambiguities: list[Ambiguity] = Field(
        default_factory=list,
        description="Empty list is valid if no ambiguities — but must be present"
    )
    assumptions: list[str] = Field(
        min_length=1,
        description="Things Qorum assumed that aren't explicitly stated in the ticket"
    )
    risks: list[Risk] = Field(min_length=1)
    out_of_scope: list[str] = Field(
        min_length=1,
        description="Things a dev might reasonably assume are in scope but are NOT"
    )
    test_scenarios: list[str] = Field(
        min_length=3,
        description="Overview test cases — detailed test cases go in testing.md"
    )

    # For large (phased) tickets
    phase_context: str | None = Field(
        default=None,
        description="If this is one phase of many, describe what this phase covers and what comes before/after"
    )

    @field_validator("low_confidence_warning", mode="before")
    @classmethod
    def set_warning_from_confidence(cls, v: bool, info: object) -> bool:
        return v

    # Phase 7: intended file edits — shown on approval card, compared by Phase 8/10
    file_change_intent: list["FileChangeIntent"] = Field(
        default_factory=list,
        description="Files this plan intends to create, modify, or delete.",
    )

    def model_post_init(self, __context: object) -> None:
        if self.confidence_overall < CONF_WARN:
            object.__setattr__(self, "low_confidence_warning", True)


class FileChangeIntent(BaseModel):
    """One intended file operation, included in PlanOutput for the approval card."""
    path: str = Field(description="Relative file path within the repo")
    action: Literal["create", "modify", "delete"]
    reason: str = Field(description="Why this file needs to change")


# ── Testing schema ────────────────────────────────────────────────────────────

class TestCase(BaseModel):
    id: str
    title: str
    type: Literal["unit", "integration", "e2e", "manual", "performance", "security", "accessibility"]
    description: str
    given: str = Field(description="Precondition / setup")
    when: str = Field(description="Action taken")
    then: str = Field(description="Expected result")
    related_sub_task: str | None = Field(default=None, description="Sub-task ID from plan.md")


class TestingOutput(BaseModel):
    """Structured output for testing.md generation."""
    prompt_version: str
    unit_test_cases: list[TestCase]
    integration_test_scenarios: list[TestCase]
    edge_cases: list[TestCase]
    manual_qa_checklist: list[str]
    performance_scenarios: list[str] = Field(default_factory=list)
    security_checklist: list[str] = Field(default_factory=list)
    accessibility_checks: list[str] = Field(default_factory=list)
    test_data_requirements: list[str]
    environment_requirements: list[str]
    pass_fail_criteria: list[str] = Field(min_length=1)
