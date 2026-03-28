# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**QUORUM** is an autonomous multi-agent development framework. It takes a plain-English description and runs a 6-phase pipeline (Architecture → Design → Build → Integration → Testing → Scaling) using 28 specialized AI agents, maintaining persistent memory in a `.quorum/` folder inside each user's project.

This repo is the QUORUM monorepo — the framework itself, not a project built with it.

---

## Monorepo Structure

npm workspaces. Every package is TypeScript ESM (except `packages/vscode` which is CommonJS).

```
packages/
  core/          — ATLASEngine, AgentRunner, providers, memory managers, command handlers
  cli/           — `quorum` CLI binary (Commander.js) — thin wrapper around ATLASEngine
  collaboration/ — Team chat → plan → approval → execution layer
  mcp/           — MCP server exposing QUORUM tools (14 tools)
  vscode/        — VS Code extension

apps/
  quorum-server/  — Express + Socket.IO API (port 3001), SQLite via better-sqlite3
  quorum-web/     — React dashboard (port 3000, Vite)
  quorum-bot/     — Unified Slack + Discord + Telegram bot
  teams-bot/     — Microsoft Teams bot (Bot Framework, port 3978)
  telegram-bot/  — Standalone Telegram bot (legacy, migrated to quorum-bot)
  quorum-console/ — React Native mobile app (Expo)

agents/          — 28 agent .md files with YAML frontmatter
```

---

## Build & Dev Commands

### Build everything
```bash
npm run build           # from repo root — builds all workspaces
```

### Individual packages
```bash
cd packages/core && npm run build       # tsc
cd packages/cli && npm run build        # tsc + chmod dist/index.js
cd packages/collaboration && npm run build
cd packages/mcp && npm run build
```

### Run a service in dev mode
```bash
cd apps/quorum-server && npm run dev     # tsx watch src/index.ts
cd apps/quorum-web && npm run dev        # vite (port 3000)
cd apps/teams-bot && npm run dev        # tsx watch src/index.ts (port 3978)
cd apps/quorum-bot && npm run dev
```

### TypeScript type-check (no emit)
```bash
cd packages/core && npx tsc --noEmit
cd apps/quorum-server && npx tsc --noEmit
```

### Run the CLI without global install
```bash
node packages/cli/dist/index.js <command>
# Or after build: quorum <command>  (if globally linked)
```

---

## Testing

```bash
# All tests
npm run test                         # from root — runs all workspaces

# packages/collaboration — Vitest
cd packages/collaboration && npm test        # 61 tests
cd packages/collaboration && npm run test:watch

# apps/teams-bot — Vitest
cd apps/teams-bot && npm test                # 52 tests

# packages/core — Jest
cd packages/core && npm test
```

Single test file:
```bash
cd packages/collaboration && npx vitest run src/__tests__/approval-manager.test.ts
cd apps/teams-bot && npx vitest run src/__tests__/bot-routing.test.ts
```

---

## Core Architecture

### QUORUMEngine (`packages/core/src/engine.ts`)

The central class. All CLI commands, API calls, and bot commands ultimately call `engine.run({ command, description, ... })`.

```
ATLASEngine.run(command)
  ├── 'new'      → classify → Foundation Mode (if new) → runArchitecturePhase → runDesignPhase → runBuildPhase → runIntegrationPhase → runTestingPhase → runScalingPhase
  ├── 'enhance'  → scope guard → load memory → runBuildPhase only
  ├── 'fast'     → single quorum-coder call, no pipeline
  ├── 'chat'     → quorum-chat agent, multi-turn
  └── 30+ other commands → individual runX() functions in commands/
```

### AgentRunner (`packages/core/src/agent-runner.ts`)

Reads an agent `.md` file (YAML frontmatter + markdown body), builds a system prompt, calls the routed provider/model, streams output. All agent calls go through here.

### Routing Table (`packages/core/src/providers/`)

`buildRoutingTable(config)` inspects available API keys and assigns each agent to the best available provider/model tier (smart → balanced → fast). The routing table is built once at `initialize()` and passed to every `runner.run()` call.

### Memory System (`packages/core/src/memory/`)

| Manager | File in .quorum/ | Purpose |
|---------|----------------|---------|
| NervousSystem | `nervous-system/` | Decisions, actions, stack, bugs |
| GoalGuardian | `goal.md` | Scope guard — blocks out-of-scope requests |
| TaskManager | `task-index.json`, `task.md` | Task tracking |
| PlanManager | `plan-index.json`, `plan.md` | Phase progress |
| SessionBriefManager | *(generated)* | Session context for agents |
| FunctionRegistry | `function-registry.json` | Code symbol index |

