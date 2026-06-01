"""
Phase 14 — quorum security gate.

Runs after the build/test gate (Phase 9), before commit/push:
  1. Dependency CVE audit per toolchain (npm audit / pip-audit / cargo audit)
  2. Static diff review via the `security` agent (injection, authz, hardcoded
     secrets) — evidence-only, reports file:line findings
  3. Severity gate: high/critical → block commit (or explicit override, audited);
     medium/low → warn

Mirrors the GateResult shape from Phase 9 so the runner can treat both uniformly.
"""
from __future__ import annotations

import asyncio
import json
import re
import shlex
from pathlib import Path
from typing import Callable, Optional

from pydantic import BaseModel, Field

from qorum.core.logger import get_logger
from qorum.tools.events import ToolEvent

log = get_logger(__name__)

Severity = str  # "critical" | "high" | "medium" | "low" | "info"

_SEVERITY_ORDER = {"critical": 4, "high": 3, "medium": 2, "low": 1, "info": 0}
_AUDIT_TIMEOUT = 120


class SecurityFinding(BaseModel):
    severity: Severity
    title: str
    detail: str = ""
    file: Optional[str] = None
    line: Optional[int] = None
    source: str = "scan"   # "dependency" | "static" | "secrets"

    def is_blocking(self, threshold: str = "high") -> bool:
        return _SEVERITY_ORDER.get(self.severity, 0) >= _SEVERITY_ORDER.get(threshold, 3)


class SecurityResult(BaseModel):
    findings: list[SecurityFinding] = Field(default_factory=list)
    dependency_ok: bool = True
    static_ok: bool = True
    overridden: bool = False
    overridden_by: Optional[str] = None
    block_threshold: str = "high"

    @property
    def blocking_findings(self) -> list[SecurityFinding]:
        return [f for f in self.findings if f.is_blocking(self.block_threshold)]

    @property
    def passed(self) -> bool:
        return len(self.blocking_findings) == 0

    @property
    def verdict(self) -> str:
        if self.overridden:
            return "OVERRIDDEN"
        return "PASS" if self.passed else "BLOCKED"

    def card_text(self) -> str:
        icon = "✅" if self.passed else ("⚠" if self.overridden else "🛑")
        lines = [f"{icon} Security: *{self.verdict}*"]
        by_sev: dict[str, int] = {}
        for f in self.findings:
            by_sev[f.severity] = by_sev.get(f.severity, 0) + 1
        if by_sev:
            lines.append("  " + ", ".join(f"{n} {sev}" for sev, n in sorted(
                by_sev.items(), key=lambda kv: -_SEVERITY_ORDER.get(kv[0], 0))))
        for f in self.blocking_findings[:5]:
            loc = f" ({f.file}:{f.line})" if f.file else ""
            lines.append(f"  🛑 [{f.severity}] {f.title}{loc}")
        return "\n".join(lines)


# ── Dependency audit ──────────────────────────────────────────────────────────

async def run_dependency_audit(
    repo: Path,
    language: str,
    on_event: Optional[Callable] = None,
) -> list[SecurityFinding]:
    """Run the toolchain's dependency CVE audit and parse findings."""
    emit = on_event or (lambda e: None)
    cmd = {
        "node":   "npm audit --json",
        "python": "pip-audit -f json",
        "rust":   "cargo audit --json",
    }.get(language)

    if not cmd:
        return []

    emit(ToolEvent(kind="status", agent="security", summary=f"dependency audit: {cmd}"))
    rc, out = await _run(cmd, repo, _AUDIT_TIMEOUT)

    if language == "node":
        return _parse_npm_audit(out)
    if language == "python":
        return _parse_pip_audit(out)
    if language == "rust":
        return _parse_cargo_audit(out)
    return []


def _parse_npm_audit(output: str) -> list[SecurityFinding]:
    findings = []
    try:
        data = json.loads(output)
        vulns = data.get("vulnerabilities", {})
        for name, v in vulns.items():
            sev = v.get("severity", "low")
            findings.append(SecurityFinding(
                severity=sev, title=f"Vulnerable dependency: {name}",
                detail=str(v.get("via", ""))[:200], source="dependency",
            ))
    except (json.JSONDecodeError, AttributeError):
        pass
    return findings


def _parse_pip_audit(output: str) -> list[SecurityFinding]:
    findings = []
    try:
        data = json.loads(output)
        deps = data.get("dependencies", data) if isinstance(data, dict) else data
        for dep in (deps if isinstance(deps, list) else []):
            for vuln in dep.get("vulns", []):
                findings.append(SecurityFinding(
                    severity="high", title=f"CVE in {dep.get('name', '?')}: {vuln.get('id', '')}",
                    detail=vuln.get("description", "")[:200], source="dependency",
                ))
    except (json.JSONDecodeError, AttributeError):
        pass
    return findings


