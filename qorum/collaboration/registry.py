"""
Phase 6 — Project registry.

Loads and saves qorum/registry.json — the mapping from chat channels / board
projects to local repo paths. This is the source of truth for the locator.

Registry format:
  {
    "mappings": [
      {
        "match": {"platform": "telegram", "channel_id": "-100123"},
        "repo_path": "D:/work/payments",
        "default_branch": "main",
        "label": "payments"          # optional human label
      },
      {
        "match": {"board_project": "PAY"},
        "repo_path": "D:/work/payments",
        "default_branch": "main"
      }
    ]
  }

match keys (any combination):
  platform + channel_id   → chat channel
  platform + workspace_id → whole workspace
  board_project           → ticket project key (e.g. "PAY", "PROJ")
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from qorum.core.logger import get_logger

log = get_logger(__name__)

_DEFAULT_REGISTRY_NAME = "registry.json"


class RegistryMapping:
    """One entry in the registry."""

    def __init__(self, data: dict) -> None:
        self.match: dict = data.get("match", {})
        self.repo_path: Optional[Path] = (
            Path(data["repo_path"]).expanduser().resolve()
            if data.get("repo_path") else None
        )
        self.default_branch: str = data.get("default_branch", "main")
        self.label: str = data.get("label", "")

    def matches_channel(self, platform: str, channel_id: str, workspace_id: Optional[str] = None) -> bool:
        m = self.match
        if "platform" in m and m["platform"] != platform:
            return False
        if "channel_id" in m:
            return m["channel_id"] == channel_id
        if "workspace_id" in m and workspace_id:
            return m["workspace_id"] == workspace_id
        return False

    def matches_board_project(self, project_key: str) -> bool:
        return self.match.get("board_project", "").upper() == project_key.upper()

    def to_dict(self) -> dict:
        d: dict = {"match": self.match}
        if self.repo_path:
            d["repo_path"] = str(self.repo_path)
        d["default_branch"] = self.default_branch
        if self.label:
            d["label"] = self.label
        return d


class ProjectRegistry:
    """
    Loads, queries, and saves the channel→repo mapping.
    One instance per application — pass the qorum config dir as root.
    """

    def __init__(self, registry_path: Path) -> None:
        self._path = registry_path
        self._mappings: list[RegistryMapping] = []
        self._load()

    @classmethod
    def from_config(cls, config_dir: Path) -> "ProjectRegistry":
        return cls(config_dir / _DEFAULT_REGISTRY_NAME)

    # ── Query ─────────────────────────────────────────────────────────────────

    def find_by_channel(
        self,
        platform: str,
        channel_id: str,
        workspace_id: Optional[str] = None,
    ) -> Optional[RegistryMapping]:
        for m in self._mappings:
            if m.matches_channel(platform, channel_id, workspace_id):
                if m.repo_path and m.repo_path.exists():
                    return m
                if m.repo_path:
                    log.warning(
                        "registry.repo_not_found",
                        repo=str(m.repo_path),
                        channel_id=channel_id,
                    )
        return None

    def find_by_board_project(self, project_key: str) -> Optional[RegistryMapping]:
        for m in self._mappings:
            if m.matches_board_project(project_key):
                if m.repo_path and m.repo_path.exists():
                    return m
        return None

    def all_repos(self) -> list[RegistryMapping]:
        return [m for m in self._mappings if m.repo_path]

    # ── Mutate ────────────────────────────────────────────────────────────────

    def add_channel_mapping(
        self,
        platform: str,
        channel_id: str,
        repo_path: Path,
        default_branch: str = "main",
        label: str = "",
    ) -> None:
        """Add or replace a channel→repo mapping and persist."""
        # Remove existing mapping for this channel
        self._mappings = [
            m for m in self._mappings
            if not m.matches_channel(platform, channel_id)
        ]
        self._mappings.append(RegistryMapping({
            "match": {"platform": platform, "channel_id": channel_id},
            "repo_path": str(repo_path.expanduser().resolve()),
            "default_branch": default_branch,
            "label": label,
        }))
        self._save()
        log.info("registry.mapped", platform=platform, channel=channel_id, repo=str(repo_path))

    def remove_channel_mapping(self, platform: str, channel_id: str) -> bool:
        before = len(self._mappings)
        self._mappings = [
            m for m in self._mappings
            if not m.matches_channel(platform, channel_id)
        ]
        if len(self._mappings) < before:
            self._save()
            return True
        return False

    # ── Persistence ───────────────────────────────────────────────────────────

    def _load(self) -> None:
        if not self._path.exists():
            self._mappings = []
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            self._mappings = [RegistryMapping(m) for m in data.get("mappings", [])]
            log.info("registry.loaded", count=len(self._mappings), path=str(self._path))
        except (json.JSONDecodeError, KeyError) as exc:
            log.error("registry.load_failed", path=str(self._path), error=str(exc))
            self._mappings = []

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        data = {"mappings": [m.to_dict() for m in self._mappings]}
        self._path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        log.info("registry.saved", path=str(self._path))

    def summary_lines(self) -> list[str]:
        """Human-readable summary for /qorum where command."""
        if not self._mappings:
            return ["No repos mapped yet. Use `/qorum map <repo-path>` to add one."]
        lines = ["*Qorum repo mappings:*\n"]
        for m in self._mappings:
            label = f" ({m.label})" if m.label else ""
            match_str = ", ".join(f"{k}={v}" for k, v in m.match.items())
            lines.append(f"• `{match_str}` → `{m.repo_path}`{label} [{m.default_branch}]")
        return lines
