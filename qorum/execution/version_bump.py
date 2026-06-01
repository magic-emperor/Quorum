"""
Version bump handler.

When Qorum classifies an intent as 'version_bump', this module:
1. Detects the target version from the intent text
2. Creates a release/<version> branch
3. Updates the version in pyproject.toml / package.json / build.gradle / Cargo.toml
4. Commits with a standard message
5. Returns the branch and commit for the diff-review card (no push — developer approves)
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from qorum.core.logger import get_logger

log = get_logger(__name__)

# Regex to extract a semver from free text: "bump to 2.1.0", "release 3.0.0-beta.1", etc.
_VERSION_RE = re.compile(
    r"\b(?:to|version|v|release|bump|tag)?\s*v?(\d+\.\d+\.\d+(?:[-+][.\w]+)?)\b",
    re.IGNORECASE,
)

# Per-toolchain version file patterns
_VERSION_FILES: list[tuple[str, re.Pattern, str]] = [
    # (glob_pattern, search_regex, replacement_template)
    ("pyproject.toml",   re.compile(r'^(version\s*=\s*")[^"]+(")', re.MULTILINE), r'\g<1>{version}\g<2>'),
    ("package.json",     re.compile(r'^(\s*"version"\s*:\s*")[^"]+(")', re.MULTILINE), r'\g<1>{version}\g<2>'),
    ("Cargo.toml",       re.compile(r'^(version\s*=\s*")[^"]+(")', re.MULTILINE), r'\g<1>{version}\g<2>'),
    ("build.gradle",     re.compile(r"(version\s*=\s*')[^']+(')"), r"\g<1>{version}\g<2>"),
    ("build.gradle.kts", re.compile(r'(version\s*=\s*")[^"]+(")'), r'\g<1>{version}\g<2>'),
]


def extract_version(text: str) -> Optional[str]:
    """Pull the target version string out of a natural-language request."""
    match = _VERSION_RE.search(text)
    return match.group(1) if match else None


def find_and_patch_version_file(repo_root: Path, new_version: str) -> Optional[Path]:
    """
    Find the first matching version file in repo_root, patch it in-place,
    and return the relative path. Returns None if no version file is found.
    """
    for glob_pattern, search_re, replacement in _VERSION_FILES:
        for candidate in repo_root.rglob(glob_pattern):
            # Skip node_modules, .venv, _archive
            if any(p in candidate.parts for p in ("node_modules", ".venv", "_archive", "dist")):
                continue
            content = candidate.read_text(encoding="utf-8")
            new_content, n = search_re.subn(
                replacement.replace("{version}", new_version), content
            )
            if n > 0:
                candidate.write_text(new_content, encoding="utf-8")
                log.info("version_bump.patched", file=str(candidate.relative_to(repo_root)),
                         version=new_version)
                return candidate.relative_to(repo_root)
    return None


async def run_version_bump(
    intent_text: str,
    repo_root: Path,
    git_flow,       # qorum.execution.git_flow module (passed to avoid circular import)
) -> dict:
    """
    Full version-bump flow. Returns a result dict with keys:
      version, branch, patched_file, commit_sha, error (if any)
    """
    version = extract_version(intent_text)
    if not version:
        return {"error": f"Could not find a version number in: {intent_text!r}"}

    branch_name = f"release/{version}"
    log.info("version_bump.start", version=version, branch=branch_name, repo=str(repo_root))

    # Create branch
    branch_result = await git_flow.create_branch(repo_root, branch_name)
    if not branch_result.ok:
        return {"error": f"Could not create branch {branch_name}: {branch_result.output}"}

    # Patch version file
    patched = find_and_patch_version_file(repo_root, version)
    if not patched:
        return {"error": f"No version file found in {repo_root}"}

    # Stage and commit
    commit_msg = f"chore: bump version to {version}"
    commit_result = await git_flow.stage_and_commit(repo_root, [str(patched)], commit_msg)
    if not commit_result.ok:
        return {"error": f"Commit failed: {commit_result.output}"}

    return {
        "version": version,
        "branch": branch_name,
        "patched_file": str(patched),
        "commit_sha": commit_result.data.get("sha", ""),
        "commit_msg": commit_msg,
    }
