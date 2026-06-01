# Phase 5 — Chat Ingestion + Boundary Engine

> **Goal:** Solve the **"from where to where"** problem. Given a `@Qorum plan` trigger, capture
> exactly the right slice of conversation (not historical/off-topic chatter), let the human
> trim/expand it on a confirm card, strip noise, and summarize it into a structured object saved
> to the target repo's `.quorum/`.

## Why now / dependencies
- **Depends on:** Phase 4 (event model, history fetch, thread context, buttons), Phase 2 (LLM for
  the summarizer).
- **Consumed by:** Phase 6 (classifier + locator read the summary), Phase 7 (plan from summary).

## Scope
**In:** the boundary resolver, the range-confirm card flow, noise stripping, the summarizer, the
`Intent` object, persistence to `.quorum/collaboration/`. **Out:** classification + repo location
(Phase 6), plan content (Phase 7).

## Design

### Boundary strategy (priority order) — `qorum/collaboration/ingester.py`
```
resolve_window(ctx: ChatContext, adapter) -> CaptureWindow:
  1. THREAD-SCOPED  — if ctx.thread_id is set (reply thread / Slack thread / Teams reply):
        window = all messages in that thread. Boundary is unambiguous. DONE.
  2. "FROM HERE" ANCHOR — if the trigger message is "plan from here" AND replies to a message M:
        window = messages from M.ts → trigger.ts (same channel). DONE.
  3. DEFAULT LOOK-BACK — else: window = last N messages OR last X minutes (config:
        qorum_capture_default_count=30, qorum_capture_default_minutes=120), whichever is smaller,
        ending at the trigger. NEVER auto-proceed → always go to the confirm card.
```
`CaptureWindow = { messages: list[ChatMessage], start_ts, end_ts, strategy, channel_id, thread_id }`

### Confirm card (always shown before planning) — uses Phase 4 buttons
```
"I read N messages (HH:MM–HH:MM) via <strategy>."
[⬆ Earlier +10]  [⬇ Later -10]  [✂ Trim to last 10]  [✅ Looks right → plan]  [✖ Cancel]
```
- Buttons re-run `resolve_window` with adjusted bounds and `edit_message` to update counts.
- For platforms without a history API (Telegram), the buffer's earliest message caps "Earlier";
  surface "that's all I've seen since joining."
- This single step neutralizes the "vague chat" and "over-broad capture" risks — a human always
  confirms the slice.

### Noise stripping — `qorum/collaboration/clean.py`
Drop: reactions, joins/leaves, bot messages (incl. Qorum's own), file-only/empty posts, pure
emoji. Collapse quoted replies. Keep author + ts for attribution. Configurable deny-kinds.

### Summarizer — `qorum/collaboration/summarizer.py`
- Uses the `summarizer` agent / `summarize` role (Phase 2/3). Input = cleaned messages.
- Output schema `ChatSummary` (Pydantic):
  ```python
  decisions: list[str]            # what the team agreed to
  open_questions: list[str]       # unresolved points (feed ambiguities later)
  context: str                    # the situation / problem
  candidate_titles: list[str]     # for the ticket/plan title
  assignees: list[str]            # @mentioned owners (mapped via identity later)
  referenced_paths: list[str]     # file/module names mentioned (feeds locator in Phase 6)
  links: list[str]                # any board/PR/URL mentioned
  ```
- Persist: `.quorum/collaboration/chat-summaries/{capture-id}-{date}.md` (human-readable) **and**
  the JSON alongside, so Phase 6/7 read structured data (not re-parse markdown). `capture-id` =
  short random id (matches the existing scheme seen in QUORUM-CLAUDE).

### The Intent object — `qorum/collaboration/intent.py`
Unifies chat + board into one type the rest of the pipeline consumes:
```python
@dataclass
class Intent:
    source: Literal["chat", "board"]
    capture: CaptureWindow | None       # chat
    ticket: NormalizedTicket | None     # board (Phase 11)
    summary: ChatSummary | None
    links: list[str]
    author: ChatUser
    raw_ref: dict                       # channel/thread or ticket url
```

## File-level work breakdown
- `qorum/collaboration/{ingester,clean,summarizer,intent}.py`
- `qorum/collaboration/schemas.py` (`CaptureWindow`, `ChatSummary`).
- `qorum/bot/base_adapter.py` — register the `plan`/`plan from here` mention handler →
  `ingester.resolve_window` → confirm card → on "plan", build `Intent` and hand to Phase 6/7.
- Wire confirm-card button actions into `qorum/bot/actions.py`.

## Ordered tasks
1. `schemas.py` + `intent.py`.
2. `ingester.resolve_window` (3 strategies) + unit tests with synthetic message lists.
3. Confirm-card flow (render + button re-resolve + edit_message).
4. `clean.py` noise stripping + tests.
5. `summarizer.py` (agent call → `ChatSummary`) + persistence to `.quorum/collaboration/`.
6. Mention handler glue in the Telegram path; manual end-to-end.
7. Commit `feat: chat ingestion + boundary engine`.

## Edge cases
- **Thread present but trivial** (1 msg) → still allow; summary may be thin → flag low-context.
- **"from here" anchor not a reply** → fall back to default look-back + confirm.
- **Default window spans a topic change** → human trims on the card (that's the point).
- **Buffer shorter than requested window** (Telegram) → cap + inform.
- **Bot's own past messages / other bots** → stripped so the summary isn't polluted.
- **Non-actionable capture** (pure banter) → summarizer returns empty decisions → Phase 6's
  actionability gate stops with a clarifying question.
- **PII / secrets in chat** → summary stores decisions, not raw transcript; raw kept only in the
  session record (Phase 1) with the same retention as other `.quorum` data.

## Verification
- `tests/unit/test_boundary.py` — thread-scoped, from-here, default-window each pick the right
  message set from fixtures; trim/expand adjust bounds correctly.
- `tests/unit/test_clean.py` — noise removed, attribution preserved.
- `tests/unit/test_summarizer.py` — mocked provider returns schema-valid `ChatSummary`; persisted
  files exist with the right names.
- Manual (Telegram): short thread → `@Qorum plan` → confirm card shows correct count/range →
  adjust → produces a saved `ChatSummary`.

## Definition of Done
- The "from where to where" problem is solved by thread-scope → from-here → confirmed window.
- Every capture is human-confirmable before planning; noise is stripped.
- A structured `ChatSummary` + `Intent` is produced and persisted to the target `.quorum/`.
