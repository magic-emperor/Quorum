# QUORUM — Future Roadmap & Feature Plan
Version: 1.0 | Created: March 2026 | Status: Planning

---

## SAME PROJECT OR SEPARATE?

**Everything stays in QUORUM-CLAUDE. One repo.**

Reason: All new features share the same ATLASEngine, the same .quorum/ memory
system, and the same agent pipeline. Splitting creates dependency hell and
defeats the persistent memory architecture.

New additions slot into the existing monorepo structure:

```
QUORUM-CLAUDE/
  packages/
    core/                 ← EXISTS — engine, agents, providers, memory
    mcp/                  ← EXISTS — MCP server
    cli/                  ← EXISTS — CLI tool
    collaboration/        ← NEW — team collab layer (see Section 2)
  apps/
    quorum-server/         ← EXISTS — API + Socket.IO backend
    quorum-web/            ← EXISTS — Web dashboard
    quorum-console/        ← EXISTS — React Native mobile
    telegram-bot/         ← EXISTS — migrate to Chat SDK (see Section 3)
    quorum-bot/            ← NEW — unified bot (Slack + Teams + Discord + Telegram)
  agents/                 ← EXISTS — add new agents here
  skills/                 ← EXISTS — add new skills here
```

---

## SECTION 1: CURRENT STATE (What's Built)

```
✅ packages/core/         — ATLASEngine, 6 providers, .quorum/ memory
✅ packages/mcp/          — 14 MCP tools
✅ packages/cli/          — quorum new / fast / next / pause / resume / doctor
✅ apps/quorum-server/     — API + Socket.IO + auth
✅ apps/quorum-web/        — Web terminal + dashboard
✅ apps/quorum-console/    — React Native mobile app (Expo)
✅ apps/telegram-bot/     — Basic bot (start/login/status/stop)
✅ agents/                — 14 agent .md files
⚠️  Phase 3–6 pipeline   — Agents exist but not fully wired end-to-end
❌ Collaboration layer    — Not started
❌ PM tool integrations   — Not started
❌ Cost optimizer         — Not started
❌ Multi-developer .quorum/ — Not started
```

---

## SECTION 2: MULTI-DEVELOPER COLLABORATION LAYER

### The Vision

Team chats in their tool (Teams/Slack/Discord/Telegram group).
They discuss a user story or task.
Someone calls @QUORUM or /quorum plan.
QUORUM reads the conversation, summarizes decisions, creates plan.md.
Posts an approval card — team members tap Approve/Reject.
Once approved by required members, QUORUM executes.
Posts progress back to the channel.

### New Package: packages/collaboration/

```
packages/collaboration/src/
  chat-ingester.ts      — reads conversation history from platform API
  summarizer.ts         — calls LLM to extract decisions from chat
  approval-manager.ts   — manages who needs to approve + tracks status
  plan-builder.ts       — creates plan.md + task.md from summary
  identity-mapper.ts    — maps Teams/Slack/Discord user → QUORUM user
```

### .quorum/ Schema Changes

```
.quorum/
  collaboration/
    chat-summaries/
      {ticket-id}-{date}.md      ← summarized discussion per ticket
    approvals/
      {plan-id}-approval.json    ← {status, required, approved_by, rejected_by}
    contributors.json            ← {name, platforms: {teams_id, slack_id, ...}, role}
    audit-trail.json             ← immutable log of every decision + who approved
```

### The Approval Flow (Low Level)

