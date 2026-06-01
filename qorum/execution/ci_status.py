"""
Phase 9 — Optional remote CI status poller (GitHub Actions / Azure Pipelines).

Off by default. Activated by setting qorum_ci_provider in config.
Read-only — never triggers or merges anything.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import TYPE_CHECKING, Optional

from qorum.core.logger import get_logger

if TYPE_CHECKING:
    from qorum.config import QorumConfig

log = get_logger(__name__)


class CIStatus(str, Enum):
    PENDING  = "pending"
    RUNNING  = "running"
    SUCCESS  = "success"
    FAILURE  = "failure"
    CANCELLED = "cancelled"
    UNKNOWN  = "unknown"


@dataclass
class CIRunResult:
    provider: str
    run_id: str
    status: CIStatus
    conclusion: Optional[str]    # "success" | "failure" | "skipped" | etc.
    url: Optional[str]
    name: str = ""
    checked_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def is_terminal(self) -> bool:
        return self.status in (CIStatus.SUCCESS, CIStatus.FAILURE, CIStatus.CANCELLED)

    def summary(self) -> str:
        icon = {"success": "✅", "failure": "❌", "cancelled": "⏹"}.get(
            self.conclusion or self.status.value, "⏳"
        )
        return f"{icon} CI ({self.provider}): {self.name} — {self.conclusion or self.status.value}"


async def poll_github_checks(
    repo_owner: str,
    repo_name: str,
    commit_sha: str,
    github_token: str,
    run_name_filter: Optional[str] = None,
) -> list[CIRunResult]:
    """
    Fetch GitHub Actions check runs for a commit SHA.
    Returns a list of CIRunResult — empty if the token is missing or the API is down.
    """
    try:
        import aiohttp
    except ImportError:
        log.debug("ci_status.aiohttp_missing")
        return []

    url = f"https://api.github.com/repos/{repo_owner}/{repo_name}/commits/{commit_sha}/check-runs"
    headers = {
        "Authorization": f"token {github_token}",
        "Accept": "application/vnd.github.v3+json",
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status != 200:
                    log.warning("ci_status.github_api_error", status=resp.status)
                    return []
                data = await resp.json()
    except Exception as exc:
        log.warning("ci_status.fetch_failed", error=str(exc))
        return []

    results = []
    for run in data.get("check_runs", []):
        name = run.get("name", "")
        if run_name_filter and run_name_filter.lower() not in name.lower():
            continue
        results.append(CIRunResult(
            provider="github",
            run_id=str(run.get("id", "")),
            status=CIStatus(run.get("status", "unknown")),
            conclusion=run.get("conclusion"),
            url=run.get("html_url"),
            name=name,
        ))
    return results


async def get_ci_status(
    config: "QorumConfig",
    commit_sha: str,
    repo_owner: Optional[str] = None,
    repo_name: Optional[str] = None,
) -> list[CIRunResult]:
    """
    Dispatch to the configured CI provider. Returns [] if not configured.
    """
    provider = getattr(config, "qorum_ci_provider", None)
    if not provider:
        return []

    if provider == "github":
        token = getattr(config, "github_token", None) or ""
        if not token or not repo_owner or not repo_name:
            return []
        return await poll_github_checks(repo_owner, repo_name, commit_sha, token)

    log.debug("ci_status.unsupported_provider", provider=provider)
    return []
