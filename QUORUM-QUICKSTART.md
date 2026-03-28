# QUORUM Quickstart Guide

Get from zero to your first autonomous build in under 5 minutes.

---

## Step 1: Install

```bash
git clone https://github.com/magic-emperor/QUORUM-CLAUDE.git
```

Open your Claude Code project. Copy the config template to your project root:

```bash
cp QUORUM-CLAUDE/quorum.config.json.template /your/project/quorum.config.json
```

That's it. No npm install. No build step. QUORUM is markdown files that Claude Code reads.

---

## Step 2: Your First Command

Open your project in Claude Code and type:

```
/quorum-new "Build a todo API with user authentication"
```

### What you'll see (new project):

```
QUORUM FOUNDATION ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━

Based on your description, here is what I've determined:

APPLICATION TYPE: REST API — because no UI mentioned, "API" explicit

PROPOSED TECH STACK:
  Backend:   Node.js + Express — straightforward REST API
  Database:  PostgreSQL — relational (users + todos with relationships)
  Auth:      JWT with refresh tokens — user authentication required
  Deployment: Railway or Render — simple, no infra overhead

USER ROLES IDENTIFIED: authenticated user
CORE ENTITIES IDENTIFIED: User, Todo

COMPLEXITY: SIMPLE — single user type, CRUD only, no real-time, no payments

Does this match your vision? Type APPROVE or tell me what to change.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Type `APPROVE` — QUORUM builds directly (SIMPLE project, skips architecture review).

---

## Step 3: For Complex Projects

```
/quorum-new "Build a SaaS for team project management with roles, billing, and real-time updates"
```

QUORUM classifies this as **COMPLEX** and runs the full pipeline:

### Checkpoint A (~5 min)

```
QUORUM CHECKPOINT A — Backend Architecture

What we designed:
- 6 database tables: users, teams, projects, tasks, roles, subscriptions
- 18 API endpoints with auth and role-based access control
- Stripe integration for billing
- WebSocket support for real-time task updates
- JWT auth with refresh token rotation

Key decisions:
- PostgreSQL: relational data with team membership (source: your description)
- Stripe: billing platform (source: "billing" in description)
- WebSocket: real-time requirement explicit in description

Full document: .quorum/context/architecture-proposal.md

Type: APPROVE / or tell me what to change
```

Review `.quorum/context/architecture-proposal.md` if you want full detail. Type `APPROVE`.

### Checkpoint B (~5-10 min)

```
QUORUM CHECKPOINT B — Frontend Design

Here are your design options:

OPTION 1: Executive Dark
  Mood: Premium B2B dashboard
  Colors: #0A0F1E background, #5865F2 accent
  Layout: Sidebar nav, dense data tables, subtle glass cards

OPTION 2: Clean Professional  
  Mood: Enterprise SaaS (Notion/Linear-inspired)
  Colors: #FFFFFF background, #6366F1 accent
  Layout: Top nav, spacious layout, card-based content

OPTION 3: Warm Focused
  Mood: Productivity tool, human-centered
  Colors: #FAFAF8 background, #E8632A accent
  Layout: Sidebar, comfortable spacing, warm typography

OPTION 4: Bold Modern
  Mood: High-contrast, developer-adjacent
  Colors: #111827 background, #10B981 accent
  Layout: Minimal chrome, maximum content, code-friendly

Type: SELECT [1/2/3/4] or describe changes
```

Type `SELECT 2`. Checkpoint B done.

### Checkpoint C (~15 min)

After build, integration, and testing:

```
QUORUM CHECKPOINT C — Testing Complete

Unit tests:  47 passed / 0 failed
E2E flows:   8 passed / 1 failed (fixed automatically)
Coverage:    84% overall

Bugs found: 2 | Fixed: 2 | Deferred: 0

Type APPROVE to complete
```

Review `.quorum/BUGS.md` if you want detail. Type `APPROVE`. Done.

---

## Step 4: Second Session (Magic Happens Here)

Next day. New Claude Code session. All context gone from Claude's memory.

```
/quorum-enhance "Add CSV export to the reports module"
```

QUORUM reads `.quorum/` — loads full context automatically:
- Stack confirmed: Next.js + PostgreSQL + Stripe
- 7 decisions from last session loaded
- Function registry: `generateReport()` found at `src/reports/generator.ts:42`
- Bug registry: checks if similar export bug exists (it does — prevents it)

No re-explanation. Full context. Starts working immediately.

---

## Key Files After First Session

```
your-project/
├── .quorum/
│   ├── plan.md                  ← what was built, what's next
│   ├── DEVGUIDE.md              ← architecture docs (auto-maintained)
│   ├── BUGS.md                  ← all bugs found + fixes
│   └── nervous-system/
│       ├── decisions.json       ← every decision + reasoning
│       ├── function-registry.json  ← every function mapped
│       └── stack.json           ← confirmed tech stack
├── src/                         ← your actual application
└── quorum.config.json            ← your QUORUM configuration
```

Commit `.quorum/` to Git. It's part of your project history.

---

## Common Questions

**Can I stop mid-build?**
Yes. Type `/stop` at any time. QUORUM saves exact state. Resume with:
```
/quorum-enhance continue current task
```

**Can I skip phases?**
Yes. For simple changes use `/quorum-enhance` (skips architecture + design phases).
To skip scaling analysis: set `"prompt_scaling_phase_6": false` in `quorum.config.json`.

**What if an agent makes a wrong decision?**
Type your correction during any checkpoint. QUORUM classifies it and updates the plan.
Or use `/quorum-rollback` to return to any previous checkpoint.

**Does this replace my existing Claude Code agents?**
No. QUORUM calls them. `planner`, `architect`, `tdd-guide`, `e2e-runner`, `security-reviewer`
all still work exactly as before. QUORUM adds orchestration and memory on top.

**What does it cost?**
Roughly $50–80/month (solo, starter tier, one complex project per week).
The function registry reduces codebase-reading tokens by ~99%.

---

## All Commands

```
/quorum-new "description"        Start new feature or project
/quorum-enhance "change"         Modify existing feature (reads context automatically)
/quorum-status                   Current phase, decisions, token cost
/quorum-rollback                 Return to previous checkpoint
/quorum-sync                     Re-index after manual code changes
```
