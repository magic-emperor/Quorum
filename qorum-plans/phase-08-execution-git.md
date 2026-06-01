# Phase 8 — Execution Engine + Git Workflow

> **Goal:** The hands. Take an **approved plan** and actually do the work *inside the target repo*:
> stash any dirty changes, create a branch, run the agent harness to read→think→edit→run, keep a
> per-file change log with **why**, then (on the developer's explicit diff approval) **commit** —
> and **never `git push` by itself**.

## Why now / dependencies
- **Depends on:** Phase 3 (tool + agent harness), Phase 7 (approved plan + `file_change_intent`),
  Phase 6 (target repo + agent route).
- **Consumed by:** Phase 9 (build/test gate sits inside this flow), Phase 10 (streams the events
  this phase emits), Phase 11 (posts result to the board).

## Scope
**In:** the execution orchestrator, git lifecycle (stash/branch/diff/commit, no push), per-file
change log + rationale, rollback points, the commit message format, the "execute" entrypoint
(auto-on-approval or `[▶ Execute]`). **Out:** running the build/tests (Phase 9 — called as a gate
here), the live UI (Phase 10 — consumes events emitted here).

## Design

### A) Execution orchestrator — `qorum/execution/runner.py`
```python
async def execute(plan: PlanOutput, locate: LocateResult, route: list[str],
                  on_event) -> ExecutionResult:
  1. PRE-FLIGHT
     - assert plan state == APPROVED.
     - repo = locate.target_repo; ensure it's a git repo (init if NEW_PROJECT scaffold).
     - if working tree dirty → git.stash(include_untracked=True) ; remember stash ref.
     - create + checkout branch  qorum/<ticket-id>[-<short>]  off locate.default_branch.
     - snapshot rollback point rp_pre (commit sha / stash ref) → .quorum/rollback_points/.
  2. EXECUTE  (drive the harness per the Phase 6 route)
     for agent in route:                     # e.g. planner→coder→reviewer→tester
        run_agent(agent_def, task=subplan, ctx=ToolContext(cwd=repo, policy), on_event)
        collect ToolEvents → ChangeLog (path, action, +/- lines, agent, reason)
     - coder edits files via fs tools (path-jailed to repo); reviewer critiques the diff vs plan;
       tester writes/extends tests (build/test run happens in Phase 9 gate).
  3. POST  → return ExecutionResult{ branch, change_log, files_changed, diff_summary,
                                     transcript_path, rollback_point }
     (NO commit yet — commit waits for diff approval; NO push ever here.)
```

### B) Git lifecycle — uses `qorum/tools/git.py` (Phase 3), orchestrated by `qorum/execution/git_flow.py`
```
stash (if dirty) → branch qorum/<id> → [agent edits] → git add -A (staged, not committed)
→ produce DIFF + STATUS → DIFF REVIEW (Phase 10 UI / chat) → on approval: git commit
```
- **Commit only on explicit developer approval** of the diff (button `[✅ Approve diff → commit]`).
- **Commit message format** (structured, ties everything together):
  ```
  <type>(<scope>): <plan title>            # type from work_type: feat/fix/refactor/chore

  <2-3 line summary from plan>

  Changes:
  - <path>: <create|modify|delete> — <why>      # from ChangeLog
  ...
  Plan: .quorum/plans/<id>/plan.md
  Ticket: <board url if any>
  Approved-by: <approver(s)>
  Co-Authored-By: Qorum <noreply@qorum.dev>
  ```
- **No push.** There is no push tool in the default policy (Phase 3). Pushing / PR opening is a
  **separate, separately-approved** action (`[⤴ Push]` / `[🔀 Open PR]`) handled by an
  opt-in `git.push` capability the developer enables — surfaced in Phase 9/11, never automatic.

### C) Change log + rationale — `qorum/execution/change_log.py`
- Built from `ToolEvent`s (Phase 3) as files are touched. Each entry:
  `{ path, action, lines_added, lines_removed, agent, reason, ts }`.
- `reason` comes from the agent's stated intent for that edit (the harness asks the coder to label
  each edit with a one-line why; falls back to the matching `file_change_intent.reason` from the plan).