```
1. Trigger
   User says: "@QUORUM summarize and plan this"
   OR team has auto-trigger on keyword in message

2. Ingestion
   collaboration/chat-ingester.ts calls platform API
   Fetches last N messages in thread/channel
   Strips noise (reactions, file shares, off-topic)

3. Summarization
   LLM call with structured prompt:
     Input: raw messages
     Output: {decisions: [...], open_questions: [...], assigned_to: "...", context: "..."}
   Saves to .quorum/collaboration/chat-summaries/

4. Plan Creation
   plan-builder.ts maps decisions → plan.md sections
   Creates task.md with acceptance criteria extracted from discussion
   If linked to PM ticket (Jira/Azure/Linear): pulls acceptance criteria from ticket too

5. Approval Request
   Posts to channel:
   ┌─────────────────────────────────────────────┐
   │ QUORUM Plan Ready — User Auth Redesign        │
   │                                              │
   │ Summary: Replace JWT with session tokens.    │
   │ Switch from Postgres sessions to Redis.      │
   │ Affects: auth/, middleware/, 3 API routes    │
   │                                              │
   │ Requires approval: @Sarah @Ahmed             │
   │                                              │
   │  ✅ Approve    ❌ Reject    💬 Comment       │
   └─────────────────────────────────────────────┘

   In Teams: Adaptive Card with Action.Execute
   In Slack: Block Kit with button actions
   In Discord: Message components with buttons
   In Telegram: InlineKeyboardMarkup

6. Approval Tracking
   approval-manager.ts watches for button clicks
   Tracks: who approved, when, what role
   Configurable quorum: "all" / "majority" / "lead-only" / "any-one"
   Timeout: if no response in X hours → escalate or auto-cancel

7. Execution
   Once quorum reached:
   - Writes approval to .quorum/collaboration/approvals/{plan-id}-approval.json
   - Calls ATLASEngine.run() with plan
   - Posts progress updates back to channel
   - On completion: "✅ Done. PR #47 opened. 4 tests passing."
   - On failure: "❌ Blocked at Phase 3. [View error] [Retry] [Discuss]"

8. Conflict Handling
   If Rejected:
   - Posts rejection reason to channel
   - Conversation continues
   - User can call @QUORUM plan again after more discussion
   - audit-trail.json records both plans and why first was rejected
```

### Multi-Developer .quorum/ Sync

```
Problem: Two devs open same project, both write to decisions.json

Solution: Optimistic concurrency
  - Each write includes a version hash
  - quorum-server handles merge via WebSocket presence
  - Conflicts flagged in .quorum/conflicts.json (already in your schema)
  - Contributors.json tracks who owns what

Git strategy:
  - .quorum/nervous-system/ — merge with ours strategy (last writer wins)
  - .quorum/collaboration/audit-trail.json — append-only, no conflicts
  - .quorum/collaboration/approvals/ — immutable once written
```

---

## SECTION 3: UNIFIED BOT — apps/quorum-bot/

### Key Finding: Chat SDK

Vercel's Chat SDK is a TypeScript library that runs ONE bot on:
Slack, Microsoft Teams, Google Chat, Discord, Telegram, GitHub, Linear

Single codebase. Platform adapters handle differences.
This replaces building separate apps/telegram-bot, apps/teams-bot, etc.

```
apps/quorum-bot/
  src/
    index.ts              — Chat SDK setup, register all adapters
    handlers/
      plan.ts             — /quorum plan — summarize + create plan
      status.ts           — /quorum status — show current session
      approve.ts          — handle approval button clicks
      watch.ts            — /quorum watch — start ticket monitoring
      stop.ts             — /quorum stop — interrupt session
    adapters/
      teams.ts            — Teams-specific: Adaptive Cards format
      slack.ts            — Slack-specific: Block Kit format
      discord.ts          — Discord-specific: Message components
      telegram.ts         — Migrate existing telegram-bot here
    cards/
      approval-card.ts    — Platform-agnostic approval card builder
      progress-card.ts    — Build progress updates
      checkpoint-card.ts  — Human checkpoint request cards
```

### Microsoft Teams Specifically

Teams supports:
- Adaptive Cards with Action.Execute (approve/reject buttons)
- User-specific views — only the approver sees the Approve button
- Sequential workflows — multi-step approval chains
- Proactive messaging — QUORUM can message users without them initiating

This makes Teams the STRONGEST enterprise channel.
MNC IT teams already have Teams governance. QUORUM bot just needs admin consent.

