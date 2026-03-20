# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with the ATLAS framework.

## Project Overview

**ATLAS** (Autonomous Team for Large-scale Application Systems) is an orchestration and memory framework for autonomous multi-agent development. It coordinates 12 specialized agents that build complete applications autonomously from plain-English descriptions.

## Architecture

```
agents/          — 12 ATLAS specialized agents
skills/          — ATLAS skill files (workflow definitions)
commands/        — ATLAS slash commands (/atlas-new, /atlas-enhance, etc.)
```

## ATLAS — Autonomous Development Framework

ATLAS is the orchestration layer for autonomous multi-agent development.
Coordinates 12 new specialized agents to build complete applications autonomously.

### When to Use ATLAS

- Building a new feature or application from scratch: `/atlas-new`
- Modifying or extending existing feature: `/atlas-enhance`
- Check current execution state: `/atlas-status`
- Return to previous state: `/atlas-rollback`
- Re-index project after manual changes: `/atlas-sync`

### How ATLAS Works

```
Human types: /atlas-new "Build me a SaaS for restaurant management"
  ↓
ATLAS reads .atlas/ → classifies complexity → seeds project memory
  ↓
ATLAS calls agents in sequence → validates → gets human approval (5 min)
  ↓
Human sees: working application, full documentation
Human time spent: ~40 minutes total
```

### ATLAS Agent Pipeline

| Phase | Agents | Purpose |
|-------|--------|---------|
| Phase 0 | atlas-classifier | Detects SIMPLE vs COMPLEX |
| Phase 1 | atlas-backend-architect → atlas-backend-validator → atlas-critic | Backend architecture with validation loops |
| Phase 2 | atlas-design-architect → atlas-design-validator | Frontend design (Phase 2, future) |
| Phase 3 | atlas-frontend-builder | Build (Phase 2, future) |
| Phase 4 | atlas-integration | API handshake (Phase 3, future) |
| Phase 5 | atlas-testing | E2E testing (Phase 3, future) |
| Phase 6 | atlas-scaling | Cost analysis (Phase 3, future) |
| Always | atlas-nervous-system | Permanent project memory |

### ATLAS Project Memory

Every project using ATLAS has a `.atlas/` folder in its root.
This folder is committed to Git and maintains permanent project memory.
See `skills/atlas-project-memory/SKILL.md` for full documentation.

### ATLAS Model Configuration

Copy `atlas.config.json` to your project root and configure per agent.
Default: all Claude models. See Section 8 of the spec for all options.

### Human Checkpoints (3 Total)

- **Checkpoint A**: Approve backend architecture (~5 min)
- **Checkpoint B**: Pick frontend design (~5-10 min) — Phase 2
- **Checkpoint C**: Review test results (~15 min) — Phase 3

## Development Notes

- Agent format: Markdown with YAML frontmatter (name, description, tools, model)
- Skill format: Subdirectory with `SKILL.md` inside (e.g., `skills/atlas-project-memory/SKILL.md`)
- Command format: Markdown with `description` frontmatter
- `.atlas/` folder: Created at runtime inside user's projects — NOT in this repo

## File Naming

Lowercase with hyphens: `atlas-orchestrator.md`, `atlas-project-memory/`
