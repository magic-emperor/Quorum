"""
Phase 8 — Execution runner.

execute() drives an approved plan through the agent harness inside the target repo:
  1. Pre-flight: assert APPROVED, ensure git repo, stash dirty tree, create branch
  2. Execute: run each agent in the route, collect ToolEvents → ChangeLog
  3. Post: stage, produce diff, return ExecutionResult (no commit yet)

Commit only happens in commit_result() after explicit diff approval.
Push is never called here.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Optional

from qorum.agent_harness import run_agent
from qorum.agents.loader import load_agent
from qorum.execution.change_log import build_change_log, render_for_commit_message
from qorum.execution.git_flow import (
    GitFlowError,
    build_commit_message,
    checkout_branch,
    commit,
    create_branch,
    discard_execution,
    get_diff,
    get_status,
    git_init,
    is_dirty,
    is_git_repo,
    snapshot_rollback_point,
    stage_all,
    stash_push,
)
from qorum.execution.schemas import ChangeLogEntry, ExecutionResult, RollbackPoint
from qorum.core.logger import get_logger
from qorum.tools.base import ToolContext
from qorum.tools.events import ToolEvent
from qorum.tools.policy import ToolPolicy
from qorum.tools.registry import build_registry

if TYPE_CHECKING:
    from qorum.collaboration.schemas import LocateResult
    from qorum.core.schemas import PlanOutput

log = get_logger(__name__)


class ExecutionRunner:
    """
    Drives an approved plan through the agent harness on a git branch.
    One instance per plan execution.
    """

    def __init__(
        self,
        plan: "PlanOutput",
        plan_id: str,
        locate: "LocateResult",
        agent_route: list[str],
        work_type: str = "enhancement",
        ticket_url: Optional[str] = None,
        approved_by: Optional[list[str]] = None,
        on_event: Optional[Callable] = None,
        quorum_dir: Optional[Path] = None,
        run_gate: bool = True,
        max_fix_attempts: int = 2,
        gate_timeout: int = 300,
        registry_entry: Optional[dict] = None,
        run_security_gate: bool = False,
        security_threshold: str = "high",
        security_dependency_audit: bool = True,
        config: "Any" = None,
        cancel_token: "Any" = None,
    ) -> None:
        self._plan = plan
        self._plan_id = plan_id
        self._locate = locate
        self._route = agent_route
        self._work_type = work_type
        self._ticket_url = ticket_url
        self._approved_by = approved_by or []
        self._on_event = on_event or (lambda e: None)
        self._quorum_dir = quorum_dir
        self._run_gate = run_gate
        self._max_fix_attempts = max_fix_attempts
        self._gate_timeout = gate_timeout
        self._registry_entry = registry_entry or {}
        self._run_security_gate = run_security_gate
        self._security_threshold = security_threshold
        self._security_dependency_audit = security_dependency_audit
        self._config = config
        self._cancel_token = cancel_token   # CancellationToken (created by the bot layer)

    async def execute(self) -> ExecutionResult:
        """
        Run pre-flight → agents → stage → diff.
        Returns ExecutionResult. Does NOT commit.
        """
        repo = self._locate.target_repo or self._locate.scaffold_path
        if not repo:
            return self._error("No target repo resolved.")

        # ── 1. Pre-flight ─────────────────────────────────────────────────────

        # Ensure it's a git repo (init if NEW_PROJECT scaffold)
        if not await is_git_repo(repo):
            log.info("runner.git_init", repo=str(repo))
            await git_init(repo)
            # Create an empty initial commit so we can branch
            (repo / ".gitkeep").touch()
            await _git_direct(["add", ".gitkeep"], repo)
            await _git_direct(["commit", "-m", "chore: init qorum scaffold"], repo)

        base_branch = self._locate.default_branch
        try:
            from qorum.execution.git_flow import current_branch
            base_branch = await current_branch(repo)
        except GitFlowError:
            pass

        # Stash dirty working tree
        stash_ref = await stash_push(repo, f"qorum: pre-execution stash for {self._plan_id}")

        # Create execution branch
        branch_name = f"qorum/{self._plan_id[:16]}"
        try:
            branch_name = await create_branch(repo, branch_name, base=base_branch)
        except GitFlowError as exc:
            if stash_ref:
                from qorum.execution.git_flow import stash_pop
                await stash_pop(repo, stash_ref)
            return self._error(str(exc))

        # Snapshot rollback point
        rp = await snapshot_rollback_point(
            self._plan_id, repo, branch_name, base_branch, stash_ref
        )

        log.info(
            "runner.preflight_done",
            plan_id=self._plan_id,
            branch=branch_name,
            repo=str(repo),
            stashed=bool(stash_ref),
        )

        # ── 2. Execute agents ──────────────────────────────────────────────────
        all_events: list[ToolEvent] = []
        transcript_path: Optional[Path] = None
        cancelled = False

        # Provider registry (real execution needs config; tests mock run_agent).
        provider_registry = None
        if self._config is not None:
            from qorum.providers.registry import ProviderRegistry
            provider_registry = ProviderRegistry(self._config)

        def _emit(e: ToolEvent) -> None:
            all_events.append(e)
            self._on_event(e)

        try:
            policy = ToolPolicy(repo_root=repo, allow_git_commit=False, allow_git_push=False)
            task_description = self._build_task(self._plan, branch_name)

            for agent_name in self._route:
                # Safe point: stop before starting another agent.
                if self._is_cancelled():
                    cancelled = True
                    break

                try:
                    agent_def = load_agent(agent_name)
                except Exception as exc:
                    log.warning("runner.agent_not_found", agent=agent_name, error=str(exc))
                    continue

                log.info("runner.agent_start", agent=agent_name)
                tool_registry = build_registry(getattr(agent_def, "allowed_tools", []) or [])
                ctx = ToolContext(
                    cwd=repo, policy=policy,
                    on_event=_emit, cancel_token=self._cancel_token,
                )
                result = await run_agent(
                    agent_def,
                    task_description,
                    tool_registry,
                    ctx,
                    provider_registry,
                    on_event=_emit,
                    quorum_dir=self._quorum_dir,
                    cancel_token=self._cancel_token,
                )

                if getattr(result, "cancelled", False):
                    cancelled = True
                    log.info("runner.agent_cancelled", agent=agent_name)
                    if transcript_path is None and result.run_id and self._quorum_dir:
                        transcript_path = (
                            self._quorum_dir / "context" / "sessions" / f"{result.run_id}.json"
                        )
                    break

                if not result.ok:
                    log.warning("runner.agent_failed", agent=agent_name, error=result.error)

                if result.ok and transcript_path is None and result.run_id:
                    if self._quorum_dir:
                        transcript_path = (
                            self._quorum_dir / "context" / "sessions" / f"{result.run_id}.json"
                        )

        except Exception as exc:
            log.exception("runner.execute_error", plan_id=self._plan_id)
            return ExecutionResult(
                plan_id=self._plan_id,
                branch=branch_name,
                change_log=[],
                diff_summary=f"Execution failed: {exc}",
                transcript_path=transcript_path,
                rollback_point=rp,
                ok=False,
                error=str(exc),
            )

        # ── 3. Stage + diff ────────────────────────────────────────────────────
        await stage_all(repo)
        diff = await get_diff(repo, staged=True)
        status = await get_status(repo)

        change_log = build_change_log(
            all_events, repo, self._plan.file_change_intent
        )

        # If no events recorded file changes, infer from git status
        if not change_log and status.strip() and status != "(clean)":
            change_log = _infer_from_status(status)

        # ── Cancelled: capture partial work, skip gates, return early ─────────
        if cancelled:
            self._emit_cancelled_event()
            log.info(
                "runner.execution_cancelled",
                plan_id=self._plan_id, branch=branch_name,
                files_changed=len(change_log),
            )
            return ExecutionResult(
                plan_id=self._plan_id,
                branch=branch_name,
                change_log=change_log,
                diff_summary=diff,
                transcript_path=transcript_path,
                rollback_point=rp,
                ok=True,
                cancelled=True,
            )

        # ── 4. Gate: build + test verification ───────────────────────────────
        gate_result = None
        if self._run_gate:
            from qorum.execution.project_detect import detect
            from qorum.execution.gate import run_gate_with_fix
            detect_overrides = {}
            if self._registry_entry:
                detect_overrides = {
                    k: self._registry_entry.get(k)
                    for k in ("build_cmd", "test_cmd", "install_cmd")
                    if self._registry_entry.get(k)
                }
            detect_result = detect(repo, detect_overrides)
            log_dir = (self._quorum_dir / "context" / "gate") if self._quorum_dir else None
            gate_result = await run_gate_with_fix(
                repo=repo,
                detect=detect_result,
                runner=self,
                on_event=self._on_event,
                max_attempts=self._max_fix_attempts,
                timeout=self._gate_timeout,
                log_dir=log_dir,
                changed_paths=[e.path for e in change_log],
            )
            log.info(
                "runner.gate_done",
                plan_id=self._plan_id,
                verdict=gate_result.verdict,
                failed_tests=len(gate_result.failed_tests),
            )

        # ── 5. Security gate (Phase 14) — after build/test, before commit ────
        security_result = None
        if self._run_security_gate:
            from qorum.execution.project_detect import detect as _detect
            from qorum.security.scan import run_security_gate
            lang = _detect(repo).language
            security_result = await run_security_gate(
                repo=repo,
                language=lang,
                diff_text=diff,
                block_threshold=self._security_threshold,
                run_dependency=self._security_dependency_audit,
                on_event=self._on_event,
            )
            log.info(
                "runner.security_done",
                plan_id=self._plan_id,
                verdict=security_result.verdict,
                blocking=len(security_result.blocking_findings),
            )

        log.info(
            "runner.execution_complete",
            plan_id=self._plan_id,
            branch=branch_name,
            files_changed=len(change_log),
        )

        return ExecutionResult(
            plan_id=self._plan_id,
            branch=branch_name,
            change_log=change_log,
            diff_summary=diff,
            transcript_path=transcript_path,
            rollback_point=rp,
            ok=True,
            gate_result=gate_result,
            security_result=security_result,
        )

    async def commit_result(
        self,
        result: ExecutionResult,
        plan_path: Optional[str] = None,
    ) -> str:
        """
        Called after developer approves the diff.
        Builds the structured commit message and commits staged changes.
        Returns the commit SHA.
        """
        repo = result.rollback_point.repo
        cl_text = render_for_commit_message(result.change_log)
        message = build_commit_message(
            plan_title=self._plan.summary[:60],
            work_type=self._work_type,
            summary=self._plan.summary,
            change_log_text=cl_text,
            plan_path=plan_path,
            ticket_url=self._ticket_url,
            approved_by=self._approved_by,
        )
        sha = await commit(repo, message)
        log.info("runner.committed", sha=sha[:8], plan_id=self._plan_id)
        return sha

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _is_cancelled(self) -> bool:
        return self._cancel_token is not None and self._cancel_token.is_cancelled()

    def _emit_cancelled_event(self) -> None:
        self._on_event(ToolEvent(
            kind="cancelled", agent="runner",
            summary="Execution stopped by the developer.", ok=True,
        ))

    def _build_task(self, plan: "PlanOutput", branch: str) -> str:
        tasks = "\n".join(f"  - [{t.id}] {t.title}: {t.description}" for t in plan.sub_tasks)
        return (
            f"Implement the following approved plan on branch `{branch}`.\n\n"
            f"## Summary\n{plan.summary}\n\n"
            f"## Sub-tasks\n{tasks}\n\n"
            f"## Definition of Done\n"
            + "\n".join(f"  - {d}" for d in plan.definition_of_done)
            + "\n\nFor each file you edit, include a 'reason' label explaining why."
        )

    def _error(self, msg: str) -> ExecutionResult:
        from qorum.execution.schemas import RollbackPoint
        from datetime import datetime, timezone
        dummy_rp = RollbackPoint(
            plan_id=self._plan_id,
            repo=Path("."),
            base_branch="main",
            exec_branch="",
            stash_ref=None,
            base_commit_sha="",
        )
        return ExecutionResult(
            plan_id=self._plan_id,
            branch="",
            change_log=[],
            diff_summary="",
            transcript_path=None,
            rollback_point=dummy_rp,
            ok=False,
            error=msg,
        )


# ── Module-level helpers ──────────────────────────────────────────────────────

async def _git_direct(args: list[str], cwd: Path) -> None:
    import asyncio
    proc = await asyncio.create_subprocess_exec(
        "git", *args, cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    await proc.communicate()


def _infer_from_status(status: str) -> list[ChangeLogEntry]:
    """Build minimal ChangeLogEntries from 'git status --short' output."""
    entries = []
    for line in status.splitlines():
        if len(line) < 4:
            continue
        code = line[:2].strip()
        path = line[3:].strip()
        action = {
            "A": "create", "M": "modify", "D": "delete", "R": "rename"
        }.get(code[0] if code else "M", "modify")
        entries.append(ChangeLogEntry(path=path, action=action, reason="inferred from git status"))
    return entries
