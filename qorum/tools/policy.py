"""
Permission policy — enforced by the harness before every tool call.
Default: no push, no rm -rf, no writes outside the repo root (path jail).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class ToolPolicy:
    """
    Declarative permission policy passed through ToolContext.
    The harness checks this before dispatching any tool call.
    """
    # Path jail: all read/write operations must stay under this root.
    # None = no jail (use with caution in tests only).
    repo_root: Optional[Path] = None

    # Shell: commands matching any pattern in this list are allowed.
    # Empty = deny all shell commands.
    shell_allowlist: list[str] = field(default_factory=lambda: [
        "python", "pytest", "pip", "npm", "node", "npx", "pnpm",
        "yarn", "bun", "go", "cargo", "make", "gradle", "mvn",
        "ls", "cat", "echo", "find", "grep", "rg", "sed", "awk",
        "git diff", "git log", "git show", "git status",
        "git add", "git commit", "git stash",
        "git checkout", "git branch", "git fetch",
    ])

    # Shell: commands matching any pattern here are always blocked.
    shell_denylist: list[str] = field(default_factory=lambda: [
        r"git push",           # never auto-push
        r"git push --force",
        r"rm\s+-rf",           # no recursive force delete
        r"sudo\s+",
        r"chmod\s+777",
        r"curl.*\|\s*bash",    # piped execution
        r"wget.*\|\s*sh",
        r"eval\s+",
    ])

    # Network: HTTP tool only fetches from these hosts (empty = deny all).
    http_allowlist: list[str] = field(default_factory=lambda: [
        "docs.python.org",
        "developer.mozilla.org",
        "docs.anthropic.com",
        "platform.openai.com",
        "pkg.go.dev",
        "doc.rust-lang.org",
    ])

    # Git: whether the commit tool is available (turned on when entering a branch).
    allow_git_commit: bool = True
    # Whether the git push tool is available (always False in the default policy).
    allow_git_push: bool = False

    # ── Validation helpers ────────────────────────────────────────────────────

    def check_path(self, path: Path) -> tuple[bool, str]:
        """Return (allowed, reason). Enforces the path jail."""
        if self.repo_root is None:
            return True, ""
        try:
            resolved = path.resolve()
            root_resolved = self.repo_root.resolve()
            resolved.relative_to(root_resolved)
            return True, ""
        except ValueError:
            return False, (
                f"Path jail violation: {path} is outside the repo root {self.repo_root}. "
                f"Only paths within the repo are permitted."
            )

    def check_shell(self, command: str) -> tuple[bool, str]:
        """Return (allowed, reason). Checks deny-list then allow-list."""
        for pattern in self.shell_denylist:
            if re.search(pattern, command, re.IGNORECASE):
                return False, f"Command blocked by policy: matches deny pattern '{pattern}'."

        for pattern in self.shell_allowlist:
            if command.strip().startswith(pattern):
                return True, ""
            if re.search(re.escape(pattern), command, re.IGNORECASE):
                return True, ""

        return False, (
            f"Command not in the allow-list: '{command[:80]}'. "
            f"Add it to policy.shell_allowlist to permit it."
        )

    def check_http(self, url: str) -> tuple[bool, str]:
        """Return (allowed, reason). Checks the HTTP allow-list by hostname."""
        if not self.http_allowlist:
            return False, "HTTP tool is disabled (http_allowlist is empty)."
        from urllib.parse import urlparse
        host = urlparse(url).hostname or ""
        for allowed in self.http_allowlist:
            if host == allowed or host.endswith("." + allowed):
                return True, ""
        return False, (
            f"Host '{host}' is not in the http_allowlist. "
            f"Add it to policy.http_allowlist to permit fetches from this host."
        )


# Default policy used when no policy is specified
DEFAULT_POLICY = ToolPolicy()
