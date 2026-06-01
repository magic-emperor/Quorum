# Phase 1 — Foundation Hardening (fix B1–B12)

> **Goal:** Make the *existing* ticket→plan→approve→testing→done flow actually correct and
> durable. No new features — just fix the audited bugs and add a regression test per bug so
> they can't silently return. After this, the engine is a trustworthy base for Phases 2+.

## Why now / dependencies
- **Depends on:** Phase 0 (rename done; paths below use `qorum/`).
- Every later phase builds on the orchestrator, state machine, and plan generator. If they're
  broken (B1, B2, B3), everything downstream inherits the breakage.

## Scope
**In:** the 12 bugs from the master-plan code audit + a regression test each.
**Out:** provider abstraction (Phase 2), chat ingestion, execution. Keep the Claude-only path
for now; just make it correct.

## The fixes (each = code change + test)

### B1 — CRITICAL: broken approve→testing contract
- **Symptom:** `approval/state_machine.py` calls `generate_testing(ticket, generation_result.plans)`
  but `core/plan_generator.py:generate_testing(plan, ticket)` expects `(PlanOutput, ticket)`;
  also `output/manager.save_testing` `zip()`s a single object as a list.
- **Fix:** Standardize on **one testing output per plan**. Change `generate_testing` to accept
  the list and return a list, OR loop in the pipeline. Recommended:
  ```python
  # plan_generator.py
  async def generate_testing(self, ticket: NormalizedTicket,
                             plans: list[PlanOutput]) -> list[TestingOutput]: ...
  ```
  Update `state_machine.approve()` to pass `generation_result.plans` (already a list of
  `GeneratedPlan` → extract `.plan`) and `save_testing(ticket, testing_outputs, generated_plans)`
  with matching lengths so `zip` is correct.
- **Test:** `tests/unit/test_approval_testing.py` — approve a standard ticket and a 2-phase
  ticket; assert `len(testing_outputs) == len(plans)` and files written.

### B2 — CRITICAL: ephemeral session state
- **Symptom:** `bot/base_adapter.py` keeps `ticket`+`GenerationResult` in a class-level dict;
  bot restart loses it; DB stores neither URL nor result, so `approve`/`refresh` can't rebuild.
- **Fix:** Persist a **session record** in the approval DB (`approval/db.py`): store `url`,
  serialized `NormalizedTicket` (JSON), serialized `GenerationResult` (JSON), `channel_id`,
  `created_at`. Add `save_session()` / `load_session()`. Replace `_result_cache` reads with
  `load_session(ticket_id)`. Keep an in-process LRU as a fast cache in front of the DB.
- Add `to_json()/from_json()` to `NormalizedTicket` (it's a dataclass — use `dataclasses.asdict`
  + a typed rebuild) and rely on Pydantic `model_dump_json` for `GenerationResult` plans.
- **Test:** `test_session_persistence.py` — process a URL, drop the in-memory cache, call
  `approve` → succeeds by loading from DB.

### B3 — HIGH: Request Changes ignores feedback + bypasses state machine
- **Symptom:** `handle_request_changes` records feedback then re-runs `_handle_url` (same prompt),
  feedback never reaches generation; `plan_regenerated()` never called.
- **Fix:** Thread `feedback_text` into `plan_generator.generate_plan(ticket, feedback=...)`;
  add a `## Reviewer feedback to address` block to the plan payload. After regeneration, call
  `approval.plan_regenerated(ticket, new_paths)` so state goes CHANGES_REQUESTED→PENDING_APPROVAL.
- **Test:** `test_request_changes.py` — request changes with text; assert the regenerated plan
  payload contains the feedback and state transitions are valid.

### B4 — HIGH: no retry on LLM calls
- **Fix:** Wrap `_call_claude` body in `core/retry.with_retry(...)`. Map provider rate-limit
  errors to the retry path. (Retry will be generalized in Phase 2; here just wire it for the
  Anthropic call.)
- **Test:** `test_retry.py` — monkeypatch the client to fail twice then succeed; assert 3 attempts.

