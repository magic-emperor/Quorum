"""
Phase 6 — Project Locator.

Given an Intent + Classification, determines which repo the work targets and
whether it's a new project or an enhancement of existing code.

Resolution order:
  1. Registry lookup by channel_id / workspace_id / board_project
  2. If found: grep repo for referenced_paths/symbols → ENHANCEMENT
  3. If not found + "build new X" signals → NEW_PROJECT (scaffold dir)
  4. If not found + ambiguous → UNRESOLVED (ask user to /qorum map)
  5. If paths span multiple mapped repos → MULTI (ask which / offer split)

The plan_dir is always the target repo's .quorum/ directory.
B6 (plans landing in the wrong folder) is closed here.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from qorum.collaboration.registry import ProjectRegistry
from qorum.collaboration.schemas import LocateMode, LocateResult
from qorum.core.logger import get_logger

if TYPE_CHECKING:
    from qorum.collaboration.classifier import Classification
    from qorum.collaboration.intent import Intent
    from qorum.config import QorumConfig

log = get_logger(__name__)

# Phrases in decisions/context that signal a brand-new project.
_NEW_PROJECT_RE = re.compile(
    r"\b(build|create|start|scaffold|new service|new app|new project|new repo|"
    r"from scratch|greenfield)\b",
    re.IGNORECASE,
)

_QUORUM_DIR = ".quorum"


class ProjectLocator:
    """
    Resolves a LocateResult for an Intent.
    Stateless per-call; takes a pre-loaded registry.
    """

    def __init__(self, registry: ProjectRegistry, config: "QorumConfig") -> None:
        self._registry = registry
        self._workspace_dir = getattr(config, "qorum_workspace_dir", None)

    async def locate(self, intent: "Intent", classification: "Classification") -> LocateResult:
        """
        Resolve where the work lands.
        Returns a LocateResult — always check .is_resolved before proceeding.
        """
        channel_id = intent.raw_ref.get("channel_id", "")
        workspace_id = intent.raw_ref.get("workspace_id")
        # platform_ids keys are platform names: {"telegram": "123"} → first key is the platform
        platform = next(iter(intent.author.platform_ids), intent.source)

        referenced_paths = []
        if intent.summary:
            referenced_paths = intent.summary.referenced_paths

        # ── 1. Registry lookup ────────────────────────────────────────────────
        mapping = self._registry.find_by_channel(platform, channel_id, workspace_id)

        # Board path: look up by project key from ticket
        if mapping is None and intent.ticket:
            project_key = _extract_project_key(intent.ticket.id)
            if project_key:
                mapping = self._registry.find_by_board_project(project_key)

        # ── 2. Multi-repo check (paths mention files in different repos) ──────
        if mapping is None:
            all_repos = self._registry.all_repos()
            hits = _find_matching_repos(all_repos, referenced_paths)
            if len(hits) > 1:
                return LocateResult(
                    mode="MULTI",
                    confidence=0.7,
                    why=f"Referenced paths found in {len(hits)} different repos.",
                    clarifying_question=(
                        "This work seems to touch multiple repos. Which one should I target, "
                        "or should I split into separate plans?"
                    ),
                )

        # ── 3. Found a mapped repo ────────────────────────────────────────────
        if mapping and mapping.repo_path:
            repo = mapping.repo_path
            evidence = _grep_repo(repo, referenced_paths)
            plan_dir = _resolve_plan_dir(repo, referenced_paths, evidence)

            return LocateResult(
                mode="ENHANCEMENT",
                target_repo=repo,
                plan_dir=plan_dir,
                default_branch=mapping.default_branch,
                confidence=0.9 if evidence else 0.6,
                why=(
                    f"Channel mapped to `{repo.name}`; "
                    + (f"found {len(evidence)} matching file(s)." if evidence else "no referenced files found, defaulting to repo root.")
                ),
                evidence=evidence,
            )

        # ── 4. No mapping — check for new-project signals ─────────────────────
        if _signals_new_project(intent):
            slug = _slugify(intent.title_hint or "new-project")
            workspace = Path(self._workspace_dir) if self._workspace_dir else Path.cwd() / "qorum-workspace"
            scaffold = workspace / slug
            return LocateResult(
                mode="NEW_PROJECT",
                scaffold_path=scaffold,
                plan_dir=scaffold / _QUORUM_DIR,
                default_branch="main",
                confidence=0.75,
                why="No repo mapped and intent describes building something new.",
            )

        # ── 5. Unresolved ─────────────────────────────────────────────────────
        return LocateResult(
            mode="UNRESOLVED",
            confidence=0.0,
            why="No repo is mapped for this channel and work type is unclear.",
            clarifying_question=(
                "I don't know which codebase this belongs to. "
                "Run `/qorum map <repo-path>` in this channel, then try again."
            ),
        )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _grep_repo(repo: Path, paths: list[str]) -> list[str]:
    """
    Search the repo for referenced file paths / symbols.
    Returns a list of 'filepath:line_number: snippet' evidence strings.
    Uses git ls-files first (fast), falls back to ripgrep/grep.
    """
    if not paths or not repo.exists():
        return []

    evidence: list[str] = []
    for ref in paths[:10]:   # cap to avoid blowing up on huge path lists
        ref_clean = ref.strip("/").strip()
        if not ref_clean:
            continue

        # Fast path: check if a file/dir with this name exists under the repo
        matches = list(repo.rglob(f"*{ref_clean}*"))
        if matches:
            evidence.append(f"{matches[0].relative_to(repo)}: file exists")
            continue

        # Fallback: grep for the symbol in source files
        try:
            result = subprocess.run(
                ["git", "grep", "-l", "-i", "--", ref_clean],
                cwd=str(repo),
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0 and result.stdout.strip():
                for line in result.stdout.strip().splitlines()[:2]:
                    evidence.append(f"{line}: contains '{ref_clean}'")
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass

    return evidence


def _find_matching_repos(
    mappings: list,
    referenced_paths: list[str],
) -> list:
    """Return the subset of mappings whose repo contains any referenced path."""
    if not referenced_paths:
        return []
    hits = []
    for m in mappings:
        if m.repo_path and _grep_repo(m.repo_path, referenced_paths):
            hits.append(m)
    return hits


def _resolve_plan_dir(repo: Path, referenced_paths: list[str], evidence: list[str]) -> Path:
    """
    Decide where .quorum/ lives inside the repo.
    If evidence points to a single sub-module, use module-scoped dir; else repo root.
    """
    if not evidence:
        return repo / _QUORUM_DIR

    # If all evidence paths share a top-level directory, use module-scoped .quorum/
    top_dirs = set()
    for e in evidence:
        parts = Path(e.split(":")[0]).parts
        if parts:
            top_dirs.add(parts[0])

    if len(top_dirs) == 1:
        candidate = repo / top_dirs.pop() / _QUORUM_DIR
        # Only use module-scoped dir if the parent dir actually exists
        if candidate.parent.exists():
            return candidate

    return repo / _QUORUM_DIR


def _signals_new_project(intent: "Intent") -> bool:
    """Return True if the intent clearly describes building something new."""
    texts = []
    if intent.summary:
        texts.extend(intent.summary.decisions)
        texts.append(intent.summary.context)
        texts.extend(intent.summary.candidate_titles)
    elif intent.ticket:
        texts.append(intent.ticket.title)
        if intent.ticket.description:
            texts.append(intent.ticket.description)
    combined = " ".join(texts)
    return bool(_NEW_PROJECT_RE.search(combined))


def _extract_project_key(ticket_id: str) -> Optional[str]:
    """Extract Jira-style project key from ticket ID (e.g. 'PAY-123' → 'PAY')."""
    match = re.match(r"^([A-Z]{2,10})-\d+$", ticket_id)
    return match.group(1) if match else None


def _slugify(text: str) -> str:
    """Convert a title to a filesystem-safe slug."""
    slug = re.sub(r"[^\w\s-]", "", text.lower())
    slug = re.sub(r"[\s_-]+", "-", slug).strip("-")
    return slug[:40] or "project"
