# Qorum

Qorum is an open-source AI agent that turns team conversation into committed code without
anyone leaving their existing tools. It connects to Microsoft Teams, Slack, Discord, Telegram,
or WhatsApp and to issue boards (Jira, Azure Boards, Linear, GitHub Issues). When a team
discusses a task or a ticket is tagged for Qorum, it reads the conversation, figures out what
needs to be built, writes a plan, gets explicit human approval, executes the work on an
isolated branch while developers watch every file edit happen live in VS Code, runs the build
and tests, presents a diff with per-file rationale, and commits only after a developer
approves. Qorum never pushes automatically and never acts without approval.

Works with any AI provider: Anthropic, OpenAI, Gemini, Mistral, DeepSeek, Groq, Moonshot,
OpenRouter, or any OpenAI-compatible local model including Ollama and LM Studio. Runs on any
machine or cloud without vendor lock-in.

---

## The problem it solves

Development teams discuss work in chat every day. Requirements, edge cases, constraints, and
decisions happen in conversation and then die there. When a developer finally opens an editor,
they re-translate that discussion from memory. Important details get lost. Different developers
interpret things differently. No AI tool sees any of this context.

Qorum closes that gap. Your team chat becomes the planning session. The AI reads the actual
discussion, not a sanitised ticket written after the fact.

---

## How it works

```
Team chats in Teams / Slack / Discord / Telegram / WhatsApp
  OR a ticket is tagged [QORUM] in Jira / Azure / Linear / GitHub
          |
          v
INGESTION -- Qorum reads the thread or ticket and pulls raw context
          |
          v
REASONING
  1. Boundary detection  -- finds the relevant message range, asks team to confirm
  2. Summarization       -- extracts what was actually decided from the discussion noise
  3. Classification      -- bug / feature / enhancement / refactor / chore / out-of-scope
  4. Repo location       -- identifies which codebase this work belongs to
  5. Plan generation     -- writes plan.md, commits it into .quorum/ in the target repo
  6. Approval            -- sends an approval card to the team; waits for required votes
          |
          v
EXECUTION (only after approval)
  1. Creates branch      qorum/<run-id>
  2. Agent edits code    streamed live to VS Code and web dashboard
  3. Build + test gate   runs toolchain-appropriate commands (Python, Node, Go, Rust, Java)
  4. Diff review         sends card with per-file change rationale
  5. Commit              only on developer approval -- no push ever happens automatically
```

---

## What makes Qorum different

| Tool | What it cannot do |
|------|------------------|
| GitHub Copilot for Jira | No team collaboration; one model; no persistent memory |
| Devin | Closed-source; no team collaboration; expensive |
| OpenHands | No team chat integration; no PM board integration |
| MetaGPT | No persistent memory; no chat layer; no approval flow |
| Qorum | Open-source, any AI provider, .quorum/ memory in git, team chat to plan to approve to execute, live diff visibility, no auto-push |

---

## Quick start

