"""
Phase 7 — Approval card builder.

Renders the human-readable card text and button set for the plan approval flow:

  QORUM Plan — <title>   COMPLEX   conf 82%
  Summary: <2-3 lines>
  Target: ENHANCEMENT → repo `payments` · branch qorum/<id>   [Change target]
  Captured: N msgs (HH:MM–HH:MM)
  Will touch: M files (create P / modify Q / delete R)
  Ambiguities: <top 2 or "none">
  Approvers (any): @Sarah @Ahmed
  [✅ Approve]  [✏ Request changes]  [✖ Reject]
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from qorum.approval.quorum import QuorumConfig
    from qorum.collaboration.intent import Intent
    from qorum.collaboration.schemas import Classification, LocateResult
    from qorum.core.schemas import PlanOutput


def build_approval_card(
    plan_id: str,
    plan: "PlanOutput",
    intent: "Intent",
    classification: "Classification",
    locate: "LocateResult",
    quorum_cfg: "QuorumConfig",
) -> str:
    """Return the Markdown text for the approval card."""
    lines: list[str] = []

    # ── Header ────────────────────────────────────────────────────────────────
    title = intent.title_hint or plan.summary[:60]
    complexity_badge = f"[{classification.complexity}]" if classification.complexity else ""
    conf = plan.confidence_overall
    conf_icon = "🟢" if conf >= 85 else ("🟡" if conf >= 70 else "🔴")
    lines.append(f"*QORUM Plan* — {title}  {complexity_badge}  {conf_icon} {conf}%")
    lines.append("")

    # ── Summary ───────────────────────────────────────────────────────────────
    lines.append(plan.summary[:300])
    lines.append("")

    # ── Target ────────────────────────────────────────────────────────────────
    if locate.target_repo:
        repo_name = locate.target_repo.name
        mode_label = "Enhancement" if locate.mode == "ENHANCEMENT" else locate.mode
        lines.append(f"*Target:* {mode_label} → `{repo_name}` · branch `qorum/{plan_id[:8]}`")
    elif locate.scaffold_path:
        lines.append(f"*Target:* New project → `{locate.scaffold_path.name}`")
    lines.append("")

    # ── Capture info ──────────────────────────────────────────────────────────
    if intent.capture:
        c = intent.capture
        start = c.start_ts.strftime("%H:%M")
        end = c.end_ts.strftime("%H:%M")
        lines.append(f"*Captured:* {c.message_count} msgs ({start}–{end}) via {c.strategy}")
        lines.append("")

    # ── File change intent ────────────────────────────────────────────────────
    fci = plan.file_change_intent
    if fci:
        creates  = sum(1 for f in fci if f.action == "create")
        modifies = sum(1 for f in fci if f.action == "modify")
        deletes  = sum(1 for f in fci if f.action == "delete")
        parts = []
        if creates:  parts.append(f"create {creates}")
        if modifies: parts.append(f"modify {modifies}")
        if deletes:  parts.append(f"delete {deletes}")
        lines.append(f"*Will touch:* {len(fci)} file(s) ({', '.join(parts)})")
        lines.append("")

    # ── Top ambiguities ───────────────────────────────────────────────────────
    ambs = plan.ambiguities[:2]
    if ambs:
        lines.append("*Ambiguities:*")
        for a in ambs:
            lines.append(f"  • {a.question}")
    else:
        lines.append("*Ambiguities:* none")
    lines.append("")

    # ── Approvers ─────────────────────────────────────────────────────────────
    rule = quorum_cfg.rule
    required = quorum_cfg.required_approvers
    if required:
        approvers_str = " ".join(f"@{a.lstrip('@')}" for a in required)
    else:
        approvers_str = "anyone"
    lines.append(f"*Approvers* ({rule}): {approvers_str}")

    return "\n".join(lines)