### Tool Executor (`packages/core/src/tool-executor.ts`)

Agents can request tool calls (file_write, glob_search, bash_exec, etc.). The engine intercepts these and executes them safely.

---

## Agent Format

Every file in `agents/` is a Markdown file with YAML frontmatter:

```markdown
---
name: quorum-backend-architect
description: One-line description used for routing decisions
tools: ["Read", "Write", "Bash", "Glob", "Grep"]
model: sonnet   # smart | balanced | fast | haiku | sonnet | opus
---

Agent instructions in markdown...
```

The `model` field is a tier hint; the actual model is resolved by the routing table against available API keys.

---

## Collaboration Layer (`packages/collaboration/`)

Handles the Team Chat → Plan → Approve → Execute flow.

```
chat-ingester.ts   — pulls messages from Teams/Slack/Discord/Telegram platform APIs
summarizer.ts      — LLM call to extract decisions, goal, AC from raw messages
plan-builder.ts    — creates plan.md + task.md, writes to .quorum/, creates approval request
approval-manager.ts — quorum logic (any / all / majority / lead)
identity-mapper.ts — platform user ID ↔ QUORUM user ID resolution
quorum-folder.ts    — CollaborationStore: read/write .quorum/collaboration/
```

Approval quorum modes: `any` (first approval triggers), `all` (everyone must approve), `majority`, `lead` (specific user IDs).

---

## API Server (`apps/quorum-server/`)

Express + Socket.IO. SQLite database (`quorum-local.db`, via better-sqlite3 — synchronous queries, no async/await needed for DB calls).

Key routes:
- `POST /api/auth/register|login` — JWT auth
- `POST /api/sessions/execute` — spawns `quorum` CLI as a child process via `SessionRunner`, streams stdout as Socket.IO events (`session:event`)
- `POST /api/collaboration/plan|approve|reject|story` — collaboration layer
- `POST /api/watch/start|stop` — PM tool watcher sessions

`SessionRunner` (`src/services/session-runner.ts`) spawns the CLI, captures stdout line-by-line, emits to room `session:{id}` via Socket.IO.

Required env vars: `JWT_SECRET`, `BOT_SECRET` (shared with bots), `PORT` (default 3001).

---

## Bot Architecture (`apps/quorum-bot/`)

Platform-agnostic design. `BotContext` interface (`src/types.ts`) abstracts `reply()`, `replyCard()`, `updateCard()`, `getHistory()`. All command logic is in `src/handlers/commands.ts` — never calls platform APIs directly.

```
src/adapters/slack.ts      — Slack Bolt app, app_mention handler
src/adapters/discord.ts    — discord.js, messageCreate + interactionCreate
src/adapters/telegram.ts   — node-telegram-bot-api, inline keyboard callbacks
src/cards/card-builder.ts  — renderCard(card, platform) → Adaptive Card / Block Kit / Discord Embed / Telegram InlineKeyboard
```

`src/index.ts` starts only the adapters whose tokens are present in env.

---

## TypeScript Module Rules

All packages use `"module": "NodeNext"`. This means:
- All local imports must use `.js` extension: `import { foo } from './bar.js'`
- Even when the source file is `bar.ts`, the import says `.js`
- This is intentional and correct — do not change to `.ts`

---

## Key Config: `quorum.config.json`

Lives in the user's project root (not this repo). `packages/core/src/engine.ts` looks for it at `quorum.config.json` or `.quorum/config.json`.

Important fields:
- `api_keys` — provider keys (env vars take priority)
- `loop_limits` — `architect_validator_max_rounds` (3), `integration_max_rounds` (2), `bug_fix_max_attempts` (2)
- `checkpoints` — `require_human_phase_1/2/5`, `prompt_scaling_phase_6`, `auto_proceed_simple_projects`
- `token_budgets` — per-phase token limits

`quorum.config.json` in this repo root is a working example with Google AI + Groq keys.

---

## Pipeline Phase Outputs

Each phase writes documents to `.quorum/context/` for the next phase to consume:

| Phase | Writes | Reads |
|-------|--------|-------|
| 1 Architecture | `architecture-proposal.md` | — |
| 2 Design | `design-proposal.md` | `architecture-proposal.md` |
| 3 Build | `api-contract.md`, `frontend-api-calls.md` | `design-proposal.md` |
| 4 Integration | `integration-fixes.md` | `architecture-proposal.md`, `frontend-api-calls.md` |
| 5 Testing | `BUGS.md`, `test-coverage.json` | `integration-fixes.md`, `bug-registry.json` |
| 6 Scaling | `scaling-report.md` | `architecture-proposal.md`, `function-registry.json` |

Rollback point `rp_003_build_complete` is created after Phase 3.
