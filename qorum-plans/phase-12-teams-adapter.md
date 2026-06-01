# Phase 12 — Microsoft Teams Adapter (lead production channel)

> **Goal:** Ship the **enterprise headline channel**. Implement the Phase 4 bot event model for
> Microsoft Teams using the Python Bot Framework: Adaptive Cards with `Action.Execute` for
> approvals, reply-threads as the chat boundary, proactive messaging for progress, and Azure AD
> identity mapping. Teams is built *after* the core works (proved on Telegram) because it needs an
> Azure registration + a public HTTPS endpoint to test.

## Why now / dependencies
- **Depends on:** Phase 4 (event model + actions), Phase 7 (approval cards/quorum), Phase 5
  (thread-scoped boundary maps perfectly to Teams replies), Phase 10 (server for the messaging
  endpoint + deep links).
- **Lead product channel** per the locked decisions.

## Scope
**In:** Teams adapter implementing `BaseQorumAdapter`, Adaptive Card rendering of Qorum buttons,
Bot Framework wiring (messaging endpoint, auth), proactive messaging, Azure AD identity → Qorum
contributor mapping, registration/runbook. **Out:** non-Teams channels (Phase 13), enterprise SSO
hardening beyond identity mapping (Phase 14).

## Design

### A) Adapter — `qorum/bot/teams_adapter.py`
- Use `botbuilder-core` / `botbuilder-schema` (Python). A FastAPI route on the Phase 10 server
  (`POST /api/messages`) receives Bot Framework activities → `TeamsAdapter.process_activity`.
- Implement the Phase 4 interface:
  - `on_mention` → fires on `@Qorum` mentions (Teams sends the bot mention in `entities`).
  - `fetch_history` / `get_thread` → Teams **supports reply threads**; a message in a reply chain
    has the root id → fetch the thread's replies (Graph API or conversation reference). Thread-scope
    boundary (Phase 5 strategy #1) is the primary path on Teams (cleaner than Telegram's buffer).
  - `send_buttons` → render `Button[]` as an **Adaptive Card** with `Action.Execute` actions whose
    `verb`+`data` carry our `action`+`payload`.
  - `on_button` → `Invoke` activity (`adaptiveCard/action`) → map to `ButtonClick` → `dispatch_button`.
  - `edit_message` → update the card (progress) via the activity id (Teams supports updating activities).
  - `send_message` proactive → store a `ConversationReference` per channel; use `continue_conversation`
    to post progress/results without the user re-initiating.
- Card builders: extend `qorum/bot/cards/` with Adaptive Card JSON renderers for approval / progress /
  result / confirm-range cards (the platform-neutral `Button`/card spec from Phase 4/7 → Adaptive Card).

### B) Identity mapping — `qorum/bot/identity.py` (Teams part)
- Teams gives AAD object id + UPN per user. Map to a Qorum contributor in
  `.quorum/collaboration/contributors.json` (`platforms.teams_id`). Used by the quorum engine to
  resolve required approvers and enforce "only the approver sees/acts" (Teams supports
  **user-specific Adaptive Card views** via `Action.Execute` + per-user refresh).

### C) Registration runbook (document in the phase file + `docs/teams-setup.md`)
- Create an **Azure Bot Service** resource; set the messaging endpoint to `https://<host>/api/messages`.
- App registration (AAD) → client id/secret → `QORUM_TEAMS_APP_ID` / `QORUM_TEAMS_APP_PASSWORD`.
- Build a **Teams app manifest** (`apps/teams-manifest/`) → sideload for dev, admin-install for org.
- Local testing: **Bot Framework Emulator** against `/api/messages`; then a **dev tunnel**
  (VS Code dev tunnels / ngrok) to a test Teams tenant.

## File-level work breakdown
- `qorum/bot/teams_adapter.py`, `qorum/bot/cards/adaptive.py`, `qorum/bot/identity.py` (Teams).
- `qorum/server/app.py` — add `/api/messages` route + Bot Framework auth middleware.
- `apps/teams-manifest/` (manifest.json + icons).
- `docs/teams-setup.md` (registration runbook).
- config: `QORUM_TEAMS_APP_ID`, `QORUM_TEAMS_APP_PASSWORD`, `QORUM_TEAMS_TENANT_ID`.

## Ordered tasks
1. `/api/messages` route + Bot Framework auth; echo bot smoke via Emulator.
2. Adaptive Card renderer for the approval card (`Action.Execute`) + `on_button` Invoke handling.
3. `on_mention` + thread fetch (reply-thread boundary) → run the Phase 5–7 pipeline.
4. Proactive messaging (store ConversationReference; progress/result updates via Phase 10 events).
5. Identity mapping (AAD → contributor) + approver enforcement.
6. Manifest + dev-tunnel test against a real test tenant; full demo.
7. Commit `feat: microsoft teams adapter`.

## Edge cases
- **Invoke vs message activities** — approvals come as `Invoke` (must return the right
  `InvokeResponse` quickly, then do async work) → ack within Teams' timeout, process in background.
- **Card update races** (multiple approvers) → update via activity id idempotently; user-specific
  refresh so only approvers see Approve.
- **Proactive without prior reference** (bot never messaged in that channel) → can't proactively post;
  fall back to replying on next interaction.
- **Tenant admin consent not granted** → clear setup error; document required Graph permissions.
- **Threaded vs channel-root messages** — root-level @mention with no thread → use Phase 5 default
  look-back + confirm (Teams history via Graph where permitted).
- **Message size / card limits** → keep cards concise; deep-link heavy detail to VS Code/web (Phase 10).
- **Bot Framework token refresh** → handled by SDK; surface auth failures clearly.

## Verification
- `tests/unit/test_adaptive_cards.py` — `Button[]`→Adaptive Card JSON; Invoke payload→`ButtonClick`.
- Bot Framework Emulator: mention → pipeline runs → approval card → tap Approve → execution starts.
- Dev tunnel + test tenant: full chat→plan→approve→execute→commit with progress posted proactively
  to the Teams channel.

## Definition of Done
- Teams fully implements the Phase 4 interface: mentions, reply-thread boundary, Adaptive Card
  approvals (`Action.Execute`), proactive progress, card updates.
- AAD identity maps to Qorum contributors; approver-only actions enforced.
- A documented registration path; the viral demo runs in a real Teams tenant.
