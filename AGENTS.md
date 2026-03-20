# ATLAS-CLAUDE — Agent Instructions

ATLAS (Autonomous Team for Large-scale Application Systems) is an orchestration and memory framework that coordinates 12 specialized agents to build complete applications autonomously from plain-English descriptions.

**Phase 1 MVP Status:** Classifier, Orchestrator, Backend Architect, Backend Validator, Critic, Nervous System, 4 Skills, 2 Commands

## Available Agents (Phase 1 + 2)

| Agent | Purpose | When to Use |
|-------|---------|-------------|
| atlas-orchestrator | Master coordinator for the full ATLAS pipeline | Called by `/atlas-new` and `/atlas-enhance` only |
| atlas-classifier | Detects project complexity (SIMPLE vs COMPLEX) | First step in every ATLAS run |
| atlas-critic | Evidence-only assumption interceptor | After every agent output, throughout pipeline |
| atlas-backend-architect | Designs complete backend before any code written | Phase 1 of complex projects |
| atlas-backend-validator | Challenges backend architecture in confidence loop | Loops with architect until 100% confidence |
| atlas-nervous-system | Maintains permanent project memory across sessions | End of every session, git hooks |
| atlas-design-architect | Designs frontend UI/UX with 4 visual variations | Phase 2 |
| atlas-design-validator | Confirms design is technically buildable | Loops with design architect until 100% |
| atlas-frontend-builder | Builds frontend from approved design (v0/Lovable/Claude) | Phase 3 — parallel with backend build |

## Upcoming Agents (Phase 3)

| Agent | Purpose | Phase |
|-------|---------|-------|
| atlas-integration | Connects frontend and backend API contracts | Phase 3 |
| atlas-testing | End-to-end browser testing with bug registry | Phase 3 |
| atlas-scaling | Cost and bottleneck analysis at different user scales | Phase 3 |

## Available Skills

| Skill | Purpose |
|-------|---------|
| `skills/atlas-project-memory/` | How to read/write `.atlas/` efficiently (99% cheaper navigation) |
| `skills/atlas-foundation-mode/` | Seeds `.atlas/` for new projects — runs once, never again |
| `skills/atlas-loop-prevention/` | Rules for all confidence loops (max rounds, escalation triggers) |
| `skills/atlas-plan-management/` | Surgical `plan.md` updates + interrupt queue processing |
| `skills/atlas-function-registry/` | Function registry schema + navigation protocol |

## Available Commands

| Command | Purpose |
|---------|---------|
| `/atlas-new` | Start new feature or application from scratch |
| `/atlas-enhance` | Modify or extend an existing feature (reads context automatically) |
| `/atlas-status` | Check execution state, decisions, token usage |
| `/atlas-sync` | Force re-index project after manual changes outside ATLAS |

## How ATLAS Works

```
Human: /atlas-new "Build a SaaS for team project management"
  ↓
atlas-orchestrator reads .atlas/ (or runs Foundation Mode if new)
  ↓
atlas-classifier → COMPLEX
  ↓
Phase 1: atlas-backend-architect designs backend
         atlas-critic verifies claims
         atlas-backend-validator challenges in loop (max 3 rounds)
  ↓
CHECKPOINT A: Human approves architecture (~5 min)
  ↓
atlas-nervous-system saves all decisions, actions, ADRs
  ↓
Next session: Full context loaded automatically from .atlas/
```

## Core Principles

1. **Evidence-based** — atlas-critic blocks any claim without evidence source
2. **Memory-persistent** — `.atlas/` survives sessions, team changes, context resets
3. **Human checkpoints** — 3 approval gates, never proceeds without explicit OK
4. **Loop-bounded** — all confidence loops have max round limits
5. **Non-destructive** — all `.atlas/` writes are append-only; history never deleted

## Project Memory System

The `.atlas/` folder lives in every project using ATLAS (NOT in this repo).
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