- Rendered into: the diff-review card ("what/where/why"), the commit message, and
  `.quorum/nervous-system/actions.json`. Answers the user's "what file changed, what was
  added/removed and why."

### D) Rollback — `.quorum/rollback_points/`
- `rp_pre` (before edits). If the developer rejects the diff: offer `[↩ Discard]`
  (`git checkout . && git checkout <base> && git branch -D qorum/<id>`; `git stash pop` to restore
  their original dirty tree) or `[📌 Keep branch]` for manual inspection.
- If execution errors mid-run: stop, keep the branch, report, never leave `main`/base touched
  (we only ever edit on the `qorum/<id>` branch).

### E) Entrypoint / mode
- `auto_execute_on_approval` (config, matches existing flag): if true, Phase 7 APPROVED →
  `execute()` starts automatically; else the card shows `[▶ Execute]`.
- `/qorum execute <id>` and `/qorum status <id>` commands.

## File-level work breakdown
- `qorum/execution/{runner,git_flow,change_log,rollback}.py`
- `qorum/execution/schemas.py` (`ExecutionResult`, `ChangeLogEntry`).
- `qorum/tools/git.py` — ensure stash/branch/add/diff/commit; **push stays disabled** by policy.
- `qorum/bot/actions.py` — `execute`, `approve_diff`, `discard`, `keep_branch`, (`push`/`open_pr` = opt-in).
- nervous-system writers: `actions.json`, `decisions.json`, rollback points.

## Ordered tasks
1. `git_flow` primitives (stash/branch/diff/commit) + path-jail + tests on a temp repo.
2. `runner.execute` pre-flight (dirty-tree stash, branch, rollback snapshot).
3. Route-driven harness invocation; collect events → `change_log`.
4. Diff + status summary; diff-review card; commit-on-approval with the structured message.
5. Rollback / discard / keep-branch paths.
6. Auto-vs-manual execute entrypoint + `/qorum execute|status`.
7. End-to-end on a scratch repo (no real provider needed if using a scripted mock coder).
8. Commit `feat: execution engine + git workflow (no auto-push)`.

## Edge cases
- **Dirty working tree** → stash first; restore on discard. Never silently overwrite the dev's WIP.
- **Not a git repo** (NEW_PROJECT) → `git init` the scaffold before branching.
- **Branch already exists** (re-run) → checkout + reset to base, or suffix `-2`; ask if it has commits.
- **Agent makes zero changes** → report "no changes needed"; don't create an empty commit.
- **Agent edits outside repo** → blocked by path-jail (Phase 3); logged as a violation.
- **Execution fails/halts** → keep branch, base untouched, report with `[Retry][Discuss][Discard]`.
- **Merge conflicts with base moving** → only relevant at push/PR (developer's responsibility);
  we branch off the current base at execute time.
- **Large diffs** → summarize in chat, full diff in Phase 10 UI; never dump huge diffs into chat.
- **Secrets written by accident** → `git.commit` runs a secrets scan (Phase 14) as a pre-commit guard.

## Verification
- `tests/unit/test_git_flow.py` — on a temp repo: stash→branch→edit→add→diff→commit; assert base
  branch untouched, no push invoked, commit message format correct.
- `tests/unit/test_runner.py` — scripted mock coder edits 2 files → change_log has correct
  add/remove/why; rollback restores pre-state.
- `tests/integration/test_execute_e2e.py` — approved plan → execute → commit on a scratch repo;
  assert branch `qorum/<id>` exists with exactly the expected commit and **no remote push**.
- Manual: full Telegram flow → approve plan → execute → review diff → approve diff → commit; verify
  `git log` on the branch and that `git push` was never called.

## Definition of Done
- Approved plan executes inside the target repo on a `qorum/<id>` branch, base untouched.
- Per-file change log with rationale drives the diff-review card, commit message, and actions.json.
- Commit happens only on explicit diff approval; **push never happens automatically**.
- Dirty trees are stashed/restored; rollback/discard works.