### B5 — HIGH: provider lock-in (defer hard fix to Phase 2, but unblock config)
- **Phase 1 partial fix:** stop *requiring* `anthropic_api_key` at import in `config.py`
  `check_*` validator — make it required only when the Anthropic provider is actually selected.
  Full multi-provider lands in Phase 2; this just prevents an import-time crash when a user
  intends to use another provider.
- **Test:** `test_config.py` — config loads with no Anthropic key (warning, not error).

### B6 — HIGH: plans go to a global folder (full fix in Phase 6)
- **Phase 1 step:** make `OutputManager` take the output root as a **per-call argument**
  (`save_plans(ticket, result, root: Path)`) instead of reading the global config at init.
  Default still `qorum-output/`. Phase 6 passes the resolved target-repo `.quorum/`.
- **Test:** `test_output_root.py` — save to a tmp root; assert path is under that root.

### B7 — MEDIUM: hardcoded `max_tokens=4096`
- **Fix:** Make `max_tokens` a per-role config (`qorum_max_tokens_plan`, default 8192). On a
  truncated/invalid-JSON response, attempt one **repair** call ("return ONLY the corrected JSON")
  before raising `PlanGenerationError`.
- **Test:** `test_json_repair.py` — feed a truncated JSON fixture; assert one repair attempt.

### B8 — MEDIUM: leaky encapsulation
- **Fix:** Add public methods on `QorumOrchestrator`: `get_ticket_record`, `record_feedback`,
  `get_plan_paths`. Bot adapters call these, never `orchestrator._db` / `._approval` / `._output_manager`.
- **Test:** lint/grep test asserting no `orchestrator\._` access in `bot/`.

### B9 — MEDIUM: re-runs bypass the state machine
- **Fix:** In `orchestrator.process`, when a ticket record already exists, route through the
  state machine (`plan_regenerated` for a refresh of a CHANGES_REQUESTED/PENDING ticket) instead
  of blindly upserting `PENDING_APPROVAL` with `from_state=None`. Refuse to reset a `DONE` ticket
  without an explicit `--force`.
- **Test:** `test_state_machine_guard.py` — re-process a DONE ticket → guarded.

### B10 — LOW: schema definition order
- **Fix:** In `core/schemas.py`, define `PhaseDefinition` **before** `PhaseProposal`; add
  `PhaseProposal.model_rebuild()` after class defs. Remove the redundant local import in
  `_default_phase_proposal`.
- **Test:** `test_schemas_import.py` — import + instantiate `PhaseProposal` with phases.

### B11 — LOW: inconsistent confidence thresholds
- **Fix:** Single source of truth: constants `CONF_WARN=70`, `CONF_GOOD=85` in `core/schemas.py`;
  orchestrator bar + `low_confidence_warning` both reference them.

### B12 — LOW: `[object Object]` in task rendering (archived TS)
- The TS file is archived; **port the task.md rendering to Python** in `output/renderer.py`
  (a `render_task()` that serializes sub-tasks correctly). Covered fully when task.md is wired
  in Phase 7; here just note + add the renderer stub with a serialization test.

## Ordered tasks
1. B10, B11 (schema cleanups — smallest, unblock imports).
2. B1 (testing contract) + test.
3. B2 (session persistence) + test.
4. B3 (feedback threading + state) + test.
5. B4 (retry) + B7 (token budget/repair) + tests.
6. B5 (config), B6 (output root arg), B8 (public API), B9 (state guard) + tests.
7. B12 renderer stub + test.
8. Full `pytest` green; commit `fix: harden core flow (B1–B12)`.

## Edge cases
- Phased (LARGE) tickets must produce N testing files (B1 regression must cover N>1).
- Session JSON must round-trip nested `NormalizedTicket` (parent/children/comments).
- Repair call must not loop infinitely (max 1 repair, then raise).

## Verification
- `pytest qorum/tests` fully green, including 12 new regression tests (one per bug).
- Manual: run the Telegram (or a stub) flow against a real ticket URL → approve → testing.md
  generated without crashing (was impossible before B1 fix).

## Definition of Done
- All 12 bugs fixed; each has a failing-before/passing-after regression test.
- No `orchestrator._private` access from `bot/`.
- Approve→testing works for standard **and** phased tickets; flow survives a simulated bot restart.