Registration: Azure Bot Service → Teams App → admin installs in org tenant
Auth: OAuth 2.0 via Azure AD (same identity system MNCs already use)

### Telegram (Existing → Migrate)

Current apps/telegram-bot/ has basic bot.ts and api.ts.
Migrate to Chat SDK adapter — keeps existing functionality,
gains unified codebase with other platforms.

---

## SECTION 4: PM TOOL INTEGRATIONS (quorum watch)

### Adapter Architecture

```typescript
// packages/core/src/integrations/pm-adapter.ts
interface PMAdapter {
  name: string
  connect(config: PMConfig): Promise<void>
  watchForKeyword(keyword: string, cb: (ticket: Ticket) => void): void
  postComment(ticketId: string, message: string): Promise<void>
  updateStatus(ticketId: string, status: ATLASStatus): Promise<void>
  getTicket(ticketId: string): Promise<Ticket>
  getAcceptanceCriteria(ticketId: string): Promise<string[]>
}
```

### Supported Tools (Priority Order)

```
Tier 1 — Build First (highest enterprise coverage):
  azure-boards     ← Microsoft has official MCP Server for this (use it directly)
  jira             ← Atlassian REST API + webhooks
  github-issues    ← GitHub MCP Server (official, already in ecosystem)
  linear           ← Linear SDK (modern, webhook-native)

Tier 2 — Add Next:
  asana            ← REST API + webhooks
  monday           ← GraphQL API + webhooks
  clickup          ← REST API + webhooks
  notion           ← REST API (limited webhook support)

Tier 3 — Enterprise Specific:
  servicenow       ← ITSM for large corps, Table API
  shortcut         ← REST API
```

### The BA Trigger Flow (quorum watch command)

```bash
quorum watch --tool=jira --project=MYAPP --keyword="[QUORUM]" --channel=teams

# This starts a long-running watcher:
# 1. Polls/webhook-listens for tickets with [QUORUM] in title
# 2. When found: reads title + description + acceptance criteria
# 3. Runs quorum-classifier (SIMPLE vs COMPLEX)
# 4. Creates .quorum/plan.md + .quorum/task.md
# 5. Posts to Teams channel for approval
# 6. On approval: runs quorum fast or quorum new
# 7. Posts result back to Jira ticket as comment
# 8. Updates ticket status: "In Progress" → "In Review"
```

### Bidirectional Updates

When QUORUM finishes:
- Posts comment on ticket: "Built. PR #47 opened. 4/4 tests passing."
- Updates ticket status
- Links PR to ticket
- Saves ticket context to .quorum/nervous-system/decisions.json

---

## SECTION 5: COST OPTIMIZER

### Stage 1: Stack Selection (quorum cost-plan)

```
Trigger: quorum cost-plan
         OR automatically offered at quorum new ("Want cost guidance? y/n")

Questions asked:
  1. Budget: free / $X per month
  2. Project type: web app / API / mobile backend / data pipeline / other
  3. Team size: solo / 2-5 / 6-20 / 20+
  4. Expected users at launch: <100 / 100-1K / 1K-10K / 10K+
  5. Growth timeline: MVP only / 12 months / scaling play
  6. Data sensitivity: public / internal / regulated (HIPAA/GDPR)

Output: spec-driven recommendation covering:
  ┌─────────────────────────────────────────────────────┐
  │  Language & Framework  │  Reason                    │
  │  Database              │  Reason                    │
  │  Hosting               │  Reason + monthly cost     │
  │  Auth                  │  Reason                    │
  │  CI/CD                 │  Reason                    │
  │  Monitoring            │  Reason                    │
  │  CDN                   │  Reason                    │
  │  Storage               │  Reason                    │
  │  Total estimated cost  │  $X/mo at launch           │
  │  Upgrade trigger       │  When to move to next tier │
  └─────────────────────────────────────────────────────┘

For FREE budget, current best free tiers (March 2026):
  Hosting:    Render (web services sleep after 15min — fine for MVP)
              Cloudflare Workers (always on, generous free tier)
  Database:   Turso (SQLite, 9GB free) or Supabase (500MB Postgres)
  Auth:       Clerk (10K MAU free) or Auth.js (self-hosted)
  CI/CD:      GitHub Actions (2000 min/mo free)
  CDN:        Cloudflare (unlimited bandwidth free)
  Monitoring: Sentry (5K errors/mo free)
  Total:      $0/mo until you exceed free limits

Saves to: .quorum/nervous-system/stack.json
Skip flag: if user skips, sets .quorum/cost-plan-pending: true
           quorum doctor warns about it on next run
```

