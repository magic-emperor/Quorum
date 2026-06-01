# Qorum

Qorum is an open-source AI agent that lives inside your team's existing tools. It reads
discussion from Microsoft Teams, Slack, Discord, Telegram, or WhatsApp — or a ticket from
Jira, Azure Boards, Linear, or GitHub — writes a plan, gets team approval, executes the code
changes on an isolated branch while developers watch in real time through VS Code, runs the
build and tests, shows a reviewed diff, and commits. Qorum never pushes automatically.
The developer is always in control.

Works with any AI provider — Anthropic, OpenAI, Google Gemini, Mistral, DeepSeek, Groq,
Moonshot, OpenRouter, or any OpenAI-compatible local model. Runs on any machine or cloud
without vendor lock-in.

---

## Deploy in three commands

```bash
git clone https://github.com/magic-emperor/Quorum.git && cd Quorum
pip install -e ".[all]"
cp qorum/.env.example qorum/.env   # then open .env and add your keys
```

Start on all configured platforms:
```bash
qorum
```

Start on a single platform:
```bash
qorum --teams
qorum --telegram
qorum --slack
```

Start on multiple platforms at once:
```bash
qorum --telegram --discord
qorum --slack --teams
```

That is the entire deployment. Add API keys to `.env`, run one command.

---

## How it works

```
INGESTION    Teams · Slack · Discord · Telegram · WhatsApp
             Jira · Azure Boards · Linear · GitHub Issues
                |
                |  every input becomes one Intent
                v
REASONING    boundary → summarize → classify → locate repo
             → generate plan.md → commit plan into .quorum/ → approval vote
                |
                |  plan approved
                v
EXECUTION    branch qorum/<id> → agent edits code → build/test gate
             → diff review with per-file rationale → commit on approval
                |
                |  live event stream
                v
VISIBILITY   VS Code extension (live diff) + web dashboard (WebSocket)
```

---

## What makes Qorum different

| Tool | Gap |
|------|-----|
| GitHub Copilot for Jira | One model, no memory, no team collaboration |
| Devin | Closed-source, no team collaboration |
| OpenHands | No team collaboration, no PM integration |
| MetaGPT | No persistence, no chat integration |
| Qorum | Open-source · any AI provider · .quorum/ memory in git · chat to plan to approve to execute · live visibility · no auto-push |

---

## Features

### Platform support

**Chat — five platforms**

Qorum connects to all five through a unified adapter interface. Platform-specific card
formats (Adaptive Cards, Block Kit, Discord components, Telegram inline keyboards,
WhatsApp interactive templates) are handled per-adapter. Every platform sends the same
`Intent` object into the reasoning engine.

| Platform | Library | Notes |
|----------|---------|-------|
| Microsoft Teams | botbuilder-core | Adaptive Cards, Action.Execute, proactive messaging |
| Slack | slack-bolt + Socket Mode | Block Kit cards, slash commands |
| Discord | nextcord | Component buttons, thread-aware history |
| Telegram | python-telegram-bot v20+ | Inline keyboards; recommended for local dev |
| WhatsApp | WhatsApp Cloud API | Interactive templates; 24-hour messaging window |

**Boards — four platforms**

| Platform | Notes |
|----------|-------|
| Jira Cloud | Reads tickets, writes status back |
| Azure Boards | Azure DevOps REST API |
| Linear | GraphQL via gql |
| GitHub Issues | REST API |

Use `qorum watch --tool jira --project MYPROJ` to poll a board. Tagged tickets
(`[QORUM]` by default) are converted to the same `Intent` as chat messages.

---

### Any AI provider — with automatic tool gap-filling

Qorum supports eight AI providers out of the box and any OpenAI-compatible endpoint
(including local models via Ollama or LM Studio).

| Provider | Type |
|----------|------|
| Anthropic Claude | Cloud |
| OpenAI (GPT-4o, o3) | Cloud |
| Google Gemini | Cloud |
| Mistral | Cloud |
| DeepSeek | Cloud / self-hosted |
| Groq | Cloud (fast inference) |
| Moonshot / Kimi | Cloud |
| OpenRouter | Gateway (50+ models) |
| Any OpenAI-compatible | Local or cloud |

**Tool gap-filling**

Different providers ship with different native capabilities. Claude and Gemini have
built-in web search and extended reasoning. Groq and DeepSeek are fast inference
endpoints that may not ship native tools.

Qorum detects what each provider natively supports and fills the gaps automatically:

- If the provider has native web search — Qorum uses it.
- If it does not — Qorum injects its own web search tool.
- If the provider has native extended reasoning / thinking — Qorum uses it.
- If it does not — Qorum runs its own ReAct loop (observe → think → act → observe).
- File system, shell execution, git operations, and test running are always Qorum-native
  tools, regardless of provider, because those require access to your local machine.

