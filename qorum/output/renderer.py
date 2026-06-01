"""
Qorum Output Renderer — converts structured AI output to markdown files.

Uses Jinja2 templates so the format can be changed without touching Python code.
All three artifact types (plan, testing, walkthrough) are rendered here.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, StrictUndefined

from qorum.adapters.base import NormalizedTicket
from qorum.core.logger import get_logger
from qorum.core.plan_generator import GeneratedPlan
from qorum.core.schemas import PlanOutput, TestingOutput

log = get_logger(__name__)

TEMPLATES_DIR = Path(__file__).parent / "templates"


@dataclass
class PhaseInfo:
    number: int
    total: int
    title: str


@dataclass
class PlanVsRealityDiff:
    section: str
    planned: str
    actual: str
    changed: bool


@dataclass
class TechnicalDecision:
    title: str
    description: str


@dataclass
class WalkthroughData:
    """
    Filled by the developer (collected via bot interaction) before walkthrough.md is generated.
    """
    executive_summary: str
    how_to_run: list[str]
    plan_vs_reality: list[PlanVsRealityDiff]
    technical_decisions: list[TechnicalDecision]
    known_issues: list[str]
    deployment_steps: list[str]
    rollback_steps: list[str]
    linked_prs: list[str]
    signoff_checklist: list[str]


class QorumRenderer:
    """
    Renders plan.md, testing.md, and walkthrough.md from structured data.
    Template changes do not require Python changes.
    """

    def __init__(self) -> None:
        self._env = Environment(
            loader=FileSystemLoader(str(TEMPLATES_DIR)),
            undefined=StrictUndefined,
            autoescape=False,   # Markdown, not HTML
            trim_blocks=True,
            lstrip_blocks=True,
        )
        # Register custom filters
        self._env.filters["datefmt"] = self._datefmt
        self._env.globals["confidence_bar"] = self._confidence_bar

    # ── Public API ────────────────────────────────────────────────────────────

    def render_plan(
        self,
        ticket: NormalizedTicket,
        generated_plan: GeneratedPlan,
        phase_info: PhaseInfo | None = None,
    ) -> str:
        """Render plan.md from a GeneratedPlan."""
        template = self._env.get_template("plan.md.jinja")
        return template.render(
            ticket=self._ticket_ctx(ticket),
            plan=generated_plan.plan,
            phase_info=phase_info,
            generated_at=self._now(),
        )

    def render_testing(
        self,
        ticket: NormalizedTicket,
        testing: TestingOutput,
        approved_by: str | None = None,
        approved_at: str | None = None,
        phase_info: PhaseInfo | None = None,
    ) -> str:
        """Render testing.md from a TestingOutput."""
        template = self._env.get_template("testing.md.jinja")
        return template.render(
            ticket=self._ticket_ctx(ticket),
            testing=testing,
            approved_by=approved_by,
            approved_at=approved_at or self._now(),
            phase_info=phase_info,
        )

    def render_walkthrough(
        self,
        ticket: NormalizedTicket,
        walkthrough: WalkthroughData,
        completed_by: str | None = None,
        completed_at: str | None = None,
    ) -> str:
        """Render walkthrough.md from WalkthroughData collected from developer."""
        template = self._env.get_template("walkthrough.md.jinja")
        return template.render(
            ticket=self._ticket_ctx(ticket),
            walkthrough=walkthrough,
            completed_by=completed_by,
            completed_at=completed_at or self._now(),
        )

    def render_task(
        self,
        ticket: NormalizedTicket,
        plan: PlanOutput,
        phase_info: PhaseInfo | None = None,
    ) -> str:
        """
        Render task.md — an executable checklist from sub_tasks.
        B12: serialize sub-tasks as proper Markdown, never Python repr / [object Object].
        """
        lines = [
            f"# Task: {ticket.title}",
            f"Ticket: [{ticket.id}]({ticket.url})",
            "",
            "## Sub-tasks",
            "",
        ]
        for task in plan.sub_tasks:
            deps = f" _(depends on: {', '.join(task.dependencies)})_" if task.dependencies else ""
            effort = f" `{task.effort.value}`" if task.effort else ""
            lines.append(f"- [ ] **{task.id}** {task.title}{effort}{deps}")
            lines.append(f"  {task.description}")
            if task.notes:
                lines.append(f"  > {task.notes}")
            lines.append("")

        lines += [
            "## Definition of Done",
            "",
        ]
        for item in plan.definition_of_done:
            lines.append(f"- [ ] {item}")

        return "\n".join(lines)

    def build_inline_summary(self, plan: PlanOutput, ticket_id: str, ticket_title: str) -> str:
        """
        Build a short inline summary for posting directly in Slack/Discord/Telegram.
        Kept under ~400 characters for readability in chat.
        """
        warning = "⚠️ LOW CONFIDENCE — resolve ambiguities first\n" if plan.low_confidence_warning else ""
        confidence = plan.confidence_overall
        bar = self._confidence_bar(confidence)
        tasks = len(plan.sub_tasks)
        ambig = len(plan.ambiguities)

        return (
            f"{warning}"
            f"*{ticket_title}* `{ticket_id}`\n"
            f"Confidence: {bar} {confidence}% | {tasks} sub-tasks"
            + (f" | ⚠️ {ambig} ambiguit{'y' if ambig == 1 else 'ies'}" if ambig else "")
        )

    # ── Context builders ──────────────────────────────────────────────────────

    @staticmethod
    def _ticket_ctx(ticket: NormalizedTicket) -> dict[str, Any]:
        """Convert NormalizedTicket to a template-friendly dict."""
        return {
            "id": ticket.id,
            "title": ticket.title,
            "url": ticket.url,
            "platform": ticket.platform.value,
            "item_type": ticket.item_type,
            "updated_at": ticket.updated_at,
        }

    # ── Jinja2 filters and globals ────────────────────────────────────────────

    @staticmethod
    def _datefmt(value: datetime | None) -> str:
        if value is None:
            return "—"
        return value.strftime("%Y-%m-%d %H:%M UTC")

    @staticmethod
    def _confidence_bar(confidence: int) -> str:
        if confidence >= 85:
            return "🟢"
        elif confidence >= 70:
            return "🟡"
        else:
            return "🔴"

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