### Stage 2: Scaling & Architecture Analyzer (quorum scale-plan)

```
Trigger: quorum scale-plan
         OR automatically offered at quorum new after cost-plan

For EXISTING projects:
  Reads .quorum/nervous-system/stack.json
  Asks:
    1. Current MAU and peak RPS (requests/second)?
    2. Biggest pain point (slow queries / high memory / slow cold starts)?
    3. Current deployment setup?

For NEW projects:
  Uses Stage 1 answers + asks:
    1. Expected user growth (flat / 2x/year / viral potential)?
    2. Traffic pattern (steady / bursty / batch)?

Output:
  ┌─────────────────────────────────────────────────────────────┐
  │  QUORUM SCALING ANALYSIS                                      │
  ├──────────┬─────────────────────┬────────────────────────────┤
  │  Users   │  Architecture       │  Monthly Cost              │
  ├──────────┼─────────────────────┼────────────────────────────┤
  │  < 1K    │  Single server      │  $25/mo — you're fine      │
  │  1K–5K   │  + Redis cache      │  $45/mo — add caching only │
  │  5K–25K  │  2 replicas + LB    │  $120/mo — horizontal scale│
  │  25K–100K│  K8s or ECS         │  $400/mo — managed cluster  │
  │  100K+   │  Full cloud (AWS)   │  $1500+/mo                 │
  ├──────────┴─────────────────────┴────────────────────────────┤
  │  Database Scaling Path:                                      │
  │  Now → read replica at 5K → PgBouncer at 25K → Citus 100K  │
  │                                                              │
  │  Docker Compose vs Kubernetes threshold:                     │
  │  K8s is overkill below 25K concurrent users or <4 services  │
  │  Use Docker Compose until you hit either limit              │
  │                                                              │
  │  Recommended next action: [specific command to run]         │
  └─────────────────────────────────────────────────────────────┘

Saves ADR to: .quorum/nervous-system/decisions.json
```

---

## SECTION 6: NEW COMMANDS TO BUILD

```
Command           What it does                          Priority
─────────────────────────────────────────────────────────────────
quorum watch       BA trigger — monitors PM tools for   HIGH
                  keyword, auto-creates plan + approval

quorum cost-plan   Stage 1 — stack selection by budget  HIGH

quorum scale-plan  Stage 2 — scaling/architecture       HIGH
                  analysis with cost tiers

quorum env         Manages .env files, validates vars,  MEDIUM
                  generates .env.example, detects
                  committed secrets

quorum security    OWASP top 10 scan, npm audit,        MEDIUM
                  dependency CVE check — enterprise gate

quorum monitor     Reads Sentry/Datadog logs, creates   MEDIUM
                  bug tasks in .quorum/ automatically

quorum deps        Dependency health — outdated,         LOW
                  vulnerabilities, license issues

quorum changelog   Git history + .quorum/actions.json    LOW
                  → human-readable CHANGELOG.md
```

---

## SECTION 7: NEW AGENTS TO ADD

