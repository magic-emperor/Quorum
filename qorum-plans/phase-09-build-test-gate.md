# Phase 9 — Build / Test Verification Gate

> **Goal:** Before any commit/push is offered, **prove the work doesn't break the build**. Detect
> the project's build + test commands, run them in the repo, and gate the diff-approval on a green
> (or explicitly-overridden) result — so "it should not fail in the build / the pipeline should not
> crash" is enforced, not hoped for.

## Why now / dependencies
- **Depends on:** Phase 8 (execution produced edits on the `qorum/<id>` branch; gate runs before commit).
- **Consumed by:** Phase 10 (streams test/build events), Phase 11 (board status reflects gate result).

## Scope
**In:** project-type detection, build/test command resolution, sandboxed execution + result parsing,
the gate decision + auto-fix loop, optional remote CI status polling. **Out:** authoring the test
strategy (the `tester` agent in Phase 3/8 does that); the UI (Phase 10).

## Design

### A) Project detector — `qorum/execution/project_detect.py`
Inspect the repo root and map to a toolchain (config can override per repo in `registry.json`):
```
package.json            → node: build="npm run build"||"build" script; test="npm test"; pkgmgr from lockfile (npm/pnpm/yarn/bun)
pyproject.toml / setup  → python: build="python -m build" (opt); test="pytest"
go.mod                  → go:   build="go build ./..."; test="go test ./..."
Cargo.toml              → rust: build="cargo build"; test="cargo test"
pom.xml / build.gradle  → jvm:  mvn -q -DskipTests package / gradle build; test=mvn test / gradle test
Makefile                → make build / make test if targets exist
```
`DetectResult = { language, build_cmd|None, test_cmd|None, lint_cmd|None, pkg_manager, install_cmd }`.

### B) Gate runner — `qorum/execution/gate.py`
```python
async def run_gate(repo, detect, on_event) -> GateResult:
  - ensure deps installed (install_cmd) if a fresh scaffold / lockfile changed (cached).
  - run lint_cmd (optional, non-blocking warning).
  - run build_cmd (blocking). 
  - run test_cmd (blocking).
  - parse exit codes + output → GateResult{ build_ok, tests_ok, failed_tests[], summary, logs_path }
```
- Uses the `shell`/`test` tools (Phase 3) with timeouts, cwd-locked to the repo, output captured to
  `.quorum/context/sessions/<id>/gate.log`. Every step emits a `ToolEvent` (Phase 10 shows
  "building… / tests 12/14 ✅").

### C) Gate decision + auto-fix loop
```
if build_ok and tests_ok      → GATE PASS → enable [✅ Approve diff → commit]
if build fails OR tests fail  → GATE FAIL:
    - feed failures back to the `coder`/`tester` agents (Phase 8 harness) for up to
      qorum_gate_fix_attempts (default 2) fix→re-run cycles.
    - if still failing → STOP. Card: "Build/tests failing" + first failures + [Retry][Discuss][Override commit].
    - [Override commit] requires explicit human action (documented as risky) — never automatic.
```
- The gate **blocks the commit button** until pass or explicit override. This is the enforcement
  point for "must not crash the pipeline."

### D) Optional remote CI awareness — `qorum/execution/ci_status.py`
- After a push/PR (developer-initiated, Phase 8/11), optionally poll the provider's checks API
  (GitHub Actions / Azure Pipelines) and report status back to the chat thread + board. Read-only;
  never triggers or merges. Off unless configured.

## File-level work breakdown
- `qorum/execution/{project_detect,gate,ci_status}.py` + `schemas.py` (`DetectResult`, `GateResult`).
- `qorum/tools/test.py` — extend with detected build/test runners + output parsers (pytest, jest,
  go test, etc. — start with pytest + node, extend later).
- `qorum/execution/runner.py` — call `run_gate` after edits, before offering commit; wire fix loop.
- `registry.json` — optional per-repo `build_cmd`/`test_cmd`/`install_cmd` overrides.

## Ordered tasks
1. `project_detect` for node + python first (most common) + tests; others as stubs with override support.
2. `gate.run_gate` (install→lint→build→test) with timeouts + log capture + events.
3. Wire gate into `runner.execute` between edits and commit; block commit on fail.
4. Auto-fix loop (bounded) feeding failures to coder/tester agents.
5. `ci_status` optional poller (GitHub first).
6. Tests + commit `feat: build/test verification gate`.

## Edge cases
- **No test/build command found** → gate "inconclusive": warn, require explicit human OK to commit
  (don't silently pass). Offer to record commands in `registry.json`.
- **Flaky tests** → single retry of the test step before declaring fail; mark as flaky in the report.
- **Long builds** → timeout (config) → report timeout, not silent hang; stream progress.
- **Missing deps / install fails** → surface the install error clearly; don't attempt the build.
- **Tests need services** (DB/redis) → detect docker-compose; if not runnable locally, mark
  integration tests skipped + warn (don't block on environment we can't provide).
- **Monorepo** → run gate scoped to the changed package (path from change_log) where possible.
- **Override used** → log to audit-trail with who/why; surfaced prominently.

## Verification
- `tests/unit/test_project_detect.py` — fixtures (package.json/pyproject/go.mod/Cargo) → correct cmds.
- `tests/unit/test_gate.py` — mock a passing repo and a failing-test repo → PASS/FAIL decisions; fix
  loop invoked on fail and stops after the cap.
- `tests/integration/test_gate_python.py` — real tiny pytest repo: introduce a failing test → gate
  fails and blocks commit; fix it → gate passes and commit is enabled.
- Manual: execute a change that breaks a test → Qorum reports failure, won't offer commit until fixed.

## Definition of Done
- Build + tests run automatically after execution, before commit.
- A failing build/test **blocks the commit** (bounded auto-fix, then human Retry/Discuss/Override).
- Gate results stream to the UI and are recorded; "must not crash the build" is enforced at the gate.
