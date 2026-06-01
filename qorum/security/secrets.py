"""
Phase 14 — Secrets scanner.

Runs as a pre-commit guard inside Phase 8's git_flow.commit: scans the staged
diff for API keys, tokens, and high-entropy strings. Blocks the commit if a
secret is detected (unless allowlisted).

Allowlist: .qorum-secrets-allow (one regex or literal per line) in the repo root.
This is why Phase 8's commit referenced a secrets check.
"""
from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Optional

from qorum.core.logger import get_logger

log = get_logger(__name__)


# ── Known secret patterns (provider-specific) ─────────────────────────────────

_SECRET_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("AWS Access Key",      re.compile(r"AKIA[0-9A-Z]{16}")),
    ("AWS Secret Key",      re.compile(r"aws_secret_access_key\s*=\s*['\"]?[A-Za-z0-9/+=]{40}")),
    ("GitHub Token",        re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}")),
    ("GitHub Fine PAT",     re.compile(r"github_pat_[A-Za-z0-9_]{60,}")),
    ("Slack Token",         re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}")),
    ("Slack Webhook",       re.compile(r"https://hooks\.slack\.com/services/[A-Za-z0-9/]+")),
    ("Google API Key",      re.compile(r"AIza[0-9A-Za-z_\-]{35}")),
    ("OpenAI Key",          re.compile(r"sk-[A-Za-z0-9]{20,}")),
    ("Anthropic Key",       re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}")),
    ("Stripe Live Key",     re.compile(r"sk_live_[A-Za-z0-9]{24,}")),
    ("Private Key Block",   re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----")),
    ("Generic API Key",     re.compile(r"""(?i)(?:api[_-]?key|apikey|secret|token|passwd|password)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]""")),
    ("JWT",                 re.compile(r"eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}")),
]

# Entropy threshold for "looks like a random secret" string detection.
_ENTROPY_MIN_LEN = 20
_ENTROPY_THRESHOLD = 4.0   # bits per char; base64/hex secrets score high

# Lines containing these markers are treated as examples / placeholders.
_PLACEHOLDER_HINTS = re.compile(
    r"(?i)(example|placeholder|your[-_]?[\w-]*key|[-_]?key[-_]?here|xxx+|<[^>]*>|\.\.\.|changeme|dummy|sample|test[-_]?key|fake)"
)


class SecretFinding:
    def __init__(self, kind: str, line_no: int, snippet: str, file: Optional[str] = None) -> None:
        self.kind = kind
        self.line_no = line_no
        self.snippet = snippet
        self.file = file

    def __repr__(self) -> str:
        loc = f"{self.file}:{self.line_no}" if self.file else f"line {self.line_no}"
        return f"<{self.kind} @ {loc}>"

    def redacted(self) -> str:
        """Return the snippet with the middle masked for safe display."""
        s = self.snippet.strip()
        if len(s) <= 12:
            return s[:3] + "***"
        return s[:6] + "…" + s[-4:]


def _shannon_entropy(s: str) -> float:
    if not s:
        return 0.0
    freq: dict[str, int] = {}
    for ch in s:
        freq[ch] = freq.get(ch, 0) + 1
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in freq.values())


def scan_text(text: str, file: Optional[str] = None) -> list[SecretFinding]:
    """
    Scan a block of text (e.g. a staged diff) for secrets.
    Only considers added lines (starting with '+') when scanning a diff;
    plain text is scanned in full.
    """
    findings: list[SecretFinding] = []
    # Diff headers have a trailing space ("--- a/file", "@@ -1 +1 @@"); a PEM
    # block header ("-----BEGIN...") has no space, so it won't be misread as a diff.
    is_diff = any(
        l.startswith(("+++ ", "--- ", "@@ ")) for l in text.splitlines()[:10]
    )

    for i, line in enumerate(text.splitlines(), 1):
        # In a diff, only scan added lines; skip the +++ header
        if is_diff:
            if not line.startswith("+") or line.startswith("+++"):
                continue
            content = line[1:]
        else:
            content = line

        if _PLACEHOLDER_HINTS.search(content):
            continue

        # Pattern matches
        for kind, pattern in _SECRET_PATTERNS:
            m = pattern.search(content)
            if m:
                findings.append(SecretFinding(kind, i, m.group(0), file))
                break   # one finding per line is enough
        else:
            # Entropy check on quoted/assigned long tokens
            for token in re.findall(r"['\"]([A-Za-z0-9_\-+/=]{%d,})['\"]" % _ENTROPY_MIN_LEN, content):
                if _shannon_entropy(token) >= _ENTROPY_THRESHOLD:
                    findings.append(SecretFinding("High-entropy string", i, token, file))
                    break

    return findings


def load_allowlist(repo_root: Path) -> list[re.Pattern]:
    """Load .qorum-secrets-allow — one regex/literal per line; '#' comments."""
    allow_file = repo_root / ".qorum-secrets-allow"
    patterns: list[re.Pattern] = []
    if not allow_file.exists():
        return patterns
    for line in allow_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            patterns.append(re.compile(line))
        except re.error:
            patterns.append(re.compile(re.escape(line)))
    return patterns


def filter_allowlisted(
    findings: list[SecretFinding],
    allowlist: list[re.Pattern],
) -> list[SecretFinding]:
    """Drop findings whose snippet matches any allowlist pattern."""
    if not allowlist:
        return findings
    kept = []
    for f in findings:
        if any(p.search(f.snippet) for p in allowlist):
            log.info("secrets.allowlisted", kind=f.kind, line=f.line_no)
            continue
        kept.append(f)
    return kept


def scan_diff_for_secrets(
    diff_text: str,
    repo_root: Optional[Path] = None,
) -> list[SecretFinding]:
    """
    Full pre-commit scan: scan the staged diff, apply the allowlist.
    Returns findings that should BLOCK the commit (empty = safe to commit).
    """
    findings = scan_text(diff_text)
    if repo_root:
        allowlist = load_allowlist(repo_root)
        findings = filter_allowlisted(findings, allowlist)
    if findings:
        log.warning("secrets.detected", count=len(findings),
                    kinds=[f.kind for f in findings])
    return findings