```bash
git clone https://github.com/magic-emperor/Quorum.git
cd Quorum
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # Linux / macOS
pip install -e ".[dev,bots,providers,server,teams,adapters]"
cp qorum/.env.example qorum/.env
# Edit qorum/.env -- add at least one AI provider key and one bot token
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

Start on multiple platforms simultaneously:

```bash
qorum --telegram --discord
qorum --slack --teams
```

---

## Supported platforms

### Chat -- five platforms

| Platform | Library | Notes |
|----------|---------|-------|
| Microsoft Teams | botbuilder-core | Adaptive Cards, Action.Execute, proactive messaging |
| Slack | slack-bolt + Socket Mode | Block Kit cards, slash commands |
| Discord | nextcord | Component buttons, thread-aware history |
| Telegram | python-telegram-bot v20+ | Inline keyboards; easiest for local dev |
| WhatsApp | WhatsApp Cloud API | Interactive templates; 24-hour messaging window |

### Issue boards -- four platforms

| Board | Notes |
|-------|-------|
| Jira Cloud | Reads tickets, writes status updates back |
| Azure Boards | Azure DevOps REST API |
| Linear | GraphQL API |
| GitHub Issues | REST API |

Watch a board:

```bash
qorum watch --tool jira --project MYPROJ
qorum watch --tool github --project owner/repo
```

---

## AI providers and tool gap-filling

Qorum is completely provider-agnostic. Set the keys for the providers you want and assign
them per role (plan, classify, execute, summarize) in .env.

| Provider | Type |
|----------|------|
| Anthropic Claude | Cloud |
| OpenAI GPT-4o, o1, o3 | Cloud |
| Google Gemini | Cloud |
| Mistral | Cloud |
| DeepSeek | Cloud or self-hosted |
| Groq | Cloud (fast inference) |
| Moonshot / Kimi | Cloud |
| OpenRouter | Gateway to 50+ models |
| Ollama / LM Studio | Local, no internet required |

### Tool gap-filling

Providers differ in what they natively support. Claude and Gemini have built-in web search.
Claude 3.7+ and OpenAI o1/o3 have extended reasoning. Groq, DeepSeek, and Mistral do not.

Qorum detects what each provider supports and automatically fills the gaps:

- Provider has native web search -- Qorum uses it directly.
- Provider does not -- Qorum injects its own web search tool (DuckDuckGo, no API key needed).
- Provider has native extended reasoning -- Qorum uses it.
- Provider does not -- Qorum runs its own ReAct loop as a reasoning proxy.
- File system, shell, git, build, and test tools are always Qorum-native because they require
  access to your local machine regardless of which AI is running.

Switch from Claude to Groq in .env and the agent behaviour stays consistent.

---

## Execution engine

### Git flow

1. Stash any uncommitted changes in the target repository.
2. Create branch qorum/<run-id>.
3. Agent edits files. Every edit streams live to VS Code and the web dashboard.
4. Build and test gate. Failing gate blocks the commit and reports output to the chat.
5. Diff review card sent to the team with per-file change rationale.
6. On developer approval, commit is created. Nothing is pushed automatically.

### Cancellation

/qorum stop or the cancel button on the progress card halts the run from any platform.
A partial diff is shown for review if files were edited before the stop.

### CI status

After the commit, Qorum checks and reports CI status for the branch.

---

## Real-time visibility

Every file edit streams live as it happens -- not after the fact.

### VS Code extension (apps/qorum-vscode/)

A native side panel showing live diffs, jump-to-file navigation, and run status. Connects
automatically to the Qorum server via WebSocket.

### Web dashboard

Served at http://localhost:7432/. Active runs, event log, approval status, stop controls.
Start it with: qorum serve

---

## Approval and multi-developer support

### Quorum voting

A configurable number of approvals is required before execution starts. Multiple votes from
the same person across different platforms count as one vote, resolved via the contributor
identity registry.

### Cross-platform identity

Each contributor has one record linking their user IDs across all connected platforms. Link
accounts once with /qorum link <platform>. Every action on any platform is then attributed
to the same person in the audit trail.

### Multi-developer .quorum/ sync

All writes to .quorum/ use compare-and-swap (optimistic concurrency). Concurrent edits from
multiple developers merge automatically. Unresolvable conflicts are surfaced in the team chat.

---

## Project memory -- .quorum/

Every repository Qorum works on gets a .quorum/ directory committed alongside the code.

```
.quorum/
  nervous-system/
    runs.json           run index
    contributors.json   team identity registry across all platforms
    conflicts.json      unresolved concurrent-edit conflicts
  collaboration/
    audit-trail.json    append-only log of every action and vote
    approvals/          one immutable file per approval decision
  plan.md               current or most recent plan
  task.md               execution task breakdown
