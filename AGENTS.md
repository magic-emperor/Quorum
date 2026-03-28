# QUORUM-CLAUDE — Agent Instructions

QUORUM (Autonomous Team for Large-scale Application Systems) is an orchestration and memory framework that coordinates 12 specialized agents to build complete applications autonomously from plain-English descriptions.

**Phase 1 MVP Status:** Classifier, Orchestrator, Backend Architect, Backend Validator, Critic, Nervous System, 4 Skills, 2 Commands

## Available Agents (Phase 1 + 2)

| Agent | Purpose | When to Use |
|-------|---------|-------------|
| quorum-orchestrator | Master coordinator for the full QUORUM pipeline | Called by `/quorum-new` and `/quorum-enhance` only |
| quorum-classifier | Detects project complexity (SIMPLE vs COMPLEX) | First step in every QUORUM run |
| quorum-critic | Evidence-only assumption interceptor | After every agent output, throughout pipeline |
| quorum-backend-architect | Designs complete backend before any code written | Phase 1 of complex projects |
| quorum-backend-validator | Challenges backend architecture in confidence loop | Loops with architect until 100% confidence |
| quorum-nervous-system | Maintains permanent project memory across sessions | End of every session, git hooks |
| quorum-design-architect | Designs frontend UI/UX with 4 visual variations | Phase 2 |
| quorum-design-validator | Confirms design is technically buildable | Loops with design architect until 100% |
| quorum-frontend-builder | Builds frontend from approved design (v0/Lovable/Claude) | Phase 3 — parallel with backend build |

## Upcoming Agents (Phase 3)

| Agent | Purpose | Phase |
|-------|---------|-------|
| quorum-integration | Connects frontend and backend API contracts | Phase 3 |
| quorum-testing | End-to-end browser testing with bug registry | Phase 3 |
| quorum-scaling | Cost and bottleneck analysis at different user scales | Phase 3 |

## Available Skills

| Skill | Purpose |
|-------|---------|
| `skills/quorum-project-memory/` | How to read/write `.quorum/` efficiently (99% cheaper navigation) |
| `skills/quorum-foundation-mode/` | Seeds `.quorum/` for new projects — runs once, never again |
| `skills/quorum-loop-prevention/` | Rules for all confidence loops (max rounds, escalation triggers) |
| `skills/quorum-plan-management/` | Surgical `plan.md` updates + interrupt queue processing |
| `skills/quorum-function-registry/` | Function registry schema + navigation protocol |

## Available Commands

| Command | Purpose |
|---------|---------|
| `/quorum-new` | Start new feature or application from scratch |
| `/quorum-enhance` | Modify or extend an existing feature (reads context automatically) |
| `/quorum-status` | Check execution state, decisions, token usage |
| `/quorum-sync` | Force re-index project after manual changes outside QUORUM |

## How QUORUM Works

```
Human: /quorum-new "Build a SaaS for team project management"
  ↓
quorum-orchestrator reads .quorum/ (or runs Foundation Mode if new)
  ↓
quorum-classifier → COMPLEX
  ↓
Phase 1: quorum-backend-architect designs backend
         quorum-critic verifies claims
         quorum-backend-validator challenges in loop (max 3 rounds)
  ↓
CHECKPOINT A: Human approves architecture (~5 min)
  ↓
quorum-nervous-system saves all decisions, actions, ADRs
  ↓
Next session: Full context loaded automatically from .quorum/
```

## Core Principles

1. **Evidence-based** — quorum-critic blocks any claim without evidence source
2. **Memory-persistent** — `.quorum/` survives sessions, team changes, context resets
3. **Human checkpoints** — 3 approval gates, never proceeds without explicit OK
4. **Loop-bounded** — all confidence loops have max round limits
5. **Non-destructive** — all `.quorum/` writes are append-only; history never deleted

## Project Memory System

The `.quorum/` folder lives in every project using QUORUM (NOT in this repo).
It is created at runtime and committed to the project's Git.

10 categories stored:
- `decisions.json` — every architectural decision + reasoning
- `actions.json` — every agent action + outcome
- `reasoning.json` — full thought processes
- `open-questions.json` — unresolved items
- `conflicts.json` — direction changes
- `function-registry.json` — every function/class mapped
- `bug-registry.json` — bug patterns for prevention
- `env-registry.json` — all environment variables
- `cached-instincts.json` — team preferences (from observer system)
- `test-coverage.json` — test status and gaps
