# Phase 13 — WhatsApp + Slack/Discord Production Adapters

> **Goal:** Broaden channel coverage. Finish **Slack** and **Discord** (stubs exist) on the Phase 4
> event model, and add **WhatsApp** via the Meta Cloud API — accepting that WhatsApp can't render
> rich approval cards, so it gets a **degraded but functional** approval UX.

## Why now / dependencies
- **Depends on:** Phase 4 (event model/actions), Phase 7 (approval/quorum), Phase 10 (server for
  webhooks + deep links). Independent of Teams (Phase 12); can proceed in parallel.

## Scope
**In:** Slack adapter (Block Kit + Socket Mode or Events API), Discord adapter (message components),
WhatsApp adapter (Cloud API, template/interactive messages, numbered-reply approval fallback).
**Out:** new pipeline behavior — these are front-door adapters only.

## Design

### A) Slack — `qorum/bot/slack_adapter.py`
- `slack-bolt` (async). Socket Mode for dev (no public URL); Events API on the Phase 10 server for prod.
- Implement Phase 4 interface:
  - `on_mention` → `app_mention` event; `fetch_history`/`get_thread` → `conversations.history` /
    `conversations.replies` (Slack **has** a history API → real thread-scope + look-back, unlike Telegram).
  - `send_buttons` → **Block Kit** `actions` block; `on_button` → `block_actions` interactivity →
    `ButtonClick`. `edit_message` → `chat.update`.
  - Slack **threads** map directly to the Phase 5 thread-scope boundary.
- Identity: Slack user id → contributor (`platforms.slack_id`).

### B) Discord — `qorum/bot/discord_adapter.py`
- `discord.py`. Implement interface:
  - `on_mention` → message mentioning the bot; `fetch_history` → channel history API; threads →
    Discord threads or reply chains.
  - `send_buttons` → **message components** (Buttons/Views); `on_button` → interaction callbacks →
    `ButtonClick`. `edit_message` → message edit.
- Identity: Discord user id → contributor.

### C) WhatsApp — `qorum/bot/whatsapp_adapter.py` (degraded UX)
- **Meta WhatsApp Cloud API** (REST + webhook on the Phase 10 server). Constraints to design around:
  - No threads, no rich cards. Only: text, **interactive reply buttons (max 3)**, list messages, and
    **template messages** outside the 24-hour customer-service window.
  - **24-hour window:** Qorum can only freely message a user within 24h of their last message; outside
    it, must use pre-approved templates.
  - No history API → rely on the Phase 4 rolling buffer (messages seen while running).
- Mapping the interface:
  - `on_mention` → there's no @mention; trigger on a command keyword (`qorum plan`) in the message text.
  - Boundary → no threads → **default look-back + confirm**, where confirm uses **interactive reply
    buttons** ("✅ Looks right", "✂ Last 10", "✖ Cancel") within the 3-button limit; "Earlier/Later"
    offered as **numbered text replies** ("reply 1 = +10 earlier").
  - `send_buttons` (approval) → interactive buttons when ≤3 (Approve/Reject/Changes); if more options
    needed → a **list message** or numbered-reply fallback ("reply A to approve, R to reject").
  - Progress/result → concise text + a **deep link** to the web dashboard (Phase 10) for the diff
    (since no rich rendering in WhatsApp).
- Document the degraded UX clearly; recommend Teams/Slack for full-fidelity approvals.

## File-level work breakdown
- `qorum/bot/{slack_adapter,discord_adapter,whatsapp_adapter}.py`.
- `qorum/bot/cards/{blockkit,discord_components,whatsapp_interactive}.py` (render neutral `Button[]`).
- `qorum/server/webhooks.py` — Slack Events, WhatsApp webhook (verify tokens/signatures).
- config: `QORUM_SLACK_*` (exist), `QORUM_DISCORD_BOT_TOKEN` (exists), `QORUM_WHATSAPP_TOKEN`,
  `QORUM_WHATSAPP_PHONE_ID`, `QORUM_WHATSAPP_VERIFY_TOKEN`, `QORUM_WHATSAPP_APP_SECRET`.

## Ordered tasks
1. Slack adapter (Socket Mode dev) → mention → pipeline → Block Kit approval → button → execute.
2. Discord adapter → mention → components approval → button → execute.
3. WhatsApp adapter: webhook + send; interactive-button approval within 24h window.
4. WhatsApp boundary confirm via buttons + numbered-reply fallback; template message for out-of-window.
5. Identity mapping for all three.
6. Tests + commit `feat: slack, discord, whatsapp adapters`.

## Edge cases
- **Slack** — Events API retries (3s ack) → ack fast, process async; reinstall/scope changes → re-auth.
- **Discord** — interaction must be acknowledged within 3s → defer + follow-up; intents/permissions
  (message content intent) must be enabled.
- **WhatsApp 24h window** → outside it, only templates; if a result lands outside the window, send a
  template "your Qorum task finished, open dashboard" instead of free text.
- **WhatsApp >3 actions** → list message or numbered replies; never assume rich buttons.
- **WhatsApp no history** → buffer-only; if range predates buffer, say so.
- **Phone-number identity** → map to contributor; one person across Teams/Slack/WhatsApp → unified via
  `contributors.json` (Phase 14).
- **Webhook signature verification** failures → reject; log.

## Verification
- `tests/unit/test_blockkit.py`, `test_discord_components.py`, `test_whatsapp_interactive.py` —
  neutral `Button[]` → correct platform payloads; inbound interaction → `ButtonClick`.
- Slack (manual, Socket Mode): mention → approval → execute on a scratch repo.
- Discord (manual): same.
- WhatsApp (manual, test number): keyword → confirm window (buttons) → approval (buttons) → result +
  dashboard deep link; verify behavior just inside vs outside the 24h window.

## Definition of Done
- Slack + Discord fully implement the Phase 4 interface (history, threads, buttons) with full-fidelity
  approvals.
- WhatsApp works end-to-end with a documented degraded UX (interactive buttons + numbered-reply
  fallback + dashboard deep links + 24h-window handling).
- All channels feed the same pipeline; identity maps to contributors.
