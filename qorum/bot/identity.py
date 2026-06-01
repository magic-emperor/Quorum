"""
Phase 12 — Bot identity mapping.

Maps platform user IDs (Teams AAD object id, Telegram user id, etc.) to
Qorum contributor records in .quorum/collaboration/contributors.json.

Used by the quorum engine to resolve required approvers and enforce
"only authorized approvers can approve."

contributors.json format:
  [
    {
      "name": "Alice Smith",
      "email": "alice@company.com",
      "is_lead": true,
      "platforms": {
        "teams_id": "aad-object-id-uuid",
        "telegram_id": "123456789"
      }
    }
  ]
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from qorum.core.logger import get_logger

log = get_logger(__name__)

_CONTRIBUTORS_FILE = "collaboration/contributors.json"


# Known platform id keys (Phase 14 — cross-platform unification)
PLATFORM_KEYS = (
    "teams_id", "slack_id", "discord_id", "telegram_id",
    "whatsapp_phone", "board_account",
)


class Contributor:
    def __init__(self, data: dict) -> None:
        self.name: str = data.get("name", "")
        self.email: str = data.get("email", "")
        # role supersedes is_lead; keep is_lead for backward compatibility
        self.role: str = data.get("role") or ("lead" if data.get("is_lead") else "dev")
        self.platforms: dict[str, str] = data.get("platforms", {})

    @property
    def is_lead(self) -> bool:
        return self.role == "lead"

    def get_platform_id(self, platform: str) -> Optional[str]:
        # Accept both "teams" → "teams_id" and direct "whatsapp" → "whatsapp_phone"
        if platform == "whatsapp":
            return self.platforms.get("whatsapp_phone")
        if platform == "board":
            return self.platforms.get("board_account")
        return self.platforms.get(f"{platform}_id")

    def set_platform_id(self, platform: str, platform_id: str) -> None:
        if platform == "whatsapp":
            self.platforms["whatsapp_phone"] = platform_id
        elif platform == "board":
            self.platforms["board_account"] = platform_id
        else:
            self.platforms[f"{platform}_id"] = platform_id

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "email": self.email,
            "role": self.role,
            "platforms": self.platforms,
        }


class IdentityMap:
    """
    Loads and queries the contributor registry for a target repo.
    One instance per repo (keyed by quorum_dir).
    """

    def __init__(self, quorum_dir: Path) -> None:
        self._path = quorum_dir / _CONTRIBUTORS_FILE
        self._contributors: list[Contributor] = []
        # Phase 14: pending /qorum link verifications — code → (name, platform, user_id)
        self._pending_links: dict[str, tuple[str, str, str]] = {}
        self._load()

    def find_by_platform_id(self, platform: str, platform_id: str) -> Optional[Contributor]:
        """Look up a contributor by platform-specific id (e.g. Teams AAD id)."""
        for c in self._contributors:
            if c.get_platform_id(platform) == platform_id:
                return c
        return None

    def resolve_contributor(self, platform: str, platform_user_id: str) -> Optional[Contributor]:
        """
        Phase 14: cross-platform resolution. Given any platform + user id, return
        the unified Contributor. Used by the quorum engine so "approve in Teams"
        and "approve in Slack" count as the same person.
        """
        return self.find_by_platform_id(platform, platform_user_id)

    def find_by_name(self, name: str) -> Optional[Contributor]:
        """Find by display name (partial, case-insensitive)."""
        name_lower = name.lower().lstrip("@")
        for c in self._contributors:
            if name_lower in c.name.lower() or name_lower in c.email.lower():
                return c
        return None

    def get_lead(self) -> Optional[Contributor]:
        """Return the designated lead contributor (for lead-only quorum rule)."""
        for c in self._contributors:
            if c.is_lead:
                return c
        return None

    def all_contributors(self) -> list[Contributor]:
        return list(self._contributors)

    def resolve_approvers(self, required: list[str], platform: str) -> list[str]:
        """
        Resolve a list of @names or platform IDs to canonical platform IDs
        for the quorum engine.
        """
        resolved = []
        for ref in required:
            ref_clean = ref.lstrip("@")
            # Try platform ID first, then name
            c = self.find_by_platform_id(platform, ref_clean) or self.find_by_name(ref_clean)
            if c:
                pid = c.get_platform_id(platform)
                if pid:
                    resolved.append(pid)
                else:
                    resolved.append(ref_clean)   # keep original if no platform mapping
            else:
                resolved.append(ref_clean)
        return resolved

    def register(
        self,
        name: str,
        email: str = "",
        platform: Optional[str] = None,
        platform_id: Optional[str] = None,
        is_lead: bool = False,
        role: Optional[str] = None,
    ) -> Contributor:
        """Add or update a contributor. Persists to disk."""
        existing = self.find_by_name(name)
        if existing:
            if platform and platform_id:
                existing.set_platform_id(platform, platform_id)
            if role:
                existing.role = role
            elif is_lead:
                existing.role = "lead"
            self._save()
            return existing

        c = Contributor({
            "name": name, "email": email,
            "role": role or ("lead" if is_lead else "dev"),
            "platforms": {},
        })
        if platform and platform_id:
            c.set_platform_id(platform, platform_id)
        self._contributors.append(c)
        self._save()
        log.info("identity.registered", name=name, platform=platform, role=c.role)
        return c

    # ── /qorum link — self-register a platform id via verification code ───────

    def start_link(self, name: str, platform: str, platform_user_id: str) -> str:
        """
        Begin a /qorum link flow. Returns a 6-char verification code the user
        must echo back to confirm ownership. Pending links are held in memory.
        """
        import secrets as _secrets
        code = _secrets.token_hex(3).upper()   # 6 hex chars
        self._pending_links[code] = (name, platform, platform_user_id)
        log.info("identity.link_started", name=name, platform=platform)
        return code

    def confirm_link(self, code: str) -> Optional[Contributor]:
        """Confirm a /qorum link by code. Registers the platform id on confirmation."""
        pending = self._pending_links.pop(code.upper(), None)
        if not pending:
            return None
        name, platform, platform_user_id = pending
        return self.register(name=name, platform=platform, platform_id=platform_user_id)

    # ── Persistence ───────────────────────────────────────────────────────────

    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            self._contributors = [Contributor(d) for d in data]
        except (json.JSONDecodeError, OSError) as exc:
            log.warning("identity.load_failed", path=str(self._path), error=str(exc))

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            json.dumps([c.to_dict() for c in self._contributors], indent=2),
            encoding="utf-8",
        )
