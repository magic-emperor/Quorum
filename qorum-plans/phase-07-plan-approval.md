# Phase 7 — Plan Synthesis + Approval Flow

> **Goal:** Turn an `Intent` + `Classification` + `LocateResult` into a `plan.md` + `task.md`
> written into the **target repo's `.quorum/`**, then run a real multi-person **approval flow**
> with configurable quorum rules, timeouts, and an audit trail — ending in an approved plan that
> Phase 8 can execute.

## Why now / dependencies
- **Depends on:** Phase 6 (classification + target repo), Phase 5 (summary/intent), Phase 4
  (approval cards + buttons + identity), Phase 2 (plan role).
- **Consumed by:** Phase 8 (executes the approved plan), Phase 11 (board posts the approval/result).

## Scope
**In:** plan/task synthesis from an Intent (not just a board ticket), writing into target
`.quorum/`, approval card content, quorum rules engine, approval persistence + audit trail,
nervous-system writes. **Out:** code execution + git (Phase 8), build gate (Phase 9), live diff
(Phase 10).

## Design

### A) Plan synthesis — extend `qorum/core/plan_generator.py`
- Today it generates from a `NormalizedTicket`. Generalize the payload builder to accept an
  `Intent` (chat or board). For chat: feed `ChatSummary.decisions/open_questions/context` +
  acceptance criteria derived from decisions. For board: existing path. Merge both when present.
- Reuse the existing `PlanOutput` schema (sub_tasks, DoD, ambiguities←open_questions, risks,
  out_of_scope, test_scenarios). **Add** a `file_change_intent: list[FileChangeIntent]` field:
  `{ path, action: create|modify|delete, reason }` — the plan's *intended* edits, so the approval
  card can show "files this will touch" and Phase 8/10 can compare intent vs reality.
- Complexity from Phase 6 drives standard vs phased generation (existing logic).
- Write `plan.md` + `task.md` into `LocateResult.plan_dir`:
  - `plan.md` — rendered `PlanOutput` (reuse `output/renderer`).
  - `task.md` — executable checklist (sub_tasks → checkboxes with "Done When"); **port the correct
    serializer** (fixes B12; no `[object Object]`).
  - update `.quorum/plan-index.json` / `task-index.json`.

### B) Approval flow — `qorum/approval/` (extend state machine + new quorum engine)
- New states layered on the existing machine for **multi-approver** plans:
  `PENDING_APPROVAL → (collecting votes) → APPROVED | REJECTED | EXPIRED`.
- **Quorum engine** `qorum/approval/quorum.py`:
  ```python
  rule ∈ { "any" | "all" | "majority" | "lead-only" }   # from .quorum/collaboration/config.json
  required_approvers: list[str]   # resolved from registry/contributors + @assignees
  evaluate(votes) -> APPROVED | REJECTED | PENDING
  ```
- **Approval record** `.quorum/collaboration/approvals/{plan-id}-approval.json` (matches existing
  schema seen on disk): `{ status, rule, required, approved_by, rejected_by, expires_at }`.
  `{plan-id}-plan.json` stores the plan + source messages (existing scheme).
- **Timeout:** `approval_timeout_hours` (config, default 24). A background check (or lazy check on
  next interaction) marks EXPIRED → posts "approval expired, re-run /qorum plan". 
- **Identity:** map platform user → Qorum contributor via `.quorum/collaboration/contributors.json`
  (Phase 14 hardens cross-platform identity; here use a simple per-platform id match + a `lead` flag).
- **Audit trail:** append every event (plan created, vote, approve, reject, expire, change-request)
  to `.quorum/collaboration/audit-trail.json` (append-only, immutable).

### C) Approval card content (rendered via Phase 4 buttons)
```
QORUM Plan — <title>   <complexity badge>  conf NN%
Summary: <2-3 lines>
Target: <ENHANCEMENT → repo `payments`> · branch qorum/<id>     [Change target]
Captured: N msgs (HH:MM–HH:MM)                                   [View capture]
Will touch: M files (create P / modify Q / delete R)             [View plan]
Ambiguities: <top 2 or "none">
Approvers (<rule>): @Sarah @Ahmed
[✅ Approve]  [✏ Request changes]  [✖ Reject]
```
- `Approve` → quorum.evaluate; when satisfied → state APPROVED → (Phase 8 may auto-start if
  `auto_execute_on_approval`, else show [▶ Execute]).
- `Request changes` → collect text → regenerate **with feedback** (B3 fix) → re-post card.
- `Reject` → REJECTED + reason to audit-trail; thread stays open.

## File-level work breakdown
- `qorum/core/plan_generator.py` — `Intent` payloads + `file_change_intent`.
- `qorum/core/schemas.py` — add `FileChangeIntent`.
- `qorum/output/renderer.py` — `render_task()` (correct serialization), plan-card builder.
- `qorum/approval/quorum.py` (new), extend `state_machine.py` for multi-approver + EXPIRED.
- `qorum/approval/db.py` — votes, expiry; audit-trail writer.
- `qorum/bot/actions.py` — approve/request-changes/reject/change-target/view-* actions.

## Ordered tasks
1. `FileChangeIntent` + `Intent`-aware plan payload; standard + phased.
2. Write plan.md + task.md (correct serializer) into target `.quorum/`; update indexes.
3. Quorum engine + multi-approver states + EXPIRED + timeout handling.
4. Approval + audit-trail persistence (match on-disk JSON schema).
5. Approval card builder + button wiring; request-changes feeds feedback into regen.
6. nervous-system writes (decisions/actions) on key transitions.
7. End-to-end (Telegram): mention → plan written into repo `.quorum/` → card → approve.
8. Commit `feat: plan synthesis + approval flow`.

## Edge cases
- **Required approver never responds** → timeout → EXPIRED (not stuck forever).
- **Approver rejects after others approved** → rule decides (e.g. `all` → REJECTED; `majority` → reccount).
- **Re-plan after changes** → new plan version (versioned file), new approval record, old one
  archived; audit-trail links them.
- **Self-approval** when `rule="lead-only"` and trigger user is the lead → allowed; otherwise the
  trigger user can't be the sole approver if rule requires others.
- **Target changed via [Change target]** → re-locate, rewrite plan into the new repo's `.quorum/`.
- **`question` work-type** (from Phase 6) → no plan/approval; answer inline.
- **Concurrent approvals on the same plan** → DB-level idempotent vote (dedupe by user+plan).

## Verification
- `tests/unit/test_quorum.py` — any/all/majority/lead-only over vote sequences incl. timeout.
- `tests/unit/test_plan_from_intent.py` — chat Intent → valid `PlanOutput` with `file_change_intent`;
  task.md serializes sub-tasks correctly (no `[object Object]`).
- `tests/integration/test_plan_lands_in_repo.py` — plan.md written under `<repo>/.quorum/`, indexes
  updated, approval + audit records created.
- Manual: full Telegram flow to an APPROVED plan sitting in a scratch repo's `.quorum/`.

## Definition of Done
- An approved `plan.md` + `task.md` exist in the **target repo's `.quorum/`** with correct
  serialization and updated indexes.
- Multi-approver quorum rules + timeout + audit trail work; request-changes regenerates with feedback.
- State ends in APPROVED, ready for Phase 8 execution (auto or via [▶ Execute]).