The result: every provider runs at the same effective capability level. You can switch from
Claude to Groq in your `.env` and the agent behavior stays consistent.

---

### Reasoning pipeline

**Boundary detection**
When Qorum is mentioned in a thread, it detects the relevant message range using a
configurable thread-scope look-back. It always sends a confirmation card (trim / expand)
so developers control what context is included before anything is planned.

**Summarization**
The ingested thread or ticket is summarized by an AI call to extract the actual task from
the surrounding discussion.

**Classification**
Classified into: new feature, bug fix, refactoring, question, or out-of-scope.
Out-of-scope requests are reported back to the chat without proceeding.

**Repository location**
The locator identifies the target repository from context clues in the conversation or
ticket, matched against configured workspace roots.

---

### Plan generation and approval

Qorum generates a `plan.md` and commits it into `.quorum/` in the target repository.
The plan is shown to the team as an approval card on every connected platform.

Approval requires a configurable number of votes. Multiple approvals from the same person
across different platforms count as a single vote (resolved via the contributor identity
registry). Rejections record the reason and stop the run. The full approval history is
written to an append-only audit trail in `.quorum/`.

---

### Execution engine

**Git flow**
1. Stash any working-tree changes in the target repository.
2. Create branch `qorum/<run-id>`.
3. Agent edits files according to the plan.
4. Build and test gate runs (see below).
5. Diff review card with per-file rationale is sent to the team.
6. On developer approval, commit is created. No push ever happens automatically.

**Build and test gate**
Qorum detects the project toolchain — Python, Node.js, Go, Rust, Java — and runs the
appropriate build and test commands before showing the diff. A failing gate blocks the
commit and reports the output back to the chat.

**Cancellation**
`/qorum stop` or the cancel button on the progress card stops an in-progress run from any
platform at any time.

**CI status**
After the commit, Qorum checks and reports CI status for the branch.

---

### Real-time visibility

Every file edit the agent makes is streamed live so developers see changes as they happen,
not after the fact.

**VS Code extension** (`apps/qorum-vscode/`)
A native panel showing live diffs and jump-to-file navigation. Start the visibility server
separately with `qorum serve` and the extension connects automatically.

**Web dashboard**
Served at `http://localhost:7432/`. Shows active runs, event log, and approval status.
Same WebSocket stream as the VS Code extension.

---

### Project memory — `.quorum/`

Every repository Qorum works on gets a `.quorum/` directory committed alongside the code.

```
.quorum/
  nervous-system/
    runs.json          — run index
    contributors.json  — team identity registry
    conflicts.json     — unresolved multi-dev conflicts
  collaboration/
    audit-trail.json   — append-only action and vote log
    approvals/         — one immutable file per approval decision
  plan.md              — current or most recent plan
  task.md              — execution breakdown
```

`.quorum/` is version-controlled. The team's decision history travels with the code.

---

### Multi-developer support

- **Optimistic concurrency** — all `.quorum/` writes use compare-and-swap: the write
  includes a version hash of the prior content and retries on conflict.
- **Merge strategies** — `nervous-system/*.json` merges last-writer-wins per key;
  `audit-trail.json` is append-only; approval records are immutable.
- **Conflict surface** — unresolvable conflicts are written to
  `.quorum/nervous-system/conflicts.json` and reported in the chat.
- **Identity** — approvals across platforms are deduplicated to the same contributor.
  An offline required approver past a configurable timeout escalates to the lead fallback.

---

### Security

**Secrets scanner** — pre-commit guard: regex and entropy analysis of the staged diff.
Blocks the commit if a secret is detected.

**Environment validator** — checks `.env` against `.env.example` at startup and reports
missing or undocumented variables.

**Security scan gate** (optional, runs after build/test, before commit)
- `pip-audit` / `npm audit` / `cargo audit` for CVE checks.
- OWASP-style static analysis over the diff.
- High or critical findings block the commit; overrides are audit-logged.

---

### Cross-platform contributor identity

`contributors.json` maps one contributor record to their user IDs across Teams, Slack,
Discord, Telegram, WhatsApp, and board accounts. Link accounts once with
`/qorum link <platform>`. After that, any action from any account is attributed to the
same person in the audit trail and the approval quorum.

---

## Configuration

All configuration is in `qorum/.env`. Copy the example file and fill in what you use —
every provider and platform section is optional.

```bash
cp qorum/.env.example qorum/.env
```

