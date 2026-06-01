# Phase 4 — Bot Core + Event Model + Telegram Dev Harness

> **Goal:** Turn the command-only bot base into a real **platform-agnostic event model** that
> can read messages, threads, and button callbacks — then wire **Telegram** as the local
> end-to-end test harness (cheapest channel: long-polling, no public endpoint, inline buttons).

## Why now / dependencies
- **Depends on:** Phase 1 (correct orchestrator + public API). Parallelizable with Phase 2/3.
- **Consumed by:** Phase 5 (ingestion needs message-history fetch + thread context), Phase 7
  (approval cards need button callbacks), Phases 12–13 (other channels implement this interface).

## Scope
**In:** the unified bot event model, an enriched `BaseQorumAdapter`, Telegram adapter upgraded to
the new model (history fetch, threads-via-reply, inline keyboards, callback routing), a runnable
`qorum bot` entrypoint. **Out:** the boundary/ingestion logic itself (Phase 5), approval card
content (Phase 7), Teams/WhatsApp/Slack/Discord production adapters (Phases 12–13).

## Design

### The event model — `qorum/bot/events.py`
Replace the thin `BotContext` with a richer, platform-neutral set:
```python
@dataclass
class ChatUser:    id: str; display_name: str | None; platform_ids: dict[str, str]
@dataclass
class ChatMessage: id: str; author: ChatUser; text: str; ts: datetime;
                   reply_to_id: str | None; thread_id: str | None; is_bot: bool; kind: str  # text|reaction|join|file
@dataclass
class ChatContext: platform: str; workspace_id: str | None; channel_id: str;
                   thread_id: str | None; trigger_message: ChatMessage; me: ChatUser
@dataclass
class ButtonClick: platform: str; channel_id: str; user: ChatUser; action: str; payload: dict; message_id: str
```

### Enriched base adapter — `qorum/bot/base_adapter.py`
Add abstract methods every platform must implement (Telegram first, others later):
```python
async def fetch_history(self, channel_id: str, *, thread_id=None,
                        anchor_message_id=None, limit=200) -> list[ChatMessage]: ...
async def get_thread(self, channel_id: str, thread_id: str) -> list[ChatMessage]: ...
async def send_buttons(self, channel_id: str, text: str,
                       buttons: list[Button], thread_id=None) -> str: ...   # returns message_id
async def edit_message(self, channel_id: str, message_id: str, text: str,
                       buttons: list[Button] | None = None) -> None: ...
async def on_mention(self, handler): ...      # register @Qorum handler
async def on_button(self, handler): ...       # register callback handler
```
- Keep existing `send_message`/`start`/`stop`.
- A platform-neutral `Button` = `{ label, action, payload, style }`. Each adapter renders it to
  its native control (Telegram InlineKeyboard now; Teams Adaptive Card / Slack Block Kit later).
- **Callback routing:** a single `dispatch_button(click: ButtonClick)` maps `action` →
  orchestrator/approval calls (approve/request-changes/mark-done/trim-range/etc.). Action names
  are an enum in `qorum/bot/actions.py` so all platforms agree.

### Trigger model
- Bot responds to **@mention of the bot** or the `/qorum` command (keep `/atlas` alias).
- `on_mention` fires with full `ChatContext` (including `trigger_message.reply_to_id` and
  `thread_id`) — Phase 5 uses these for the boundary.
- Keyword auto-trigger (e.g. message contains `[QORUM]`) is a config flag, off by default.

### Telegram harness — `qorum/bot/telegram_adapter.py`
- Upgrade from command-only to the full model using `python-telegram-bot`:
  - `fetch_history`: Telegram bots can't read arbitrary history via Bot API → maintain a
    **rolling in-memory + SQLite message buffer** per chat (store messages the bot sees while
    running). `anchor_message_id` uses `reply_to_message`. Document this Telegram limitation in
    the file (it shapes the boundary fallback in Phase 5).
  - Threads = reply chains (`reply_to_message`).
  - `send_buttons` → `InlineKeyboardMarkup`; `on_button` → `CallbackQueryHandler` → `ButtonClick`.
- `qorum bot --platform telegram` entrypoint in `qorum/main.py` (long-polling; no public URL).

## File-level work breakdown
- `qorum/bot/events.py` (new), `qorum/bot/actions.py` (new), `qorum/bot/buttons.py` (new).
- `qorum/bot/base_adapter.py` (extend; keep backward-compatible command parsing).
- `qorum/bot/message_store.py` (new — SQLite-backed rolling buffer for platforms without history API).
- `qorum/bot/telegram_adapter.py` (rewrite to new model).
- `qorum/main.py` (add `bot` subcommand).

## Ordered tasks
1. `events.py`, `actions.py`, `buttons.py`.
2. Extend `BaseQorumAdapter` with the new abstract methods + `dispatch_button`.
3. `message_store.py` rolling buffer + tests.
4. Rewrite Telegram adapter to the new model; wire `on_mention`/`on_button`.
5. `qorum bot` entrypoint; manual smoke against a real Telegram bot token.
6. Commit `feat: bot event model + telegram harness`.

## Edge cases
- **Telegram can't fetch old history** → rely on the rolling buffer; if the requested range
  predates the buffer, tell the user (Phase 5 confirm card surfaces this).
- **Bot added to a group mid-conversation** → buffer starts empty; first plan can only see
  messages since join.
- **Button clicked by a non-approver** → `dispatch_button` checks identity (full rule in Phase 7).
- **Duplicate callback** (double-tap) → idempotent action handling (dedupe by message_id+action).
- **Edited/deleted messages** → buffer updates on edit events where the platform sends them.

## Verification
- `tests/unit/test_event_model.py`, `test_message_store.py` (buffer windows, anchor lookup).
- Manual end-to-end: in a Telegram group, @mention the bot → it replies; tap an inline button →
  `ButtonClick` dispatched and acked.
- `tests/integration/test_telegram_adapter.py` with a mocked PTB application.

## Definition of Done
- One event model used by the base adapter; Telegram fully implements it (messages, reply-threads,
  inline buttons, callbacks).
- `qorum bot --platform telegram` runs and round-trips a mention + a button click locally.
- Rolling message buffer persists across handler calls and survives restart (SQLite).
