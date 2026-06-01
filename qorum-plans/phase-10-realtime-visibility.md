# Phase 10 — Real-Time Visibility (VS Code extension + Web dashboard)

> **Goal:** Let the developer **see the work happen with their own eyes** — live file edits,
> commands, and test results streaming as they occur — and review the diff with per-file "what &
> why" before approving the commit. Two surfaces: a **VS Code extension** (native diff, jump-to-file)
> and a **web dashboard** (same feed for non-IDE viewers). Trust comes from seeing.

## Why now / dependencies
- **Depends on:** Phase 8 (emits `ToolEvent`s + change log), Phase 9 (build/test events), Phase 3
  (ToolEvent schema), Phase 2/registry. Phase 4 already streams a condensed feed to chat.
- This is the **M3 demo** payoff: chat → plan → approve → *watch it build* → review → commit.

## Scope
**In:** the event bus + WebSocket server, event schema/persistence, the VS Code extension, the web
dashboard, the diff-review experience + approve-to-commit controls, "guide me to the change". **Out:**
the execution itself (Phase 8) and the gate (Phase 9) — this phase only *surfaces* them.

## Design

### A) Event bus + server — `qorum/server/` (FastAPI + WebSocket)
- `qorum/server/app.py` — FastAPI app; `qorum serve` entrypoint.
- Endpoints:
  - `WS /ws/runs/{run_id}` — live `ToolEvent` stream for an execution run.
  - `GET /runs` / `GET /runs/{id}` — run history + final `ExecutionResult` + `GateResult`.
  - `GET /runs/{id}/diff` — unified diff + per-file change log (path, action, +/- , reason).
  - `POST /runs/{id}/approve-diff` | `/discard` | `/push` — review actions (auth-gated).
- **Event model** (finalize the Phase 3 `ToolEvent`):
  ```
  kind: file_open|file_create|file_edit|file_delete|command|test_result|build|phase|status|error
  run_id, ts, agent, path?, summary, lines_added?, lines_removed?, reason?, payload?
  ```
- **Bus**: the execution `on_event` callback publishes to an in-process pub/sub → WS subscribers +
  an append to `.quorum/context/sessions/<run_id>/events.jsonl` (replayable; late joiners get a
  backfill then live tail). Single source of truth feeding chat, VS Code, and web.

### B) VS Code extension — `apps/qorum-vscode/`
- TypeScript extension (this is a VS Code-API requirement; it talks to the Python server over WS/HTTP
  — no Python execution logic duplicated, so it doesn't violate the single-language engine decision).
- Features:
  - **Live activity tree:** changed files grouped by phase/agent, updating as events arrive; each
    node shows action + reason; click → open the file at the changed range.
  - **Live diff:** as the agent edits, show the file in VS Code's native diff (base branch vs working
    tree) via `vscode.diff`; auto-reveal the active file ("guide me to where it's changing").
  - **Status bar:** "Qorum: editing auth/session.py… · build ✓ · tests 12/14".
  - **Review panel:** Approve-diff → commit / Discard / (opt-in) Push / Open PR — calls the server.
  - Connect via a `run_id` deep link Qorum posts in chat ("Open in VS Code →").
- Packaged as a `.vsix`; configurable server URL + token.

### C) Web dashboard — `apps/qorum-web/`
- Lightweight SPA (or server-rendered) consuming the same WS/HTTP API. Run list, live event feed,
  rendered diff with per-file rationale, and the same approve/discard/push controls. For people not
  in an IDE (leads, reviewers on mobile).

### D) Chat integration (extends Phase 4)
- During execution, the bot edits a single progress message ("▸ editing… ▸ build ✓ ▸ tests 12/14")
  rather than spamming. On finish, posts the diff summary + **[Open in VS Code] [Open dashboard]
  [Approve diff] [Discard]** deep links. Heavy detail lives in the UIs; chat stays concise.

### E) "Guide the developer to the change"
- Every change-log entry carries `path` + line range → VS Code reveal + web "jump" links; the diff
  view orders files by impact; the commit message lists them. Answers "how do I know which folder/file
  changed and how to review it."

## File-level work breakdown
- `qorum/server/{app,ws,runs,auth}.py` + event persistence (`events.jsonl`).
- `qorum/execution/runner.py` — publish events to the bus (already emits; here connect to server).
- `apps/qorum-vscode/` (TS extension: `extension.ts`, activity tree, diff, review panel, ws client).
- `apps/qorum-web/` (SPA: run view, event feed, diff view, controls).
- `qorum/bot/` — progress-message editing + deep links.

## Ordered tasks
1. Finalize `ToolEvent` schema + `events.jsonl` persistence + replay.
2. FastAPI server: WS stream + runs/diff endpoints + token auth; `qorum serve`.
3. Connect execution `on_event` → bus → WS; verify with a CLI WS client.
4. VS Code extension MVP: connect, activity tree, live diff reveal, status bar.
5. Review panel + approve-diff/discard/push wiring (calls Phase 8 commit/discard).
6. Web dashboard MVP (same API).
7. Chat progress-message editing + deep links.
8. End-to-end demo run; commit `feat: real-time visibility (vscode + web)`.

## Edge cases
- **Late joiner / reconnect** → backfill from `events.jsonl` then live tail; idempotent rendering.
- **High event volume** → batch/coalesce rapid edits to the same file; cap UI update rate.
- **Server down / extension offline** → execution still runs (events buffered to jsonl); UI catches
  up on reconnect; chat remains the fallback feed.
- **Auth** → run tokens scoped per run; only authorized users can approve-diff/push.
- **Remote repo / dev not on same machine** → VS Code Remote or web dashboard; the diff is served
  by the API, not assumed local. (For local-only setups, extension can read the working tree directly.)
- **Multiple concurrent runs** → run_id namespacing; UI lists active runs.
- **Approve-diff race** (two reviewers) → server enforces single commit per run (idempotent).

## Verification
- `tests/unit/test_event_bus.py` — publish/subscribe, jsonl replay, backfill+tail ordering.
- `tests/integration/test_ws_stream.py` — execute a scripted run; a WS client receives the expected
  ordered events; `/diff` returns the change log.
- VS Code extension: manual — start a run, watch files reveal + diff update live; approve-diff →
  commit happens on the branch (no push).
- Web dashboard: manual — same run visible with live feed + diff + working controls.

## Definition of Done
- A single event stream drives chat, VS Code, and web; events persist + replay.
- The developer watches files change live in VS Code (native diff, auto-reveal) and/or the web feed,
  sees per-file what/why, and approves the diff → commit (push only if explicitly chosen).
- This completes the M3 viral demo end-to-end.
