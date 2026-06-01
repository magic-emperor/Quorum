"""
Qorum Output Manager — handles all file system operations for generated artifacts.

Responsibilities:
  - Create per-ticket folder structure under QORUM_OUTPUT_PATH
  - Save plan.md, testing.md, walkthrough.md with version management
  - Maintain INDEX.md (running log of all generated plans)
  - Handle phased tickets (per-phase sub-folders)
  - Return absolute file paths for bot layer to reference
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

import aiofiles

from qorum.adapters.base import NormalizedTicket, TicketSize
from qorum.core.logger import get_logger
from qorum.core.plan_generator import GeneratedPlan, GenerationResult
from qorum.core.schemas import TestingOutput
from qorum.output.renderer import QorumRenderer, PhaseInfo, WalkthroughData

if TYPE_CHECKING:
    from qorum.config import QorumConfig

log = get_logger(__name__)


@dataclass
class SavedArtifacts:
    """Paths to all saved files for a ticket."""
    ticket_id: str
    plan_paths: list[Path]       # One per phase (or just one for standard tickets)
    testing_paths: list[Path]    # One per phase (set after approval)
    walkthrough_path: Path | None  # Set after developer marks done


class QorumOutputManager:
    """
    Manages the Qorum output folder structure and file versioning.

    Folder layout:
      qorum-output/
        plans/
          {ticket-id}/                       ← standard ticket
            plan.md  (or plan_v2.md etc.)
            testing.md
            walkthrough.md
          {ticket-id}/                       ← large ticket (phased)
            phase-1-backend-api/
              plan.md
              testing.md
            phase-2-frontend/
              plan.md
              testing.md
            walkthrough.md                   ← one per ticket
        INDEX.md                             ← running log of all plans
    """

    def __init__(self, config: "QorumConfig") -> None:
        self._config = config
        self._renderer = QorumRenderer()
        self._output_root = config.qorum_output_path
        self._plans_root = self._output_root / "plans"

    # ── Public API ────────────────────────────────────────────────────────────

    async def save_plans(
        self,
        ticket: NormalizedTicket,
        result: GenerationResult,
        root: Path | None = None,
    ) -> SavedArtifacts:
        """
        Save plan.md file(s) for a ticket.
        root: override the output root (B6 — Phase 6 passes target repo .quorum/).
              Defaults to the global qorum_output_path from config.
        """
        if root is not None:
            # Per-call override: write under root/plans/{ticket-id}/
            self._output_root = root
            self._plans_root = root / "plans"
        self._ensure_dirs()
        ticket_dir = self._ticket_dir(ticket.id)
        ticket_dir.mkdir(parents=True, exist_ok=True)

        plan_paths: list[Path] = []

        for gp in result.plans:
            phase_info = self._make_phase_info(gp, result) if result.size == TicketSize.LARGE else None
            target_dir = self._phase_dir(ticket_dir, gp) if phase_info else ticket_dir
            target_dir.mkdir(parents=True, exist_ok=True)

            content = self._renderer.render_plan(ticket, gp, phase_info)
            path = await self._write_versioned(target_dir, "plan.md", content)
            plan_paths.append(path)

            log.info(
                "output_manager.plan_saved",
                ticket_id=ticket.id,
                path=str(path),
                phase=gp.phase_number,
            )

        await self._update_index(ticket, result, plan_paths)

        return SavedArtifacts(
            ticket_id=ticket.id,
            plan_paths=plan_paths,
            testing_paths=[],
            walkthrough_path=None,
        )

    async def save_testing(
        self,
        ticket: NormalizedTicket,
        testing_outputs: list[TestingOutput],
        generated_plans: list[GeneratedPlan],
        approved_by: str | None = None,
    ) -> list[Path]:
        """
        Save testing.md file(s) after plan approval.
        One testing.md per phase (or one for standard tickets).
        """
        ticket_dir = self._ticket_dir(ticket.id)
        approved_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        testing_paths: list[Path] = []

        for testing, gp in zip(testing_outputs, generated_plans):
            phase_info = self._make_phase_info(gp, None) if gp.phase_number else None
            target_dir = self._phase_dir(ticket_dir, gp) if phase_info else ticket_dir
            target_dir.mkdir(parents=True, exist_ok=True)

            content = self._renderer.render_testing(
                ticket, testing,
                approved_by=approved_by,
                approved_at=approved_at,
                phase_info=phase_info,
            )
            path = await self._write_versioned(target_dir, "testing.md", content)
            testing_paths.append(path)

            log.info(
                "output_manager.testing_saved",
                ticket_id=ticket.id,
                path=str(path),
                phase=gp.phase_number,
            )

        return testing_paths

    async def save_walkthrough(
        self,
        ticket: NormalizedTicket,
        walkthrough: WalkthroughData,
        completed_by: str | None = None,
    ) -> Path:
        """
        Save walkthrough.md at the ticket root (one per ticket, covers all phases).
        Called after developer marks the ticket done.
        """
        ticket_dir = self._ticket_dir(ticket.id)
        ticket_dir.mkdir(parents=True, exist_ok=True)
        completed_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

        content = self._renderer.render_walkthrough(
            ticket, walkthrough,
            completed_by=completed_by,
            completed_at=completed_at,
        )
        path = await self._write_versioned(ticket_dir, "walkthrough.md", content)

        log.info("output_manager.walkthrough_saved", ticket_id=ticket.id, path=str(path))
        await self._mark_index_done(ticket.id)
        return path

    async def save_plans_to_dir(
        self,
        plan_id: str,
        gen_result: GenerationResult,
        plan_dir: "Path | None",
    ) -> SavedArtifacts:
        """
        Phase 7: Write plan.md (and task.md) into a specific plan_dir rather than
        the global output folder. plan_dir is LocateResult.plan_dir — the target
        repo's .quorum/ directory.
        Falls back to the global output path if plan_dir is None.
        """
        from qorum.adapters.base import NormalizedTicket, Platform, TicketSize
        root = plan_dir or (self._output_root / "plans")
        root.mkdir(parents=True, exist_ok=True)

        # Build a minimal synthetic ticket for the renderer
        plan_title = gen_result.plans[0].plan.summary[:80] if gen_result.plans else plan_id
        synthetic = NormalizedTicket(
            id=plan_id,
            platform=Platform.GITHUB_ISSUES,
            url="",
            title=plan_title,
            description="",
            acceptance_criteria=[],
            size=gen_result.size,
            item_type="story",
            status="open",
        )

        plan_paths: list[Path] = []
        for gp in gen_result.plans:
            phase_info = (
                PhaseInfo(
                    number=gp.phase_number,
                    total=len(gen_result.plans),
                    title=gp.phase_title or f"Phase {gp.phase_number}",
                )
                if gp.phase_number else None
            )
            target_dir = (
                root / f"phase-{gp.phase_number}-{gp.phase_name or 'plan'}"
                if phase_info else root
            )
            target_dir.mkdir(parents=True, exist_ok=True)

            plan_md = self._renderer.render_plan(synthetic, gp, phase_info)
            path = await self._write_versioned(target_dir, "plan.md", plan_md)
            plan_paths.append(path)

            # task.md — correct serialization (fixes B12)
            task_md = self._renderer.render_task(synthetic, gp.plan, phase_info)
            await self._write_versioned(target_dir, "task.md", task_md)

            log.info("output_manager.plan_saved_to_dir", plan_id=plan_id, path=str(path))

        return SavedArtifacts(
            ticket_id=plan_id,
            plan_paths=plan_paths,
            testing_paths=[],
            walkthrough_path=None,
        )

    def plan_exists(self, ticket_id: str) -> bool:
        """Check if a plan already exists for this ticket (for cache detection)."""
        return (self._ticket_dir(ticket_id) / "plan.md").exists()

    def get_plan_paths(self, ticket_id: str) -> list[Path]:
        """Return all plan.md paths for a ticket (handles phased tickets)."""
        ticket_dir = self._ticket_dir(ticket_id)
        if not ticket_dir.exists():
            return []
        # Standard ticket
        if (ticket_dir / "plan.md").exists():
            return [ticket_dir / "plan.md"]
        # Phased ticket — find all phase-*/plan.md
        return sorted(ticket_dir.glob("phase-*/plan.md"))

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _ticket_dir(self, ticket_id: str) -> Path:
        # Sanitize ticket_id for use as directory name
        safe_id = re.sub(r"[^\w\-.]", "_", ticket_id)
        return self._plans_root / safe_id

    def _phase_dir(self, ticket_dir: Path, gp: GeneratedPlan) -> Path:
        name = f"phase-{gp.phase_number}-{gp.phase_name or 'unknown'}"
        return ticket_dir / name

    def _make_phase_info(self, gp: GeneratedPlan, result: GenerationResult | None) -> PhaseInfo | None:
        if gp.phase_number is None:
            return None
        total = len(result.plans) if result else 1
        return PhaseInfo(
            number=gp.phase_number,
            total=total,
            title=gp.phase_title or f"Phase {gp.phase_number}",
        )

    def _ensure_dirs(self) -> None:
        self._output_root.mkdir(parents=True, exist_ok=True)
        self._plans_root.mkdir(parents=True, exist_ok=True)

    async def _write_versioned(self, directory: Path, filename: str, content: str) -> Path:
        """
        Write content to directory/filename.
        If file already exists, save previous as filename_v{n}.md and overwrite.
        Returns the path written.
        """
        target = directory / filename
        if target.exists():
            # Find next version number
            stem = Path(filename).stem
            suffix = Path(filename).suffix
            existing_versions = list(directory.glob(f"{stem}_v*.{suffix.lstrip('.')}"))
            next_version = len(existing_versions) + 2
            archived = directory / f"{stem}_v{next_version - 1}{suffix}"
            # Archive the current file before overwriting
            target.rename(archived)
            log.info("output_manager.version_archived", path=str(archived))

        async with aiofiles.open(target, "w", encoding="utf-8") as f:
            await f.write(content)

        return target

    async def _update_index(
        self,
        ticket: NormalizedTicket,
        result: GenerationResult,
        plan_paths: list[Path],
    ) -> None:
        """Add or update this ticket's entry in INDEX.md."""
        index_path = self._output_root / "INDEX.md"
        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        confidence = min(gp.plan.confidence_overall for gp in result.plans) if result.plans else 0
        phase_label = f"{len(result.plans)} phases" if result.size == TicketSize.LARGE else "standard"
        status = "PENDING_APPROVAL"

        entry = (
            f"| [{ticket.id}](plans/{ticket.id}/) "
            f"| {ticket.title[:50]}{'...' if len(ticket.title) > 50 else ''} "
            f"| {ticket.platform.value.replace('_', ' ').title()} "
            f"| {phase_label} "
            f"| {confidence}% "
            f"| {status} "
            f"| {now} |"
        )

        if not index_path.exists():
            header = (
                "# Qorum Plans Index\n\n"
                "| Ticket | Title | Platform | Size | Confidence | Status | Generated |\n"
                "|--------|-------|----------|------|-----------|--------|----------|\n"
            )
            async with aiofiles.open(index_path, "w", encoding="utf-8") as f:
                await f.write(header + entry + "\n")
        else:
            async with aiofiles.open(index_path, "r", encoding="utf-8") as f:
                existing = await f.read()

            # Remove existing entry for this ticket if present
            lines = existing.splitlines()
            lines = [l for l in lines if f"[{ticket.id}]" not in l]
            lines.append(entry)

            async with aiofiles.open(index_path, "w", encoding="utf-8") as f:
                await f.write("\n".join(lines) + "\n")

    async def _mark_index_done(self, ticket_id: str) -> None:
        """Update the ticket's INDEX.md entry to DONE status."""
        index_path = self._output_root / "INDEX.md"
        if not index_path.exists():
            return

        async with aiofiles.open(index_path, "r", encoding="utf-8") as f:
            content = await f.read()

        updated = re.sub(
            rf"(\[{re.escape(ticket_id)}\].*?)PENDING_APPROVAL",
            r"\1DONE ✅",
            content,
        )
        updated = re.sub(
            rf"(\[{re.escape(ticket_id)}\].*?)APPROVED",
            r"\1DONE ✅",
            updated,
        )

        async with aiofiles.open(index_path, "w", encoding="utf-8") as f:
            await f.write(updated)
