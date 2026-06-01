# Phase 11 — Board Front Door (integrated) + `quorum watch`

> **Goal:** Make issue boards a **second front door into the same pipeline**. A pasted Jira/Azure
> link or a `quorum watch` keyword trigger produces an `Intent` that flows through the exact same
> classify → locate → plan → approve → execute → commit path as chat — and Qorum posts results back
> to the ticket (comment + status), bidirectionally.

## Why now / dependencies
- **Depends on:** Phase 7 (plan+approval), Phase 8 (execution) — boards reuse them. The board
  *adapters* already exist (`qorum/adapters/`), so this phase is integration + watching + write-back,
  not new fetching.
- **Decision:** integrated, one engine two front doors (per master plan).

## Scope
**In:** mapping the existing `NormalizedTicket` into the `Intent` object, the `quorum watch`
long-runner (poll/webhook), bidirectional write-back (comment + status + PR link), ticket→repo
mapping in the registry. **Out:** new board platforms beyond the existing four (future), chat
boundary (Phase 5 — N/A for boards).

## Design

### A) Board → Intent — `qorum/collaboration/intent.py` (extend)
- `Intent.source="board"`, `Intent.ticket=NormalizedTicket` (from the existing adapter fetch),
  `Intent.summary` built from the ticket (title + description + acceptance_criteria + comments)
  via a light summarizer pass so downstream sees the same `ChatSummary`-shaped context.
- `referenced_paths` extracted from ticket text → feeds the **locator** (Phase 6) exactly like chat.
- A board Intent **skips the chat boundary/confirm card** (no message window) but still goes through
  classify → locate → plan → approval.

### B) `quorum watch` — `qorum/watch/runner.py`
```
quorum watch --tool=jira --project=PAY --keyword="[QORUM]" --channel=teams [--poll=60s | --webhook]
```
- **Poll mode:** every interval, query the board API for items matching the keyword/JQL/WIQL whose
  status is "ready"; dedupe already-processed (track in `.quorum/watch-state.json`).
- **Webhook mode:** a FastAPI route (reuse Phase 10 server) receives board webhooks; verify signature.
- On match → build board `Intent` → run pipeline → post the approval card to the configured `--channel`
  (Teams/Telegram/etc., reusing Phase 4 adapters). Approval + execution identical to chat path.

### C) Bidirectional write-back — `qorum/adapters/base.py` (extend interface)
Add to the adapter interface (implement for Jira + Azure first, GitHub + Linear next):
```python
async def post_comment(self, ticket_id, body) -> None
async def update_status(self, ticket_id, status) -> None      # mapped via config status-map
async def link_pr(self, ticket_id, pr_url) -> None            # where supported
```
Write-back points:
- Plan created → comment "Qorum plan ready, awaiting approval" + link to the plan/dashboard.
- Approved + executing → status → "In Progress".
- Done (committed) → comment with branch + change summary + gate result; status → "In Review";
  link PR if the developer opened one (Phase 8 opt-in). **Never** transitions a ticket without the
  corresponding pipeline event.
- Status names are **configurable per board** (`registry.json` status-map: `in_progress`, `in_review`).

### D) Ticket → repo mapping
- Registry gains `board_project → repo_path` (Phase 6 already supports `match.board_project`). The
  locator resolves the repo from the ticket's project; if unmapped → UNRESOLVED → ask (in the channel).

## File-level work breakdown
- `qorum/collaboration/intent.py` — board→Intent builder.
- `qorum/watch/{runner,state,jql}.py` + `quorum watch` CLI in `qorum/main.py`.
- `qorum/server/webhooks.py` — board webhook routes (reuse Phase 10 server).
- `qorum/adapters/{base,jira_cloud,azure_boards,github_issues,linear}.py` — add write-back methods.
- `registry.json` — `board_project` mappings + status-map.

## Ordered tasks
1. Board→Intent builder + summarizer pass; run a pasted Jira link through the full pipeline.
2. Write-back interface + Jira/Azure implementations (comment/status/link) + tests with fixtures.
3. `quorum watch` poll mode + dedupe state + post to a channel.
4. Webhook mode on the Phase 10 server (signature verify) — Jira + Azure first.
5. Ticket→repo mapping in locator; status-map config.
6. End-to-end: create a `[QORUM]` ticket → watch detects → plan card in Telegram → approve → execute
   → ticket commented + status updated.
7. Commit `feat: board front door + quorum watch + bidirectional updates`.

## Edge cases
- **Duplicate detection** (poll overlap) → dedupe via `watch-state.json` (processed ids + hash).
- **Webhook replay / out-of-order** → idempotent by ticket id + event id.
- **Status name mismatch** (board uses custom workflow) → status-map; if unmapped, comment only + warn.
- **Ticket edited after plan** → on next interaction, detect changed description → offer re-plan.
- **No repo mapped for project** → UNRESOLVED → ask in channel; don't guess.
- **Permission/token expired** → clear error to the channel + `quorum doctor` hint; don't crash the watcher.
- **Rate limits** → `with_retry`; back off polling.
- **Ticket + chat both reference the same work** → merge (Phase 5 Intent merge): board criteria +
  chat decisions into one plan.

## Verification
- `tests/unit/test_board_intent.py` — ticket → Intent/summary with referenced_paths + acceptance criteria.
- `tests/unit/test_writeback.py` — comment/status/link called with correct mapped values (mocked APIs).
- `tests/integration/test_watch_poll.py` — fixture board returns a `[QORUM]` item → pipeline triggered once
  (dedupe on second poll).
- Manual: real Jira test project → `[QORUM]` ticket → approval card appears → approve → ticket updated.

## Definition of Done
- A pasted board link and a `quorum watch` keyword both run the **same** classify→…→commit pipeline.
- Qorum posts plan/progress/result back to the ticket (comment + mapped status + PR link) only on real
  events.
- Ticket→repo resolution works; the board is a true second front door, not a separate product.
