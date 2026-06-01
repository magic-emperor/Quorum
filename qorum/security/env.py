"""
Phase 14 — quorum env: .env validation + .env.example generation.

Validates that the repo's .env matches .env.example (no missing/extra vars),
and can generate/update .env.example from environment variable usage found in
the codebase. Never writes real secret values.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from qorum.core.logger import get_logger

log = get_logger(__name__)

# Patterns that read env vars in source code (Python + JS/TS).
_ENV_USAGE_PATTERNS = [
    re.compile(r"os\.environ\.get\(\s*['\"]([A-Z][A-Z0-9_]+)['\"]"),
    re.compile(r"os\.environ\[\s*['\"]([A-Z][A-Z0-9_]+)['\"]\s*\]"),
    re.compile(r"os\.getenv\(\s*['\"]([A-Z][A-Z0-9_]+)['\"]"),
    re.compile(r"process\.env\.([A-Z][A-Z0-9_]+)"),
    re.compile(r"process\.env\[\s*['\"]([A-Z][A-Z0-9_]+)['\"]\s*\]"),
]


class EnvReport:
    def __init__(
        self,
        missing: list[str],
        extra: list[str],
        used_in_code: set[str],
    ) -> None:
        self.missing = missing      # in .env.example but not in .env
        self.extra = extra          # in .env but not in .env.example
        self.used_in_code = used_in_code

    @property
    def is_clean(self) -> bool:
        return not self.missing and not self.extra

    def summary(self) -> str:
        if self.is_clean:
            return "✅ .env matches .env.example"
        parts = []
        if self.missing:
            parts.append(f"❌ Missing in .env: {', '.join(self.missing)}")
        if self.extra:
            parts.append(f"⚠ Extra in .env (not documented): {', '.join(self.extra)}")
        return "\n".join(parts)


def _parse_env_keys(path: Path) -> set[str]:
    """Extract variable names from a .env-style file."""
    keys: set[str] = set()
    if not path.exists():
        return keys
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
        if m:
            keys.add(m.group(1))
    return keys


def scan_code_for_env_vars(repo_root: Path, max_files: int = 2000) -> set[str]:
    """Find all env var names referenced in source files."""
    found: set[str] = set()
    exts = {".py", ".js", ".ts", ".tsx", ".jsx"}
    skip_dirs = {".git", "node_modules", ".venv", ".venv2", "__pycache__", "dist", "build"}
    count = 0
    for path in repo_root.rglob("*"):
        if count >= max_files:
            break
        if path.is_dir() or path.suffix not in exts:
            continue
        if any(part in skip_dirs for part in path.parts):
            continue
        count += 1
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for pattern in _ENV_USAGE_PATTERNS:
            found.update(pattern.findall(text))
    return found


def validate_env(repo_root: Path) -> EnvReport:
    """Compare .env against .env.example and scan code usage."""
    env_keys = _parse_env_keys(repo_root / ".env")
    example_keys = _parse_env_keys(repo_root / ".env.example")
    used = scan_code_for_env_vars(repo_root)

    missing = sorted(example_keys - env_keys)
    extra = sorted(env_keys - example_keys)
    return EnvReport(missing=missing, extra=extra, used_in_code=used)


def generate_env_example(
    repo_root: Path,
    write: bool = False,
) -> str:
    """
    Generate .env.example content from env vars used in code.
    Existing .env.example entries (with comments) are preserved; new vars appended.
    Never writes real secret values — only KEY= placeholders.
    """
    used = sorted(scan_code_for_env_vars(repo_root))
    existing = _parse_env_keys(repo_root / ".env.example")

    lines = []
    example_path = repo_root / ".env.example"
    if example_path.exists():
        lines = example_path.read_text(encoding="utf-8").splitlines()

    new_vars = [v for v in used if v not in existing]
    if new_vars:
        lines.append("")
        lines.append("# ── Auto-detected by `quorum env` ──")
        for var in new_vars:
            lines.append(f"{var}=")

    content = "\n".join(lines) + "\n"
    if write and new_vars:
        example_path.write_text(content, encoding="utf-8")
        log.info("env.example_updated", added=len(new_vars))
    return content
