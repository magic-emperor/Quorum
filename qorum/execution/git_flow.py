"""
Phase 8 — Git lifecycle primitives.

All git operations go through async subprocess; no GitPython dependency.
Operates only on a local repo — push is never called from here.
"""
from __future__ import annotations

import asyncio
import re
import uuid
from pathlib import Path
from typing import Optional

from qorum.core.logger import get_logger
from qorum.execution.schemas import RollbackPoint

log = get_logger(__name__)

_GIT_TIMEOUT = 30


class GitFlowError(Exception):
    """Raised when a git operation fails."""


# ── Low-level git runner ──────────────────────────────────────────────────────

async def _git(args: list[str], cwd: Path, timeout: int = _GIT_TIMEOUT) -> tuple[int, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", *args,
            cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode or 0, stdout.decode("utf-8", errors="replace").strip()
    except asyncio.TimeoutError:
        return 1, "git command timed out"
    except FileNotFoundError:
        return 1, "git not found in PATH"


# ── Public API ────────────────────────────────────────────────────────────────

async def is_git_repo(path: Path) -> bool:
    if not path.exists():
        return False
    rc, _ = await _git(["rev-parse", "--git-dir"], path)
    return rc == 0


async def git_init(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    rc, out = await _git(["init", "-b", "main"], path)
    if rc != 0:
        # Older git without -b support
        rc, out = await _git(["init"], path)
    if rc != 0:
        raise GitFlowError(f"git init failed: {out}")
    log.info("git_flow.init", path=str(path))


async def current_branch(repo: Path) -> str:
    rc, out = await _git(["rev-parse", "--abbrev-ref", "HEAD"], repo)
    if rc != 0:
        raise GitFlowError(f"Could not determine current branch: {out}")
    return out.strip()


async def current_sha(repo: Path) -> str:
    rc, out = await _git(["rev-parse", "HEAD"], repo)
    if rc != 0:
        return "0000000"   # new repo with no commits
    return out.strip()


async def is_dirty(repo: Path) -> bool:
    """True if working tree has uncommitted changes."""
    rc, out = await _git(["status", "--porcelain"], repo)
    return bool(out.strip())


async def stash_push(repo: Path, message: str = "qorum: pre-execution stash") -> Optional[str]:
    """
    Stash working tree if dirty. Returns stash ref (e.g. 'stash@{0}') or None if clean.
    """
    if not await is_dirty(repo):
        return None
    rc, out = await _git(["stash", "push", "--include-untracked", "-m", message], repo)
    if rc != 0:
        raise GitFlowError(f"git stash push failed: {out}")
    # Parse stash ref from output like "Saved working directory ... stash@{0}"
    match = re.search(r"stash@\{(\d+)\}", out)
    ref = f"stash@{{{match.group(1)}}}" if match else "stash@{0}"
    log.info("git_flow.stash_pushed", repo=str(repo), ref=ref)
    return ref


async def stash_pop(repo: Path, stash_ref: str) -> None:
    rc, out = await _git(["stash", "pop", stash_ref], repo)
    if rc != 0:
        log.warning("git_flow.stash_pop_failed", ref=stash_ref, out=out)


async def create_branch(repo: Path, name: str, base: str = "HEAD") -> str:
    """
    Create + checkout branch off base. If branch already exists, suffix with -2, -3, …
    Returns the actual branch name used.
    """
    rc, out = await _git(["checkout", "-b", name, base], repo)
    if rc == 0:
        log.info("git_flow.branch_created", name=name)
        return name

    if "already exists" in out:
        # Branch exists — try suffixed names
        for i in range(2, 10):
            suffixed = f"{name}-{i}"
            rc, out = await _git(["checkout", "-b", suffixed, base], repo)
            if rc == 0:
                log.info("git_flow.branch_created", name=suffixed)
                return suffixed
        raise GitFlowError(f"Could not create branch {name}: all suffixes taken")

    raise GitFlowError(f"git checkout -b failed: {out}")


async def checkout_branch(repo: Path, name: str) -> None:
    rc, out = await _git(["checkout", name], repo)
    if rc != 0:
        raise GitFlowError(f"git checkout {name} failed: {out}")


async def stage_all(repo: Path) -> None:
    rc, out = await _git(["add", "-A"], repo)
    if rc != 0:
        raise GitFlowError(f"git add -A failed: {out}")


async def get_diff(repo: Path, staged: bool = True, max_chars: int = 16_000) -> str:
    """Return staged or unstaged diff, truncated to max_chars for chat display."""
    args = ["diff", "--staged"] if staged else ["diff"]
    rc, out = await _git(args, repo)
    if not out.strip():
        return "(no changes)"
    return out[:max_chars] + ("\n…(truncated)" if len(out) > max_chars else "")


async def get_status(repo: Path) -> str:
    rc, out = await _git(["status", "--short"], repo)
    return out or "(clean)"


class SecretsDetectedError(GitFlowError):
    """Raised when the pre-commit secrets guard finds a secret in the staged diff."""

    def __init__(self, findings: list) -> None:
        self.findings = findings
        kinds = ", ".join(f"{f.kind} (line {f.line_no})" for f in findings[:5])
        super().__init__(f"Commit blocked — secrets detected: {kinds}")


async def commit(
    repo: Path,
    message: str,
    allow_empty: bool = False,
    scan_secrets: bool = True,
) -> str:
    """
    Commit staged changes. Returns the new commit SHA.
    Raises GitFlowError if nothing to commit (unless allow_empty=True).

    Phase 14: runs a pre-commit secrets guard over the staged diff. If a secret
    is detected (and not allowlisted), raises SecretsDetectedError and does NOT
    commit. This is the enforcement point referenced in Phase 8.
    """
    if scan_secrets:
        from qorum.security.secrets import scan_diff_for_secrets
        staged_diff = await get_diff(repo, staged=True, max_chars=200_000)
        findings = scan_diff_for_secrets(staged_diff, repo_root=repo)
        if findings:
            log.warning("git_flow.commit_blocked_secrets", count=len(findings))
            raise SecretsDetectedError(findings)

    args = ["commit", "-m", message]
    if allow_empty:
        args.append("--allow-empty")
    rc, out = await _git(args, repo)
    if rc != 0:
        if "nothing to commit" in out:
            if allow_empty:
                return await current_sha(repo)
            raise GitFlowError("Nothing to commit.")
        raise GitFlowError(f"git commit failed: {out}")
    sha = await current_sha(repo)
    log.info("git_flow.committed", sha=sha[:8], repo=str(repo))
    return sha


async def delete_branch(repo: Path, name: str) -> None:
    rc, out = await _git(["branch", "-D", name], repo)
    if rc != 0:
        log.warning("git_flow.branch_delete_failed", name=name, out=out)


async def reset_hard(repo: Path, ref: str = "HEAD") -> None:
    rc, out = await _git(["reset", "--hard", ref], repo)
    if rc != 0:
        raise GitFlowError(f"git reset --hard {ref} failed: {out}")


# ── Rollback snapshot ─────────────────────────────────────────────────────────

async def snapshot_rollback_point(
    plan_id: str,
    repo: Path,
    exec_branch: str,
    base_branch: str,
    stash_ref: Optional[str],
) -> RollbackPoint:
    sha = await current_sha(repo)
    rp = RollbackPoint(
        plan_id=plan_id,
        repo=repo,
        base_branch=base_branch,
        exec_branch=exec_branch,
        stash_ref=stash_ref,
        base_commit_sha=sha,
    )
    _save_rollback_point(rp, repo)
    return rp


async def discard_execution(rp: RollbackPoint) -> None:
    """
    Restore repo to pre-execution state:
    1. Checkout base branch
    2. Delete the execution branch
    3. Pop the stash (if any)
    """
    repo = rp.repo
    try:
        await checkout_branch(repo, rp.base_branch)
    except GitFlowError:
        await _git(["checkout", "-f", rp.base_branch], repo)

    await delete_branch(repo, rp.exec_branch)

    if rp.stash_ref:
        await stash_pop(repo, rp.stash_ref)

    log.info("git_flow.discarded", plan_id=rp.plan_id, branch=rp.exec_branch)


# ── Commit message builder ────────────────────────────────────────────────────

def build_commit_message(
    plan_title: str,
    work_type: str,
    summary: str,
    change_log_text: str,
    plan_path: Optional[str] = None,
    ticket_url: Optional[str] = None,
    approved_by: Optional[list[str]] = None,
) -> str:
    """
    Build the structured commit message.
    Format:
      <type>(<scope>): <plan title>

      <summary>

      Changes:
        path: action — why
      ...
      Plan: .quorum/plans/.../plan.md
      Ticket: <url>
      Approved-by: @alice @bob
      Co-Authored-By: Qorum <noreply@qorum.dev>
    """
    type_map = {
        "bug": "fix",
        "feature": "feat",
        "enhancement": "feat",
        "refactor": "refactor",
        "chore": "chore",
        "question": "docs",
    }
    commit_type = type_map.get(work_type, "feat")

    # Derive scope from plan title (first word or two)
    words = re.sub(r"[^\w\s]", "", plan_title.lower()).split()
    scope = words[0] if words else "core"

    header = f"{commit_type}({scope}): {plan_title}"
    parts = [header, "", summary, "", change_log_text]

    if plan_path:
        parts.append(f"Plan: {plan_path}")
    if ticket_url:
        parts.append(f"Ticket: {ticket_url}")
    if approved_by:
        parts.append(f"Approved-by: {' '.join(approved_by)}")
    parts.append("Co-Authored-By: Qorum <noreply@qorum.dev>")

    return "\n".join(parts)


# ── Persistence helpers ───────────────────────────────────────────────────────

def _save_rollback_point(rp: RollbackPoint, repo: Path) -> None:
    import json
    rp_dir = repo / ".quorum" / "rollback_points"
    rp_dir.mkdir(parents=True, exist_ok=True)
    path = rp_dir / f"{rp.plan_id}-{rp.point_id}.json"
    path.write_text(json.dumps(rp.to_dict(), indent=2), encoding="utf-8")