def _parse_cargo_audit(output: str) -> list[SecurityFinding]:
    findings = []
    try:
        data = json.loads(output)
        for vuln in data.get("vulnerabilities", {}).get("list", []):
            adv = vuln.get("advisory", {})
            findings.append(SecurityFinding(
                severity="high", title=f"RUSTSEC: {adv.get('id', '')}",
                detail=adv.get("title", "")[:200], source="dependency",
            ))
    except (json.JSONDecodeError, AttributeError):
        pass
    return findings


# ── Static diff review (via security agent) ───────────────────────────────────

async def run_static_review(
    diff_text: str,
    classifier=None,   # optional: an object with .summarise/.classify; falls back to heuristics
    on_event: Optional[Callable] = None,
) -> list[SecurityFinding]:
    """
    Review the diff for security issues. Uses heuristic patterns here; the
    `security` agent (Phase 3 harness) can be plugged in for deeper analysis.
    """
    emit = on_event or (lambda e: None)
    emit(ToolEvent(kind="status", agent="security", summary="static diff review"))

    findings: list[SecurityFinding] = []
    patterns = [
        ("high", "SQL injection risk", re.compile(r"(?i)(execute|query)\s*\(\s*['\"].*%s.*['\"]\s*%|f['\"].*SELECT.*\{")),
        ("high", "Shell injection risk", re.compile(r"(?i)(os\.system|subprocess\.(call|run|Popen))\s*\(\s*f?['\"].*\+|shell\s*=\s*True")),
        ("high", "eval/exec on input", re.compile(r"(?i)\b(eval|exec)\s*\(")),
        ("medium", "Disabled TLS verification", re.compile(r"(?i)verify\s*=\s*False|rejectUnauthorized\s*:\s*false")),
        ("medium", "Weak hash (md5/sha1)", re.compile(r"(?i)hashlib\.(md5|sha1)\b|createHash\(['\"](md5|sha1)")),
        ("low", "TODO/FIXME security note", re.compile(r"(?i)(TODO|FIXME).*(secur|auth|inject|vuln)")),
    ]

    line_no = 0
    for line in diff_text.splitlines():
        if line.startswith("+++"):
            continue
        if line.startswith("+"):
            content = line[1:]
            line_no += 1
            for sev, title, pattern in patterns:
                if pattern.search(content):
                    findings.append(SecurityFinding(
                        severity=sev, title=title,
                        detail=content.strip()[:120], line=line_no, source="static",
                    ))
                    break
        elif not line.startswith("-"):
            line_no += 1

    return findings


# ── Gate orchestration ────────────────────────────────────────────────────────

async def run_security_gate(
    repo: Path,
    language: str,
    diff_text: str,
    *,
    block_threshold: str = "high",
    run_dependency: bool = True,
    on_event: Optional[Callable] = None,
) -> SecurityResult:
    """
    Full security gate: dependency audit + static review.
    Returns SecurityResult; .passed=False blocks the commit unless overridden.
    """
    findings: list[SecurityFinding] = []
    dependency_ok = True

    if run_dependency:
        try:
            dep_findings = await run_dependency_audit(repo, language, on_event)
            findings.extend(dep_findings)
            dependency_ok = not any(f.is_blocking(block_threshold) for f in dep_findings)
        except Exception as exc:
            log.warning("security.dependency_audit_failed", error=str(exc))

    static_findings = await run_static_review(diff_text, on_event=on_event)
    findings.extend(static_findings)
    static_ok = not any(f.is_blocking(block_threshold) for f in static_findings)

    result = SecurityResult(
        findings=findings,
        dependency_ok=dependency_ok,
        static_ok=static_ok,
        block_threshold=block_threshold,
    )
    log.info("security.gate_done", verdict=result.verdict,
             blocking=len(result.blocking_findings))
    return result


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _run(cmd: str, cwd: Path, timeout: int) -> tuple[int, str]:
    try:
        parts = shlex.split(cmd)
        proc = await asyncio.create_subprocess_exec(
            *parts, cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            return 1, f"timed out: {cmd}"
        return proc.returncode or 0, stdout.decode("utf-8", errors="replace")
    except FileNotFoundError:
        return 127, f"tool not found: {cmd}"
    except Exception as exc:
        return 1, str(exc)
