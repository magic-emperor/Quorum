"""
Phase 9 — Project toolchain detector.

Inspects a repo root and returns the build/test/install commands.
Registry overrides take precedence over auto-detection.

Priority:
  1. registry.json `build_cmd`/`test_cmd` override for this repo
  2. Manifest file heuristics (package.json, pyproject.toml, go.mod, …)
  3. Makefile targets
  4. None (gate runs as "inconclusive")
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional

from qorum.execution.schemas import DetectResult


# ── Lockfile → package manager ────────────────────────────────────────────────

def _node_pkg_manager(root: Path) -> str:
    if (root / "bun.lockb").exists():
        return "bun"
    if (root / "pnpm-lock.yaml").exists():
        return "pnpm"
    if (root / "yarn.lock").exists():
        return "yarn"
    return "npm"


# ── Manifest → scripts ────────────────────────────────────────────────────────

def _node_scripts(root: Path, mgr: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """Return (build_cmd, test_cmd, lint_cmd) for a Node project."""
    pkg = root / "package.json"
    if not pkg.exists():
        return None, None, None
    try:
        scripts = json.loads(pkg.read_text(encoding="utf-8")).get("scripts", {})
    except (json.JSONDecodeError, OSError):
        scripts = {}

    run = f"{mgr} run"
    build_cmd = f"{run} build" if "build" in scripts else None
    test_cmd = f"{mgr} test" if "test" in scripts else f"{run} test" if "test" in scripts else None
    if not test_cmd and "test" in scripts:
        test_cmd = f"{mgr} test"
    lint_cmd = f"{run} lint" if "lint" in scripts else None
    return build_cmd, test_cmd or (f"{mgr} test" if scripts.get("test") is not None else None), lint_cmd


def _makefile_has_target(root: Path, target: str) -> bool:
    mk = root / "Makefile"
    if not mk.exists():
        return False
    try:
        content = mk.read_text(encoding="utf-8", errors="ignore")
        return bool(re.search(rf"^{re.escape(target)}\s*:", content, re.MULTILINE))
    except OSError:
        return False


# ── Main detector ─────────────────────────────────────────────────────────────

def detect(
    root: Path,
    registry_overrides: Optional[dict] = None,
) -> DetectResult:
    """
    Return DetectResult for the given repo root.
    registry_overrides: dict from registry.json entry (build_cmd, test_cmd, etc.)
    """
    overrides = registry_overrides or {}

    result = _detect_from_manifest(root)

    # Apply registry overrides (always win)
    for field in ("build_cmd", "test_cmd", "lint_cmd", "install_cmd", "pkg_manager"):
        if field in overrides and overrides[field]:
            setattr(result, field, overrides[field])

    return result


def _detect_from_manifest(root: Path) -> DetectResult:
    # ── Node / JS / TS ────────────────────────────────────────────────────────
    if (root / "package.json").exists():
        mgr = _node_pkg_manager(root)
        build_cmd, test_cmd, lint_cmd = _node_scripts(root, mgr)
        install_cmd = f"{mgr} install" if mgr != "bun" else "bun install"
        return DetectResult(
            language="node",
            build_cmd=build_cmd,
            test_cmd=test_cmd or f"{mgr} test",
            lint_cmd=lint_cmd,
            install_cmd=install_cmd,
            pkg_manager=mgr,
        )

    # ── Python ────────────────────────────────────────────────────────────────
    if (root / "pyproject.toml").exists() or (root / "setup.py").exists() or (root / "setup.cfg").exists():
        # Detect test runner: pytest preferred, unittest fallback
        test_cmd = "python -m pytest --tb=short -q"
        if (root / "pyproject.toml").exists():
            try:
                content = (root / "pyproject.toml").read_text(encoding="utf-8")
                if "unittest" in content and "pytest" not in content:
                    test_cmd = "python -m unittest discover"
            except OSError:
                pass

        install_cmd = None
        if (root / "requirements.txt").exists():
            install_cmd = "pip install -r requirements.txt -q"
        elif (root / "pyproject.toml").exists():
            install_cmd = "pip install -e . -q"

        lint_cmd = None
        if (root / ".flake8").exists() or (root / "setup.cfg").exists():
            lint_cmd = "python -m flake8 ."
        elif (root / "pyproject.toml").exists():
            try:
                content = (root / "pyproject.toml").read_text(encoding="utf-8")
                if "ruff" in content:
                    lint_cmd = "ruff check ."
            except OSError:
                pass

        return DetectResult(
            language="python",
            build_cmd=None,     # Python rarely needs a separate build step
            test_cmd=test_cmd,
            lint_cmd=lint_cmd,
            install_cmd=install_cmd,
            pkg_manager="pip",
        )

    # ── Go ────────────────────────────────────────────────────────────────────
    if (root / "go.mod").exists():
        return DetectResult(
            language="go",
            build_cmd="go build ./...",
            test_cmd="go test ./...",
            lint_cmd="go vet ./..." if _cmd_available("go") else None,
            install_cmd=None,
            pkg_manager="go",
        )

    # ── Rust ─────────────────────────────────────────────────────────────────
    if (root / "Cargo.toml").exists():
        return DetectResult(
            language="rust",
            build_cmd="cargo build",
            test_cmd="cargo test",
            lint_cmd="cargo clippy -- -D warnings",
            install_cmd=None,
            pkg_manager="cargo",
        )

    # ── JVM (Maven) ───────────────────────────────────────────────────────────
    if (root / "pom.xml").exists():
        return DetectResult(
            language="java",
            build_cmd="mvn -q -DskipTests package",
            test_cmd="mvn -q test",
            install_cmd=None,
            pkg_manager="mvn",
        )

    # ── JVM (Gradle) ─────────────────────────────────────────────────────────
    if (root / "build.gradle").exists() or (root / "build.gradle.kts").exists():
        wrapper = "./gradlew" if (root / "gradlew").exists() else "gradle"
        return DetectResult(
            language="java",
            build_cmd=f"{wrapper} build",
            test_cmd=f"{wrapper} test",
            install_cmd=None,
            pkg_manager="gradle",
        )

    # ── Makefile ─────────────────────────────────────────────────────────────
    if (root / "Makefile").exists():
        build_cmd = "make build" if _makefile_has_target(root, "build") else None
        test_cmd = "make test" if _makefile_has_target(root, "test") else None
        return DetectResult(
            language="make",
            build_cmd=build_cmd,
            test_cmd=test_cmd,
            confidence=0.7,   # Makefile targets may not follow convention
        )

    # ── Unknown ───────────────────────────────────────────────────────────────
    return DetectResult(language="unknown", confidence=0.0)


def _cmd_available(cmd: str) -> bool:
    import shutil
    return shutil.which(cmd) is not None