**AI providers** (set at least one):

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Anthropic Claude |
| `OPENAI_API_KEY` | OpenAI |
| `GOOGLE_API_KEY` | Google Gemini |
| `MISTRAL_API_KEY` | Mistral |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `GROQ_API_KEY` | Groq |
| `MOONSHOT_API_KEY` | Moonshot / Kimi |
| `OPENROUTER_API_KEY` | OpenRouter |
| `OPENAI_COMPAT_BASE_URL` + `OPENAI_COMPAT_API_KEY` | Ollama, LM Studio, or any OpenAI-compatible local model |

**Chat platforms** (set tokens for the platforms you want):

| Variable | Platform |
|----------|----------|
| `QORUM_TEAMS_APP_ID` + `QORUM_TEAMS_APP_PASSWORD` | Microsoft Teams |
| `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` | Slack |
| `DISCORD_BOT_TOKEN` | Discord |
| `TELEGRAM_BOT_TOKEN` | Telegram |
| `QORUM_WHATSAPP_TOKEN` + `QORUM_WHATSAPP_PHONE_ID` | WhatsApp |

**Boards** (set for the boards you want to watch):

| Variable | Board |
|----------|-------|
| `JIRA_BASE_URL` + `JIRA_TOKEN` | Jira Cloud |
| `AZURE_DEVOPS_TOKEN` + `AZURE_DEVOPS_ORG` | Azure Boards |
| `GITHUB_TOKEN` | GitHub Issues |
| `LINEAR_API_KEY` | Linear |

See `qorum/.env.example` for the full list with descriptions and per-role model tier
variables (`QORUM_MODEL_PLAN`, `QORUM_MODEL_CLASSIFY`, `QORUM_MODEL_EXECUTE`, etc.).

---

## CLI reference

| Command | What it does |
|---------|-------------|
| `qorum` | Start on all platforms that have tokens configured |
| `qorum --teams` | Start on Teams only |
| `qorum --slack` | Start on Slack only |
| `qorum --discord` | Start on Discord only |
| `qorum --telegram` | Start on Telegram only |
| `qorum --whatsapp` | Start on WhatsApp only |
| `qorum --telegram --discord` | Start on two platforms simultaneously |
| `qorum serve` | Start visibility server and web dashboard (port 7432) |
| `qorum watch --tool jira --project KEY` | Watch a board project for [QORUM] items |
| `qorum test-url <url>` | Debug ticket URL detection without starting a bot |
| `qorum bot --platform teams` | Alternate long-form platform flag |

---

## Microsoft Teams setup

Full walkthrough: `docs/teams-setup.md`

Short version:
1. Register an Azure Bot Service and note the App ID and App Password.
2. Set `QORUM_TEAMS_APP_ID` and `QORUM_TEAMS_APP_PASSWORD` in `.env`.
3. Point the messaging endpoint to `https://<your-host>/api/messages` (use ngrok or a dev
   tunnel for local testing).
4. Sideload `apps/teams-manifest/manifest.json` into your Teams tenant.
5. `qorum --teams`

To test locally without Azure registration, open the Bot Framework Emulator and connect to
`http://localhost:3978/api/messages` (leave App ID and Password blank in the Emulator).

---

## Runs anywhere

Qorum has no cloud infrastructure dependency. It is a Python process that you run wherever
your code lives:

- Developer laptop
- Self-hosted Linux server or VM
- Any cloud (AWS, Azure, GCP, Hetzner, Fly.io, Railway, etc.)
- Docker container

Local AI models (Ollama, LM Studio) are supported through the OpenAI-compatible provider.
No data leaves your network unless you configure a cloud AI provider key.

---

## Project structure

```
qorum/
  bot/            Chat platform adapters (Teams, Slack, Discord, Telegram, WhatsApp)
  adapters/       Issue board adapters (Jira, Azure, Linear, GitHub)
  providers/      AI provider adapters (8 providers) and registry
  collaboration/  Ingestion, summarization, classification, locator, intent
  core/           Orchestrator, plan generator, schemas, logger, retry
  approval/       State machine, quorum rules, SQLite persistence, approval cards
  execution/      Git flow, agent runner, build/test gate, CI status, cancellation
  memory/         .quorum/ schema definitions, multi-dev CAS sync
  security/       Secrets scanner, env validator, CVE + OWASP gate
  server/         FastAPI REST + WebSocket, event bus, web dashboard
  output/         Output manager, Jinja2 templates (plan, testing, walkthrough)
  prompts/        AI prompt files
apps/
  qorum-vscode/   VS Code extension (live diff panel, run status)
  teams-manifest/ Teams App Manifest
docs/
  teams-setup.md  Full Teams deployment walkthrough
```

---

## Requirements

- Python 3.9 or later (3.11 recommended)
- Tokens for whichever chat platforms and boards you use (all optional at install time)
- At least one AI provider API key

---

## License

MIT
