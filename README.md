# QUORUM

**Multi-Agent AI Framework for Development Teams**

QUORUM is a multi-agent AI framework that builds features end-to-end — with persistent memory, 28 coordinated agents, multi-model routing, and a team collaboration layer that turns chat conversations into executable plans.

```bash
quorum new "Build a SaaS for restaurant management with real-time orders"
```

↓ ~40 minutes later ↓

Working application. Architecture docs. Bug registry. Cost analysis. Zero re-explanation next session.

---

## Table of Contents

1. [5 Ways to Use QUORUM](#5-ways-to-use-quorum)
2. [Team Collaboration — Chat to Code](#team-collaboration--chat-to-code)
3. [Telegram Integration](#telegram-integration)
4. [Discord Integration](#discord-integration)
5. [CLI Commands](#cli-commands)
6. [Where QUORUM Beats Claude Code](#where-quorum-beats-claude-code)
7. [AI Providers](#ai-providers)
8. [Project Memory (.quorum/)](#project-memory-quorum)
9. [MCP — Use QUORUM as a Tool in Any IDE](#mcp--use-quorum-as-a-tool-in-any-ide)
10. [VS Code Extension](#vs-code-extension)
11. [Quick Start](#quick-start)
12. [Server Deployment](#server-deployment)
13. [Monorepo Structure](#monorepo-structure)

---

## 5 Ways to Use QUORUM

QUORUM is not a single tool — it is a platform with five distinct entry points. You can use one or all of them depending on your workflow.

| Platform | How to Use | Best For |
|----------|-----------|----------|
| **CLI** | `npm i -g @quorum/cli` → `quorum new "..."` | Primary developer interface — full feature pipeline |
| **VS Code Extension** | Install from marketplace → sidebar panel | IDE-first workflow — run agents without leaving your editor |
| **MCP Server** | Add to Claude Desktop / Claude Code / Cursor config | Use QUORUM's 14 tools from inside any MCP-compatible IDE |
| **Telegram Bot** | `/login` → link account → discuss in group chat | Team collaboration — discuss, plan, approve, and execute from Telegram |
| **Discord Bot** | Invite bot → `@QUORUM login` → discuss in channel | Team collaboration — same workflow as Telegram but on Discord |

All five entry points connect to the same backend (`quorum-server`) and the same persistent memory (`.quorum/`). A plan created in Telegram and a plan created via CLI are the same plan.

---

## Team Collaboration — Chat to Code

This is QUORUM's most powerful feature and what sets it apart from every AI coding tool that requires a single developer sitting at a terminal.

### The Problem It Solves

Development teams discuss features in chat every day — describing requirements, debating edge cases, calling out constraints. That context lives in chat and dies there. When a developer finally opens their editor, they have to manually re-translate that discussion into tasks. Important decisions get lost. Different developers interpret things differently. The AI tool knows none of this context.

QUORUM closes that gap. Your team chat **becomes** the planning session.

### The Full Workflow

```
1. Team discusses in Telegram or Discord group chat
   "We need guest checkout — no account required, but we still need to track the order"
   "Should we create a temporary user ID in the DB?"
   "Yes but expire it after 30 days. Marketing wants email capture optional"
   "Cart should persist for 24 hours even without account"
   ...

2. When ready: @QUORUM plan
   QUORUM reads the last 30 messages of the conversation.
   Its AI summarizer extracts:
   - What the team agreed to build
   - Key decisions made in discussion
   - Acceptance criteria (implied or stated)

3. QUORUM posts an approval card in the chat:
   ┌─────────────────────────────────────────┐
   │ Plan: Guest Checkout Flow               │
   │                                         │
   │ Context: Add guest checkout that...     │
   │                                         │
   │ Decisions:                              │
   │  • Temporary user ID, expires 30 days   │
   │  • Email capture is optional            │
   │  • Cart persists 24 hours               │
   │                                         │
   │ Acceptance Criteria:                    │
   │  • Guest can complete purchase          │
   │  • Order tracked in DB                  │
   │  • Cart survives browser close          │
   │                                         │
   │ [✅ Approve]  [❌ Reject]               │
   └─────────────────────────────────────────┘

4. Team lead (or any authorized member) clicks Approve.
   QUORUM immediately triggers execution on the server.
   The full 28-agent pipeline runs against your actual codebase.

5. Progress streamed back to the chat:
   ▶️ Execution started. Session: sess_abc123
   (Monitor with @QUORUM watch or quorum status in terminal)
```

### Why This Matters

- **No context loss** — the AI reads actual team discussion, not a sanitized ticket written after the fact
- **No single-developer bottleneck** — planning happens where the team already is
- **Audit trail** — every plan has an ID, a summary, and an approval record
- **Quorum-based approval** — you can require multiple approvals before execution starts (configurable)

---

## Telegram Integration

QUORUM's Telegram adapter is built into `apps/quorum-bot` — the unified bot that speaks both Telegram and Discord through a shared command layer. Every command below works identically whether you are using a private Telegram chat or a Telegram group.

### Setup

1. Ask your admin for the bot username (e.g. `@YourQuorumBot`)
2. Add the bot to your Telegram group (or open a private chat)
3. Run `/login` to link your QUORUM Console account
4. Start discussing — when ready, type `@YourQuorumBot plan`

### Telegram Commands

#### `/login`
Links your Telegram account to your QUORUM Console account. QUORUM sends you a one-time link in the chat. Click it, sign in to the web console, and your accounts are connected. All future bot commands will run under your identity, with your authorization level.

#### `@QUORUM plan`
Reads the last 30 messages of the current conversation (excluding bot messages) and passes them to QUORUM's summarizer agent. The agent extracts context, decisions, and acceptance criteria, then posts an interactive approval card in the chat. Requires at least 3 non-bot messages to have enough signal. If the project directory is not configured, the bot will tell you to contact the admin.

#### `@QUORUM story`
Reads the conversation and generates a formatted user story (As a / I want / So that) ready to be pasted directly into Jira, Linear, or Azure Boards. Returns the story ID so you can reference it later. Useful before planning — turn the discussion into a story first, then plan execution.

#### `@QUORUM story for <context>`
Same as `@QUORUM story` but you can provide extra context that is not in the conversation. Example: `@QUORUM story for mobile checkout flow` — the extra context is passed to the story writer alongside the conversation history.

#### `@QUORUM approve`
Approves the most recent pending plan for this channel. If quorum-based approval is configured (e.g., requires 2 approvals), QUORUM records your approval and waits for the remaining votes. When the quorum is reached, execution starts automatically.

#### `@QUORUM reject`
Rejects the pending plan. QUORUM marks the plan as rejected and posts a message asking the team to continue discussing and re-submit. No execution happens.

#### `@QUORUM reject because <reason>`
Rejects the plan with a specific reason. The reason is stored with the plan record and shown on the rejection card. Example: `@QUORUM reject because we haven't discussed the error states yet`. The reason helps the team understand what to fix before re-submitting.

#### `@QUORUM compact`
Summarizes the last 50 messages into 4–6 bullet points and replaces the in-memory conversation history with that summary. This is useful in long threads where the history is getting too long for the AI to process efficiently. The summary is posted in chat so everyone can see what was captured.

#### `@QUORUM watch`
Starts monitoring a connected project management tool (Jira, Linear, Azure Boards) for new tickets assigned to the team. When a new ticket appears, QUORUM automatically generates a plan from the ticket description and posts it for approval — without any manual `/plan` call. Example: `@QUORUM watch jira` or `@QUORUM watch linear`.

#### `@QUORUM watch stop`
Stops the PM tool watcher. No more automatic plans will be generated until watch is started again.

#### `@QUORUM stop`
Interrupts a currently running execution session. Sends an interrupt signal to the server. Use this when a build is going in the wrong direction and you want to stop it before it finishes. The session is saved so you can resume or modify the plan.

#### `@QUORUM status`
Checks whether your Telegram account is linked to a QUORUM Console account and whether there is an active session running.

#### `@QUORUM logout`
Unlinks your Telegram account from QUORUM. Your account still exists on the server — you can `/login` again to reconnect. Use this if you are changing accounts or revoking access.

#### `@QUORUM help`
Posts the full command reference in the chat.

---

## Discord Integration

QUORUM's Discord adapter is part of the same `apps/quorum-bot` package. It works through slash commands and `@QUORUM` mentions. Every command has identical behavior to Telegram — the underlying logic is shared.

### Setup

1. Invite the QUORUM bot to your Discord server (use the invite link from your QUORUM Console)
2. Add the bot to the channels where your team discusses features
3. Type `@QUORUM login` — the bot will DM you a one-time link
4. Click the link, sign in, and your Discord account is connected

### Discord Commands

Discord supports both slash commands (`/plan`, `/story`) and `@QUORUM` mentions. Slash commands work in any channel the bot has access to.

#### `/login` or `@QUORUM login`
Links your Discord account to QUORUM Console via a one-time DM link. Same flow as Telegram.

#### `@QUORUM plan` or `/plan`
Reads the last 30 messages in the current channel and generates an approval card. In Discord, the approval card renders with interactive buttons — team members click Approve or Reject directly in the message. No need to type a command to vote.

#### `@QUORUM story` or `/story`
Generates a formatted user story from the current channel's conversation history. Posts the story as a formatted embed and provides the story ID for Jira/Linear/Azure Boards import.

#### `@QUORUM story for <context>` or `/story for <context>`
Story generation with additional context hint. Example: `@QUORUM story for the iOS app dark mode feature`.

#### Interactive Approve Button
On the approval card that `@QUORUM plan` generates, Discord renders real buttons. The Approve button calls `handleApprove` directly — you don't type a command. The approval is recorded under the identity of whoever clicked the button.

#### Interactive Reject Button
The Reject button on the approval card. In Discord, clicking Reject opens a modal asking for a reason — the reason is pre-filled as optional. Submit the modal to record the rejection with or without a reason.

#### `@QUORUM compact` or `/compact`
Summarizes and compresses channel history. Identical to Telegram.

#### `@QUORUM watch <tool>` or `/watch <tool>`
Starts PM tool watcher. Example: `@QUORUM watch linear`. Posts new ticket plans in the channel automatically.

#### `@QUORUM watch stop` or `/watch stop`
Stops the watcher.

#### `@QUORUM stop` or `/stop`
Interrupts the running execution session.

#### `@QUORUM status` or `/status`
Shows link status and active session info.

#### `@QUORUM logout` or `/logout`
Unlinks your Discord account from QUORUM Console.

#### `@QUORUM help` or `/help`
Posts the command reference.

### Approval Quorum in Discord

Because Discord supports channel-level interaction, you can configure QUORUM to require multiple approvals from team members. For example, if `quorum: 2` is set, the approval card will show a vote counter and execute only when two distinct team members have clicked Approve. This is where the name "QUORUM" comes from — decisions are made by the team, not by one person.

---

## CLI Commands

Install the CLI globally with `npm install -g @quorum/cli`. All commands run in the context of your current directory and read from `.quorum/` if it exists.

### Core Build Pipeline

#### `quorum new "description"`
Kicks off the full 28-agent pipeline for a net-new feature. QUORUM reads your `.quorum/goal.md` and existing codebase, routes to the appropriate agents, and builds the feature end-to-end — architecture decisions, code, tests, and documentation. If a `.quorum/context/discuss-{slug}.md` file exists (created by `quorum discuss`), it is automatically loaded as additional context.

This is the primary command. Most people use it for the majority of their work.

#### `quorum enhance "description"`
Modifies or extends an existing feature. Unlike `quorum new`, this command reads `.quorum/task.md` and existing code more aggressively — it understands what already exists and builds on top of it rather than starting fresh. Use this when you are adding a new field, changing behavior, or expanding scope without rewriting from scratch.

#### `quorum fast "description"`
Skips the full planning phase and goes straight to implementation. A classifier agent first evaluates whether the task is actually simple enough to skip planning. If it is, the task runs with a smaller set of agents and completes faster. If the classifier decides the task is complex, it falls through to the normal pipeline automatically. Good for bug fixes, small UI changes, and well-defined one-step tasks.

#### `quorum discuss "description"`
Opens a pre-planning Q&A session where QUORUM asks you clarifying questions about the feature before any code is written. Your answers are saved to `.quorum/context/discuss-{slug}.md`. The next time you run `quorum new` with a matching description, this context is automatically loaded — meaning the agents start with full background on your intentions, constraints, and edge cases.

Use this before complex features to reduce misunderstandings and back-and-forth during the build.

### Session Control

#### `quorum next`
Reads `.quorum/task.md` and tells you exactly what the next pending task is and what to run. Useful when you are resuming work after a break and want to know where you left off without reading the full task log.

#### `quorum pause`
Saves the complete current session state — what agents were running, what phase was active, what was completed. The session can be resumed later with `quorum resume`. Use this when you need to switch contexts and want to pick up exactly where you left off.

#### `quorum resume`
Restores the most recently paused session and continues execution from where it stopped. QUORUM reloads all context and picks up the pipeline at the interrupted step.

#### `quorum status`
Shows the current phase, the routing table (which model is handling which agent), estimated token cost so far, and any active or paused sessions. Use this to get a quick health check of what QUORUM is doing.

#### `quorum session-report`
Generates a formatted markdown summary of the current or most recent session — what was built, which agents ran, what decisions were made, estimated cost. Useful for documenting a session for your team or for your own records.

### Quality and Review

#### `quorum verify`
Runs the full validation suite — E2E tests via Playwright, type checks, and any custom validators defined in your project. Reports pass/fail per test and gives an overall signal on whether the build is ready to ship.

#### `quorum review "target"`
Runs a code review on a specific file, directory, or PR. QUORUM's critic agent analyzes the code against your `.quorum/goal.md`, existing patterns in the codebase, and general best practices. Returns specific, actionable comments — not generic suggestions.

#### `quorum debug "symptom"`
Performs root cause analysis on a bug or unexpected behavior. Describe the symptom (e.g., `quorum debug "cart total is NaN when discount applied"`) and QUORUM traces through the relevant code, identifies the most likely cause, and produces a fix with explanation. The fix and its reasoning are saved to `.quorum/BUGS.md` so future agents can learn from it.

#### `quorum ship`
Runs a pre-ship checklist — tests pass, types are clean, no obvious security issues, no hardcoded secrets, documentation is in place. Also checks that the feature satisfies the acceptance criteria in `.quorum/goal.md`. Returns a go/no-go signal with specific blockers if no-go.

### Project Memory

#### `quorum init`
Initializes the `.quorum/` directory for an existing project that was not started with QUORUM. Creates `goal.md` (prompts you to describe the project goal), `task.md`, `DEVGUIDE.md` (runs a codebase analysis), and the full nervous-system structure. Run this once at the start of any project you want to bring under QUORUM management.

#### `quorum map [area]`
Generates or updates `DEVGUIDE.md` — a structured developer guide derived from reading your actual codebase. Without an area argument, maps the entire project. With an area (e.g., `quorum map auth` or `quorum map api`), generates a focused guide for that subsystem. New developers can read this file to onboard in minutes instead of hours.

#### `quorum seed "text"`
Adds information directly to the Nervous System memory — the distributed knowledge graph that agents read at runtime. Use this to encode decisions, constraints, and tribal knowledge that are not in the code. Example: `quorum seed "We use Stripe for payments, not Paddle — do not suggest Paddle"`. Agents will respect this permanently.

#### `quorum backlog add "task"`
Adds a structured item to the project backlog in `.quorum/`. Items in the backlog can be queried by `quorum next` and referenced by agents when deciding what to work on. Use this to capture work items that are not yet ready to execute.

#### `quorum note "text"`
Writes a quick unstructured note to `.quorum/NOTES.md`. Good for capturing decisions mid-session that you want to formalize later. Does not affect agent behavior — this is purely for humans.

#### `quorum export [--output path]`
Exports the entire `.quorum/` directory as a single formatted markdown document. Useful for sharing project context with someone who does not have QUORUM installed, or for creating a snapshot before a major refactor. Default output is `quorum-export-{date}.md` in the project root.

### Configuration and Monitoring

#### `quorum doctor`
Checks your entire QUORUM setup — API keys for all configured providers, connectivity to `quorum-server` if configured, agent definitions, `.quorum/` structure validity. Reports what is working, what is missing, and how to fix each issue. Run this first when anything is not working as expected.

#### `quorum agents`
Lists all 28 agent definitions with their current model assignments. Shows which model each agent is routed to based on your current profile and available API keys. Use this to understand cost and capability tradeoffs — you can see at a glance if a critical agent is using a weaker model because a key is missing.

#### `quorum profile <name>`
Switches the model routing profile. Three built-in profiles:
- `fast` — All agents use the fastest/cheapest available models. Best for iteration and exploration.
- `balanced` — Default. Mix of powerful models for planning agents and fast models for execution agents.
- `quality` — All agents use the most capable models available. Best for production-ready builds where cost is secondary.

You can also create custom profiles in `quorum.config.json`.

#### `quorum key add/list/remove`
Manages API keys for AI providers. Keys are stored encrypted in `quorum.config.json` (never committed to git — this file is in `.gitignore`). `quorum key add` prompts for provider and key. `quorum key list` shows which providers are configured (keys are masked). `quorum key remove` deletes a provider's key.

#### `quorum sync`
Re-indexes the Function Registry and Nervous System after manual code changes. QUORUM maintains a `function-registry.json` that maps function names, signatures, and locations — this makes codebase navigation 99% cheaper than reading full files. If you manually edit code outside of QUORUM, run `quorum sync` to keep the index accurate.

#### `quorum rollback [point]`
Returns the project to a previous rollback point. QUORUM records rollback points at the start of each `quorum new` or `quorum enhance` run. Without an argument, rolls back to the most recent point. With a point ID, rolls back to that specific state. This is a safety mechanism for when a build goes wrong and you want to start over without using git.

### CI/CD Mode

Any command can be run with `--auto` to skip all human checkpoints. Use this in automated pipelines where there is no human to approve steps.

```bash
# GitHub Actions example
quorum new "Add OAuth login" --auto
quorum verify --auto
quorum ship --auto
```

```yaml
# .github/workflows/quorum-build.yml
- name: QUORUM Feature Build
  run: quorum new "${{ github.event.inputs.feature }}" --auto
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

---

## Where QUORUM Beats Claude Code

These are not marginal differences. Each one represents a fundamentally different design choice.

### Persistent Memory Across Sessions

**Claude Code**: Every session starts blank. You re-explain the project, the constraints, the architecture decisions, the things that went wrong last time. A new developer joining the project has no AI-assisted onboarding.

**QUORUM**: The `.quorum/` directory is your project's permanent memory. `goal.md` defines the project's purpose. `task.md` tracks every completed task. `DEVGUIDE.md` documents the codebase architecture. `BUGS.md` records every bug and its root cause. `nervous-system/` stores decisions, stack choices, and open questions as structured JSON. Agents read all of this before every run — they already know your project without you saying a word.

The practical result: a task that took 45 minutes in session 1 takes 15 minutes in session 10 because the agents know the codebase intimately. And a new developer can run `quorum map` and get a complete onboarding document in minutes.

### Team Collaboration Built In

**Claude Code**: Designed for one developer at a terminal. There is no mechanism for a team to discuss requirements and route them to AI execution.

**QUORUM**: The Telegram and Discord collaboration layer means your entire team can participate in the AI-assisted development process from their phones or desktops. Discussion → plan summary → approval vote → execution — all in the chat your team already uses. The quorum-based approval model means no single person can trigger a build unilaterally. This is what the name refers to.

### Multi-Model Routing

**Claude Code**: Runs on Claude. One model, one provider, one pricing tier.

**QUORUM**: Routes each agent to the best available model for its job. The planner might use Claude Opus. The code writer might use GPT-4o. The test runner might use Groq's Llama for speed and cost. If Anthropic is down, QUORUM falls back to another provider automatically. If you are on a budget, switch to the `fast` profile and all agents route to the cheapest models. This is configurable per agent, per profile, or globally — and it works across Anthropic, OpenAI, Google, Groq, DeepSeek, Mistral, and Ollama.

### The Critic Agent Blocks Unverified Claims

**Claude Code**: Agents can make assumptions. If an agent assumes a library works a certain way and that assumption is wrong, the code is written against the wrong assumption. This is discovered at runtime.

**QUORUM**: `quorum-critic` runs after every planning step and challenges assumptions. If the planner assumes "the DB schema already has a `user_id` column," the critic verifies this against the actual codebase before the builder writes code that depends on it. Unverified claims are flagged and must be resolved — by reading the code, by asking the developer, or by including the necessary setup as part of the plan. This eliminates an entire category of build failures.

### Function Registry — Codebase Navigation Without Full File Reads

**Claude Code**: To understand a codebase, Claude reads files. Reading a 500-line file to find one function signature costs the same as reading all 500 lines.

**QUORUM**: `quorum sync` indexes your codebase into `function-registry.json` — a compact map of every function name, its file path, its line number, its parameters, and a one-line description. Agents query this registry to navigate code instead of reading files. Finding a function costs a single registry lookup instead of a full file read. On a 50,000-line codebase, this makes complex multi-file tasks 99% cheaper in tokens and significantly faster in wall-clock time.

### Real E2E Tests via Playwright

**Claude Code**: Suggests tests in text form. You run them yourself. There is no AI that clicks through your application to verify it actually works.

**QUORUM**: `quorum-testing` and `quorum-integration` agents use Playwright to run real browser-based E2E tests against your actual running application. QUORUM does not just write tests — it runs them, evaluates the results, and feeds failures back to the builder agent for fixing. `quorum verify` and `quorum ship` both include this step. The build is not done until the application actually passes tests in a browser.

### GoalGuardian — Scope Enforcement

**Claude Code**: An agent given a vague prompt will do whatever it decides is necessary. There is no mechanism to stop an agent from making large architectural changes when you asked for a small feature.

**QUORUM**: `quorum-orchestrator` reads `goal.md` at the start of every run. GoalGuardian monitors every agent action and blocks anything that contradicts or exceeds the project's stated scope. If you built a REST API and an agent is about to rewrite it as GraphQL because it seemed like a good idea, GoalGuardian stops it. Scope is enforced programmatically, not by hoping the AI interprets your intent correctly.

### BUGS.md — Agents Learn From Every Past Bug

**Claude Code**: Every session is a clean slate. A bug fixed in session 3 can be made again in session 15 because there is no memory of the previous fix.

**QUORUM**: Every bug diagnosed with `quorum debug` is written to `.quorum/BUGS.md` — the symptom, the root cause, the fix, and the principle behind the fix. All agents read `BUGS.md` before writing code. If `quorum-backend-builder` is about to write code that matches a pattern that caused a bug three months ago, it has already read that bug's entry and knows to avoid it. The codebase gets more reliable over time, not just bigger.

---

## AI Providers

QUORUM works with any combination of these providers. You need at least one API key. Run `quorum doctor` to see which are configured and which models are available.

| Provider | Models | Best For |
|----------|--------|----------|
| Anthropic | Claude 3.5 Sonnet, Claude 3 Haiku, Claude 3 Opus | Default quality choice — planning, architecture |
| OpenAI | GPT-4o, GPT-4o-mini | Strong alternative for code generation |
| Google | Gemini 1.5 Pro, Gemini 1.5 Flash | Long context tasks, large file analysis |
| Groq | Llama 3.1 70B, Llama 3.1 8B | Fast + extremely cheap — great for `fast` profile |
| DeepSeek | DeepSeek-V2 | Cost-efficient code completion |
| Mistral | Mistral Large | European data residency requirements |
| Ollama | Any local model | Air-gapped environments, zero cost, full privacy |

Auto-routing: `quorum doctor` builds a routing table based on which keys are present. Agents are automatically assigned the best available model for their role.

---

## Project Memory (`.quorum/`)

Every QUORUM project has a `.quorum/` directory in the project root. This is not a cache — it is the permanent knowledge base that makes QUORUM's persistent memory possible. Add it to your version control to share context across your team.

```
your-project/
└── .quorum/
    ├── goal.md                         ← Project purpose, enforced by GoalGuardian
    ├── task.md                         ← Complete task log — every completed task
    ├── DEVGUIDE.md                     ← Auto-generated codebase documentation
    ├── BUGS.md                         ← Bug registry — symptom, cause, fix, lesson
    ├── NOTES.md                        ← Human-written notes (quorum note "text")
    ├── context/
    │   ├── discuss-{slug}.md           ← Pre-planning Q&A (quorum discuss)
    │   └── codebase-map.md             ← Structural overview
    └── nervous-system/
        ├── decisions.json              ← Architecture decisions and rationale
        ├── actions.json                ← Action history
        ├── function-registry.json      ← Full codebase function index (quorum sync)
        ├── stack.json                  ← Tech stack: languages, frameworks, DB, infra
        └── open-questions.json         ← Unresolved questions flagged during builds
```

---

## MCP — Use QUORUM as a Tool in Any IDE

QUORUM ships with a full MCP (Model Context Protocol) server that exposes 14 tools. Any MCP-compatible host can use QUORUM's agents as tools — including Claude Desktop, Claude Code, Cursor, and Windsurf.

### What This Means

When QUORUM is configured as an MCP server, tools like Claude Desktop gain direct access to QUORUM's agents. You can type "build me an auth system" in Claude Desktop and QUORUM's full pipeline runs — not just Claude generating text, but actual agents writing files, running tests, and updating memory.

### Configure in Claude Desktop

```json
{
  "mcpServers": {
    "quorum": {
      "command": "node",
      "args": ["/path/to/quorum/packages/mcp/dist/server.js"],
      "env": {
        "ANTHROPIC_API_KEY": "your-key",
        "DEFAULT_PROJECT_DIR": "/path/to/your/project"
      }
    }
  }
}
```

### Configure in Claude Code

```bash
claude mcp add quorum node /path/to/quorum/packages/mcp/dist/server.js
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `quorum_new` | Run the full build pipeline for a new feature |
| `quorum_enhance` | Modify an existing feature |
| `quorum_fast` | Quick task without full planning |
| `quorum_status` | Get current session status |
| `quorum_verify` | Run the test suite |
| `quorum_debug` | Root cause analysis and fix |
| `quorum_map` | Generate or update DEVGUIDE.md |
| `quorum_seed` | Add to Nervous System memory |
| `quorum_note` | Write a quick note |
| `quorum_agents` | List agents and model assignments |
| `quorum_backlog_add` | Add to project backlog |
| `quorum_export` | Export .quorum/ as markdown |
| `quorum_sync` | Re-index function registry |
| `quorum_doctor` | Check configuration health |

All tools communicate over stdio transport — no network port, no daemon, no separate server process required.

---

## VS Code Extension

Install the QUORUM VS Code extension to run agents without leaving your editor.

### Features

- **Sidebar panel** — Run `quorum new`, `quorum enhance`, `quorum status` from a dedicated panel
- **Status bar item** — Shows current session phase and progress at the bottom of VS Code
- **Output panel** — Streams agent output in real time directly in VS Code
- **Command palette** — All QUORUM commands available via `Ctrl+Shift+P → QUORUM: ...`

### Install

Install from the VS Code marketplace (search "QUORUM") or build from source:

```bash
cd packages/vscode
npm install
npm run build
# then install the .vsix from the dist/ folder
```

---

## Quick Start

```bash
# Install CLI
npm install -g @quorum/cli

# Go to your project
cd your-project

# Initialize QUORUM memory
quorum init

# Check what AI providers are configured
quorum doctor

# Add an API key if needed
quorum key add

# Start building
quorum new "Add user authentication with OAuth"
```

---

## Server Deployment

`quorum-server` is the backend that powers team collaboration. You need it running for Telegram/Discord bots and for multi-user sessions. For solo CLI use, the server is optional.

### Local / Docker

```bash
# Copy environment template
cp .env.example .env

# Edit .env — set these required values:
# JWT_SECRET=<random 32+ char string>
# TELEGRAM_BOT_TOKEN=<from @BotFather>
# DISCORD_BOT_TOKEN=<from Discord Developer Portal>
# BOT_SECRET=<shared secret between server and bot>
# ANTHROPIC_API_KEY=<your key>

# Start everything
docker-compose up -d
```

- Web dashboard: http://localhost:3000
- API server: http://localhost:3001
- Bot connects to server automatically using `QUORUM_SERVER_URL` from bot's env

### What quorum-server Provides

- User authentication (JWT)
- Session management and streaming
- Collaboration endpoints: `/api/collaboration/plan`, `/plan/approve`, `/plan/reject`, `/story`, `/compact`
- Bot auth linking: connects Telegram/Discord user IDs to QUORUM Console accounts
- SQLite database (auto-created, no setup required)

---

## Monorepo Structure

```
Quorum/
├── packages/
│   ├── core/           ← QuorumEngine, memory system, AI providers, agent runner
│   ├── cli/            ← 25+ CLI commands (quorum new, enhance, debug, etc.)
│   ├── mcp/            ← 14 MCP tools — stdio server for Claude Desktop/Code/Cursor
│   ├── vscode/         ← VS Code extension (sidebar, panel, status bar)
│   └── collaboration/  ← Shared collaboration types and utilities
├── apps/
│   ├── quorum-bot/     ← Unified Telegram + Discord + Slack bot (shared command layer)
│   ├── quorum-server/  ← Express + Socket.IO + SQLite backend
│   ├── quorum-console/ ← React Native mobile app (Expo) — monitor sessions anywhere
│   ├── quorum-web/     ← React web dashboard (Vite)
│   └── teams-bot/      ← Microsoft Teams adapter
├── agents/             ← 28 agent definition files (.md)
├── docker-compose.yml
└── .env.example
```

### The 28 Agents

QUORUM's intelligence is distributed across 28 specialized agents. Each agent has a defined role and is assigned a model based on the active profile.

| Agent | Role |
|-------|------|
| `quorum-orchestrator` | Master coordinator — routes tasks to agents, enforces goal |
| `quorum-planner` | Breaks features into executable steps |
| `quorum-classifier` | Decides fast vs full pipeline |
| `quorum-critic` | Challenges assumptions before code is written |
| `quorum-coder` | General-purpose code writer |
| `quorum-backend-architect` | Designs API, DB schema, service structure |
| `quorum-backend-builder` | Implements backend code |
| `quorum-backend-validator` | Validates backend logic and edge cases |
| `quorum-frontend-builder` | Implements UI components |
| `quorum-design-architect` | Designs component and state structure |
| `quorum-design-validator` | Validates UI against design requirements |
| `quorum-testing` | Writes and runs unit/integration tests |
| `quorum-integration` | Runs E2E tests via Playwright |
| `quorum-security` | Reviews code for security issues |
| `quorum-deps` | Manages dependencies and version conflicts |
| `quorum-env-manager` | Handles env config and secrets |
| `quorum-nervous-system` | Updates and queries project memory |
| `quorum-task-manager` | Updates task.md, tracks progress |
| `quorum-monitor` | Monitors running sessions and reports |
| `quorum-summarizer` | Summarizes discussions for plan/story |
| `quorum-story-writer` | Generates user stories for PM tools |
| `quorum-approver` | Manages approval workflow logic |
| `quorum-chat` | Handles conversational interaction |
| `quorum-cost-advisor` | Analyzes and optimizes infrastructure cost |
| `quorum-scale-advisor` | Advises on scaling strategy |
| `quorum-scaling` | Implements scaling configuration |
| `quorum-changelog` | Generates changelogs and release notes |
| `quorum-ba-watcher` | Watches PM tools for new tickets |

---

## License

MIT
