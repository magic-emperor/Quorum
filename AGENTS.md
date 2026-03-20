# ATLAS-CLAUDE — Agent Instructions

ATLAS (Autonomous Team for Large-scale Application Systems) is an orchestration and memory framework that coordinates 12 specialized agents to build complete applications autonomously from plain-English descriptions.

**Phase 1 MVP Status:** Classifier, Orchestrator, Backend Architect, Backend Validator, Critic, Nervous System, 4 Skills, 2 Commands

## Available Agents (All 12)

| Agent | Purpose | Phase |
|-------|---------|-------|
| atlas-orchestrator | Master coordinator — routes work, manages checkpoints | All |
| atlas-classifier | Detects SIMPLE vs COMPLEX | Phase 0 |
| atlas-nervous-system | Permanent project memory across sessions | All |
| atlas-critic | Evidence-only assumption interceptor | All |
| atlas-backend-architect | Designs complete backend before any code written | Phase 1 |
| atlas-backend-validator | Challenges backend in confidence loop until 100% | Phase 1 |
| atlas-design-architect | Designs frontend with 4 visual variations + v0 prompts | Phase 2 |
| atlas-design-validator | Validates design is technically buildable | Phase 2 |
| atlas-frontend-builder | Builds frontend from approved design | Phase 3 |
| atlas-integration | Reconciles frontend/backend API contract mismatches | Phase 4 |
| atlas-testing | E2E testing, bug registry, 80% coverage gate | Phase 5 |
| atlas-scaling | Cost projections + bottleneck analysis at 1K/10K/100K/1M users | Phase 6 |

## Available Skills

| Skill | Purpose |
|-------|---------|
| `skills/atlas-project-memory/` | How to read/write .atlas/ efficiently |
| `skills/atlas-foundation-mode/` | Seed .atlas/ for new projects |
| `skills/atlas-loop-prevention/` | Rules for all confidence loops |
| `skills/atlas-plan-management/` | Surgical plan.md updates, interrupt processing |

## Available Commands

| Command | Purpose |
|---------|---------|
| `/atlas-new` | Start new feature or application from scratch |
| `/atlas-status` | Check execution state, decisions, token usage |

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
