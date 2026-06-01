# Qorum

> AI agent that turns team chat and board tickets into reviewed, committed code.

**Chat → Plan → Approve → Execute → See it happen → Commit**

A team discusses work in Teams, Telegram, Slack, or Discord (or a ticket is created in Jira/Azure Boards/Linear/GitHub). Qorum reads the discussion, decides what type of work it is, finds the right codebase, writes a `plan.md` (committed into the repo), gets human approval, **executes the work on a branch while the developer watches live in VS Code**, runs the build/tests, shows the diff with per-file rationale, and commits **only on the developer's approval** — never auto-pushing.

## What makes it different

| Product | Gap |
|---------|-----|
| GitHub Copilot for Jira | Ticket → draft PR (one model, no memory, no team collab) |
| Devin | $500/mo, closed-source, no team collaboration |
| OpenHands | No team collaboration, no PM integration |
| MetaGPT | No persistence, no chat layer |
| **Qorum** | Open-source · any API key · `.quorum/` memory committed to git · team chat → plan → approve → execute · live visibility · no auto-push |

## Quick start

```bash
git clone ...
cd qorum
python -m venv .venv && .venv/Scripts/activate
pip install -e ".[dev]"
cp .env.example .env
# fill in at least ANTHROPIC_API_KEY + one board token or bot token
python -m qorum --help
```

## Architecture (three planes)

```
PLANE 1 — INGESTION     Teams · Telegram · Slack · Discord · WhatsApp
                        Jira · Azure Boards · Linear · GitHub
                           ↓  (every input → one Intent object)
PLANE 2 — REASONING     boundary → summarize → classify → locate → PLAN → approve
                           ↓  (plan.md lives in the target repo's .quorum/)
PLANE 3 — EXECUTION     branch → agent edits code → build/test gate → diff review
                           ↓  (streamed live to VS Code + web dashboard)
                        commit (on developer approval) — no auto-push
```

## Phase plans

Detailed per-phase execution plans are in [`qorum-plans/`](qorum-plans/README.md).

## Configuration

Copy `.env.example` → `.env`. Every provider key is optional — set only the ones you use.
See `.env.example` for documentation.

## Project memory

Each project Qorum works on gets a `.quorum/` directory committed alongside the code.
It stores plans, decisions, actions, collaboration history, and audit trails.
Schema: [`qorum/memory/schema.py`](qorum/memory/schema.py).
