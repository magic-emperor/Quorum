"""
Phase 9 — Build / test verification gate.

run_gate() runs install → (lint) → (build) → test in the target repo,
parses results, and returns a GateResult. On failure, the auto-fix loop
feeds failures back to the coder/tester agents (bounded by qorum_gate_fix_attempts).

The gate BLOCKS the commit button until:
  - PASS: build_ok AND tests_ok
  - OVERRIDE: human explicitly clicks [Override commit]
"""
from __future__ import annotations

import asyncio
import re
import shlex
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Optional

from qorum.execution.schemas import DetectResult, FailedTest, GateResult
from qorum.core.logger import get_logger
from qorum.tools.events import ToolEvent

if TYPE_CHECKING:
    from qorum.execution.schemas import ChangeLogEntry

log = get_logger(__name__)

_DEFAULT_TIMEOUT = 300       # 5 min per step
_DEFAULT_FIX_ATTEMPTS = 2


async def run_gate(
    repo: Path,
    detect: DetectResult,
    on_event: Optional[Callable] = None,
    timeout: int = _DEFAULT_TIMEOUT,
    log_dir: Optional[Path] = None,
    changed_paths: Optional[list[str]] = None,
) -> GateResult:
    """
    Run the full gate: install → lint (optional) → build → test.

    on_event: receives ToolEvents for streaming to Phase 10.
    log_dir:  directory to write gate.log (usually .quorum/context/sessions/<run_id>/).
    changed_paths: from ChangeLog — used to scope monorepo runs (future).
    """
    emit = on_event or (lambda e: None)
    logs: list[str] = []

    def _ev(summary: str, kind: str = "gate", ok: bool = True, **payload) -> None:
        e = ToolEvent(kind=kind, agent="gate", summary=summary, ok=ok, payload=payload)
        emit(e)

    # ── Install ───────────────────────────────────────────────────────────────
    if detect.install_cmd:
        _ev(f"installing deps: {detect.install_cmd}", kind="gate_install")
        rc, out = await _run(detect.install_cmd, repo, timeout)
        logs.append(f"=== INSTALL ===\n{out}")
        if rc != 0:
            gate = GateResult(
                install_ok=False, build_ok=False, tests_ok=False,
                summary=f"Dependency install failed (exit {rc}).",
            )
            _ev("install failed", kind="gate_install", ok=False)
            _save_log(logs, log_dir)
            return gate
        _ev("install OK", kind="gate_install", ok=True)

    # ── Lint (non-blocking warning) ───────────────────────────────────────────
    lint_warnings = 0
    if detect.lint_cmd:
        _ev(f"linting: {detect.lint_cmd}", kind="gate_lint")
        rc, out = await _run(detect.lint_cmd, repo, min(timeout, 60))
        logs.append(f"=== LINT ===\n{out}")
        if rc != 0:
            lint_warnings = max(1, sum(1 for l in out.splitlines() if l.strip()))
            _ev(f"lint: {lint_warnings} warnings", kind="gate_lint", ok=False)
        else:
            _ev("lint clean", kind="gate_lint", ok=True)

    # ── Build ─────────────────────────────────────────────────────────────────
    build_ok = True
    if detect.build_cmd:
        _ev(f"building: {detect.build_cmd}", kind="gate_build")
        rc, out = await _run(detect.build_cmd, repo, timeout)
        logs.append(f"=== BUILD ===\n{out}")
        build_ok = (rc == 0)
        _ev(
            f"build {'OK' if build_ok else 'FAILED'} (exit {rc})",
            kind="gate_build", ok=build_ok,
        )
        if not build_ok:
            gate = GateResult(
                install_ok=True, build_ok=False, tests_ok=False,
                lint_warnings=lint_warnings,
                summary=_summarize_build_failure(out),
            )
            _save_log(logs, log_dir)
            return gate

    # ── Test ──────────────────────────────────────────────────────────────────
    tests_ok = True
    failed_tests: list[FailedTest] = []

    if detect.test_cmd:
        _ev(f"testing: {detect.test_cmd}", kind="gate_test")
        rc, out = await _run(detect.test_cmd, repo, timeout)
        logs.append(f"=== TEST ===\n{out}")
        tests_ok = (rc == 0)

        if not tests_ok:
            failed_tests = _parse_test_failures(out, detect.language)

        _ev(
            f"tests {'passed' if tests_ok else f'FAILED — {len(failed_tests)} failing'}",
            kind="gate_test", ok=tests_ok,
        )
    else:
        # No test command known — gate is inconclusive
        _ev("no test command — gate inconclusive", kind="gate_test", ok=False)
        gate = GateResult(
            install_ok=True, build_ok=build_ok, tests_ok=False,
            lint_warnings=lint_warnings,
            summary=(
                "No test command detected. Add a `test_cmd` to registry.json "
                "or create a standard test file."
            ),
        )
        _save_log(logs, log_dir)
        return gate

    summary = _build_summary(detect, build_ok, tests_ok, failed_tests)
    _save_log(logs, log_dir)

    return GateResult(
        install_ok=True,
        build_ok=build_ok,
        tests_ok=tests_ok,
        lint_warnings=lint_warnings,
        failed_tests=failed_tests,
        summary=summary,
        logs_path=log_dir / "gate.log" if log_dir else None,
    )