```

The full decision history -- what was planned, who approved it, why it changed -- travels
with the code in version control.

---

## Security

**Secrets scanner** -- pre-commit guard. Regex and entropy analysis of the staged diff.
Blocks the commit if a secret is detected.

**Environment validator** -- checks .env against .env.example at startup. Reports missing
or undocumented variables before the server starts.

**Security scan gate** (optional, runs after build/test, before commit):
- pip-audit, npm audit, or cargo audit for CVE checks on dependencies.
- OWASP-style static analysis over the diff via a security agent.
- High and critical findings block the commit. Overrides are audit-logged.

---

## Version-bump automation

When a team member says "bump version to 2.1.0" in chat or in a ticket, Qorum:

1. Recognises it as a version-bump intent.
2. Creates branch release/2.1.0.
3. Patches the version in pyproject.toml, package.json, Cargo.toml, or build.gradle.
4. Commits with message "chore: bump version to 2.1.0".
5. Shows the diff for approval. Nothing is pushed until the developer explicitly approves.

---

## Configuration

All configuration lives in qorum/.env. Copy the example and fill in only what you need.

```bash
cp qorum/.env.example qorum/.env
```

### AI provider keys

| Variable | Provider |
|----------|----------|
| ANTHROPIC_API_KEY | Anthropic Claude |
| OPENAI_API_KEY | OpenAI |
| GOOGLE_API_KEY | Google Gemini |
| MISTRAL_API_KEY | Mistral |
| DEEPSEEK_API_KEY | DeepSeek |
| GROQ_API_KEY | Groq |
| MOONSHOT_API_KEY | Moonshot / Kimi |
| OPENROUTER_API_KEY | OpenRouter |
| OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_API_KEY | Ollama, LM Studio, any local model |

### Per-role model assignment (optional, defaults to Claude for all roles)

| Variable | Role |
|----------|------|
| QORUM_ROLE_PLAN_PROVIDER + QORUM_ROLE_PLAN_MODEL | Plan generation |
| QORUM_ROLE_CLASSIFY_PROVIDER + QORUM_ROLE_CLASSIFY_MODEL | Intent classification |
| QORUM_ROLE_EXECUTE_PROVIDER + QORUM_ROLE_EXECUTE_MODEL | Code execution |
| QORUM_ROLE_SUMMARIZE_PROVIDER + QORUM_ROLE_SUMMARIZE_MODEL | Thread summarization |

### Chat platform tokens

| Variable | Platform |
|----------|----------|
| QORUM_TEAMS_APP_ID + QORUM_TEAMS_APP_PASSWORD | Microsoft Teams |
| SLACK_BOT_TOKEN + SLACK_APP_TOKEN | Slack |
| DISCORD_BOT_TOKEN | Discord |
| TELEGRAM_BOT_TOKEN | Telegram |
| QORUM_WHATSAPP_TOKEN + QORUM_WHATSAPP_PHONE_ID | WhatsApp |

### Board tokens

| Variable | Board |
|----------|-------|
| JIRA_BASE_URL + JIRA_TOKEN | Jira Cloud |
| AZURE_DEVOPS_TOKEN + AZURE_DEVOPS_ORG | Azure Boards |
| GITHUB_TOKEN | GitHub Issues |
| LINEAR_API_KEY | Linear |

---

## CLI reference

| Command | What it does |
|---------|-------------|
| qorum | Start all platforms that have tokens configured |
| qorum --teams | Start Teams only |
| qorum --slack | Start Slack only |
| qorum --discord | Start Discord only |
| qorum --telegram | Start Telegram only |
| qorum --whatsapp | Start WhatsApp only |
| qorum --telegram --discord | Start two platforms simultaneously |
| qorum serve | Start visibility server and web dashboard on port 7432 |
| qorum watch --tool jira --project KEY | Watch a board for [QORUM] items |
| qorum test-url <url> | Debug ticket URL detection without starting a bot |
| qorum bot --platform teams | Long-form alias (same result as --teams) |

---

## Microsoft Teams setup

Full walkthrough: docs/teams-setup.md

1. Register an Azure Bot Service. Note the App ID and App Password.
2. Set QORUM_TEAMS_APP_ID and QORUM_TEAMS_APP_PASSWORD in qorum/.env.
3. Set the messaging endpoint to https://<your-host>/api/messages.
   For local dev, use ngrok: ngrok http 3978
4. Sideload apps/teams-manifest/manifest.json into your Teams tenant.
5. Run: qorum --teams

To test locally without Azure registration, open the Bot Framework Emulator and connect to
http://localhost:3978/api/messages with App ID and Password left blank.

---

## Runs anywhere

Qorum has no cloud infrastructure dependency. It is a Python process.

- Developer laptop (Windows, macOS, Linux)
- Self-hosted VM or bare metal
- Any cloud (AWS, Azure, GCP, Hetzner, Fly.io, Railway, etc.)
- Docker container

Local AI models via Ollama or LM Studio work through the OpenAI-compatible provider.
No data leaves your network unless you configure a cloud AI provider key.

---

## Project structure

```
qorum/
  adapters/       Issue board adapters (Jira, Azure, Linear, GitHub)
  approval/       Approval state machine, quorum voting, SQLite persistence
  bot/            Chat adapters (Teams, Slack, Discord, Telegram, WhatsApp)
  collaboration/  Ingestion, summarization, classification, repo location, intent
  core/           Orchestrator, plan generator, schemas, logger, retry
  execution/      Git flow, runner, build/test gate, CI, cancellation, version bump
  memory/         .quorum/ schema, multi-developer CAS sync
  output/         Output manager, Jinja2 templates
  providers/      LLM adapters (8 providers) and capability registry
  security/       Secrets scanner, env validator, CVE scan, OWASP gate
  server/         FastAPI REST + WebSocket, event bus, web dashboard
  tools/          Qorum-native tools: fs, shell, git, search, web search, build, test
  watch/          Board polling and ticket write-back
apps/
  qorum-vscode/   VS Code extension (live diff panel, jump-to-file, run status)
  teams-manifest/ Microsoft Teams App Manifest
docs/
  teams-setup.md  Teams deployment walkthrough
```

---

## Requirements

- Python 3.9 or later (3.11 recommended)
- At least one AI provider API key
- Tokens for whichever platforms you want to connect (all optional at install time)

---

## License

MIT