```
Agent                   Role
──────────────────────────────────────────────────────────────────
quorum-ba-watcher        Monitors PM tools, reads acceptance
                        criteria, triggers classification

quorum-summarizer        Reads chat conversation history,
                        extracts decisions, creates plan.md

quorum-approver          Manages multi-platform approval
                        workflow, tracks quorum, escalates

quorum-cost-advisor      Interactive stack selection with
                        budget constraints

quorum-scale-advisor     Architecture analysis, scaling thresholds,
                        cost-per-tier modeling

quorum-security          OWASP + CVE + secrets scanner,
                        runs before quorum ship

quorum-env-manager       .env validation, .env.example generation,
                        secret detection in git
```

---

## SECTION 8: IMPLEMENTATION ORDER

### Phase A — Foundation (do before adding features)
```
1. Wire Phase 3-6 pipeline end-to-end (integration + testing + scaling)
   Without this, the product doesn't deliver its core promise.

2. Migrate telegram-bot to Chat SDK
   Sets up the unified bot infrastructure before adding Teams/Slack
```

### Phase B — Team Collaboration (3-4 weeks)
```
3. packages/collaboration/ — chat-ingester, summarizer, approval-manager
4. .quorum/ schema update — collaboration/ folder
5. apps/quorum-bot/ — unified bot with Teams + Slack + Discord + Telegram
6. Approval flow end-to-end — discuss → summarize → approve → execute
```

### Phase C — PM Tool Integration (2 weeks)
```
7. PM adapter interface + Azure Boards adapter (uses existing MCP server)
8. Jira adapter + GitHub Issues adapter
9. quorum watch command
10. Bidirectional ticket updates
```

### Phase D — Cost Intelligence (2 weeks)
```
11. quorum cost-plan command + quorum-cost-advisor agent
12. quorum scale-plan command + quorum-scale-advisor agent
13. Integration with quorum new (optional skip flow)
```

### Phase E — Enterprise Hardening (2 weeks)
```
14. quorum security command + quorum-security agent
15. quorum env command
16. Multi-developer .quorum/ sync via quorum-server
17. Identity mapping (Teams/Slack identity → QUORUM user)
```

---

## SECTION 9: THE DEMO THAT GOES VIRAL

```
1. Open Microsoft Teams
2. In a project channel, team discusses: "We need to rethink the auth flow"
3. After 10 messages, someone types: "@QUORUM plan this"
4. QUORUM posts an Adaptive Card in Teams:
   ┌─────────────────────────────────────────────────────┐
   │ QUORUM Plan Ready — Auth Redesign                     │
   │ Summary: Replace JWT with sessions. Use Redis.       │
   │ Affects: 3 files. Est. time: 45 min.                 │
   │  ✅ Approve    ❌ Reject                             │
   └─────────────────────────────────────────────────────┘
5. Tech lead taps Approve on their phone
6. QUORUM executes — streams progress to Teams
7. 40 minutes later: "✅ PR #47 opened. 4 tests passing. View PR →"
8. Jira ticket auto-updated: status → "In Review", PR linked

Total human time: 30 seconds.
```

This is the demo. It's not built anywhere else. Build this first.

---

## SECTION 10: WHAT MAKES THIS DIFFERENT

```
GitHub Copilot for Jira:  Jira → draft PR (one model, no memory, no pipeline)
Devin:                    Great but $500/mo, closed source, no team collab
OpenHands:                Open source but no team collaboration, no PM integration
MetaGPT:                  Pipeline exists but no persistence, no chat layer

QUORUM:
  ✓ Open source + self-hosted
  ✓ Works on your own API keys (any provider)
  ✓ Persistent .quorum/ memory committed to git
  ✓ Full 6-phase pipeline (not just a PR)
  ✓ Team chat → plan → approve → execute (nobody has this)
  ✓ Works from Teams, Slack, Discord, Telegram, mobile, web
  ✓ PM tool integration with bidirectional updates
  ✓ Cost intelligence built in
  ✓ Enterprise ready (Azure AD auth, Teams, Azure Boards)
```

---

*Plan created: March 2026*
*Next action: Wire Phase 3-6 pipeline end-to-end before adding new features*