# ── Auto-fix loop ─────────────────────────────────────────────────────────────

async def run_gate_with_fix(
    repo: Path,
    detect: DetectResult,
    runner: "Any",          # ExecutionRunner — used to invoke fix agents
    on_event: Optional[Callable] = None,
    max_attempts: int = _DEFAULT_FIX_ATTEMPTS,
    **gate_kwargs,
) -> GateResult:
    """
    Run the gate; if it fails, feed failures to coder/tester for bounded fix→re-run.
    """
    gate = await run_gate(repo, detect, on_event=on_event, **gate_kwargs)

    for attempt in range(1, max_attempts + 1):
        if gate.passed:
            break

        log.info("gate.fix_attempt", attempt=attempt, verdict=gate.verdict)
        failure_desc = _failure_description(gate)

        # Ask the harness to fix (uses runner's existing agent infrastructure)
        if hasattr(runner, "_fix_from_gate"):
            await runner._fix_from_gate(failure_desc)
        else:
            break   # runner doesn't support fix loop yet

        gate = await run_gate(repo, detect, on_event=on_event, **gate_kwargs)
        gate.fix_attempts = attempt

    return gate


# ── Internal helpers ──────────────────────────────────────────────────────────

async def _run(cmd: str, cwd: Path, timeout: int) -> tuple[int, str]:
    try:
        parts = shlex.split(cmd)
        proc = await asyncio.create_subprocess_exec(
            *parts, cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            return 1, f"Command timed out after {timeout}s: {cmd}"
        return proc.returncode or 0, stdout.decode("utf-8", errors="replace")[:32_000]
    except FileNotFoundError as exc:
        return 1, f"Command not found: {exc}"
    except Exception as exc:
        return 1, f"Unexpected error running '{cmd}': {exc}"


def _parse_test_failures(output: str, language: str) -> list[FailedTest]:
    """Parse test failure output for the detected language."""
    if language == "python":
        return _parse_pytest(output)
    if language == "node":
        return _parse_jest_or_mocha(output)
    if language == "go":
        return _parse_go_test(output)
    # Generic: extract lines with FAIL/Error
    return _parse_generic(output)


def _parse_pytest(output: str) -> list[FailedTest]:
    failures = []
    # Match "FAILED tests/test_foo.py::TestBar::test_baz - AssertionError: ..."
    for m in re.finditer(r"FAILED\s+([\w/\\.:]+)\s*(?:-\s*(.+))?", output):
        failures.append(FailedTest(
            name=m.group(1),
            message=(m.group(2) or "").strip()[:200],
        ))
    return failures[:20]


def _parse_jest_or_mocha(output: str) -> list[FailedTest]:
    failures = []
    # Jest: "● TestSuite › test name"
    for m in re.finditer(r"●\s+(.+)", output):
        failures.append(FailedTest(name=m.group(1).strip()))
    if not failures:
        # Mocha: "N failing" + "  N) describe it"
        for m in re.finditer(r"^\s+\d+\)\s+(.+)$", output, re.MULTILINE):
            failures.append(FailedTest(name=m.group(1).strip()))
    return failures[:20]


def _parse_go_test(output: str) -> list[FailedTest]:
    failures = []
    for m in re.finditer(r"--- FAIL:\s+(\S+)", output):
        failures.append(FailedTest(name=m.group(1)))
    return failures[:20]


def _parse_generic(output: str) -> list[FailedTest]:
    failures = []
    for line in output.splitlines():
        if re.search(r"\b(FAIL|ERROR|Error)\b", line) and len(line) < 200:
            failures.append(FailedTest(name=line.strip()[:120]))
    return failures[:10]


def _summarize_build_failure(output: str) -> str:
    lines = [l for l in output.splitlines() if re.search(r"[Ee]rror|FAIL", l)]
    return "\n".join(lines[:5]) or output[:300]


def _build_summary(
    detect: DetectResult,
    build_ok: bool,
    tests_ok: bool,
    failed: list[FailedTest],
) -> str:
    if build_ok and tests_ok:
        parts = []
        if detect.build_cmd:
            parts.append("build ✅")
        parts.append("tests ✅")
        return " | ".join(parts)
    parts = []
    if detect.build_cmd:
        parts.append(f"build {'✅' if build_ok else '❌'}")
    parts.append(f"tests {'✅' if tests_ok else f'❌ {len(failed)} failing'}")
    return " | ".join(parts)


def _failure_description(gate: GateResult) -> str:
    lines = [f"Gate verdict: {gate.verdict}", gate.summary]
    for t in gate.failed_tests[:5]:
        lines.append(f"  FAIL: {t.name}")
        if t.message:
            lines.append(f"    {t.message}")
    return "\n".join(lines)


def _save_log(logs: list[str], log_dir: Optional[Path]) -> None:
    if not log_dir:
        return
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        (log_dir / "gate.log").write_text(
            f"Gate run: {ts}\n{'=' * 40}\n\n" + "\n\n".join(logs),
            encoding="utf-8",
        )
    except OSError:
        pass
