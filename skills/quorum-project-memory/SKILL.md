---
name: quorum-project-memory
description: Complete guide to reading and writing the .quorum/ project memory system. Read this skill whenever working with any .quorum/ folder, or when any agent needs to understand how to read or write project memory.
---

# Atlas Project Memory

## When to Use

Read this skill whenever working with any `.quorum/` folder, or when any agent
needs to understand how to read or write project memory.

## The Core Principle

Agents should NEVER read the entire codebase.
The project index and function registry exist to make codebase navigation
99% cheaper. Use them.

## Reading Protocol for Agents

To find relevant files for a task:
```
Step 1: Read .quorum/index/project-index.json
Step 2: Filter by relevant tags or module names
Step 3: Read ONLY the returned files
Step 4: If a file imports something relevant, add that import to read queue
Step 5: Maximum working set: 8 files simultaneously
```

To find a specific function:
```
Read .quorum/nervous-system/function-registry.json
Filter by: name | file | tags | purpose keywords
Result: file path + line_start
Read: only that file starting from line_start
```

To find all callers of a function:
```
Read function registry entry
Read called_from array
Each entry: file, line, calling function
Go directly to those locations — no search needed
```

## Writing Protocol for Agents

All nervous-system files are APPEND ONLY:
`decisions.json`, `actions.json`, `reasoning.json`,
`open-questions.json`, `bug-registry.json`

NEVER delete entries. NEVER modify past entries.
If something was wrong: add a conflict entry explaining the override.
The history is the value.

## The 10 Categories

```
Cat 1 — decisions.json:      Every decision + reasoning + alternatives rejected
Cat 2 — actions.json:        Every agent action + outcome + timestamp
Cat 3 — reasoning.json:      Full thought processes, not just conclusions
Cat 4 — open-questions.json: Unresolved items, tracked until closed
Cat 5 — conflicts.json:      Direction changes and overrides with impact
Cat 6 — function-registry:   Every function/class mapped with full metadata
Cat 7 — bug-registry.json:   Bug patterns for Critic to prevent recurrence
Cat 8 — env-registry.json:   All environment variables with purpose + usage
Cat 9 — cached-instincts:    High-confidence preferences from observer system
Cat 10 — test-coverage.json: What's tested, gaps, last test date
```

## Complete .quorum/ Folder Structure

```
your-project/
├── .quorum/
│   ├── plan.md                        ← ACTIVE execution plan (global)
│   ├── history_plan.md                ← IMMUTABLE version history
│   ├── BUGS.md                        ← All bugs ever found
│   ├── DEVGUIDE.md                    ← Living architecture doc for humans
│   ├── interrupt-queue.json           ← Human inputs mid-execution
│   │
│   ├── nervous-system/
│   │   ├── decisions.json             ← Cat 1: All decisions + ADRs
│   │   ├── actions.json               ← Cat 2: All agent actions taken
│   │   ├── reasoning.json             ← Cat 3: Full thought processes
│   │   ├── open-questions.json        ← Cat 4: Unresolved items
│   │   ├── conflicts.json             ← Cat 5: Direction changes
│   │   ├── function-registry.json     ← Cat 6: Every function/class mapped
│   │   ├── bug-registry.json          ← Cat 7: Bug patterns for Critic
│   │   ├── env-registry.json          ← Cat 8: All env variables
│   │   ├── stack.json                 ← Tech stack decisions
│   │   └── test-coverage.json         ← Cat 10: Test coverage state
│   │
│   ├── index/
│   │   ├── project-index.json         ← File map (auto-updated)
│   │   └── dependency-graph.json      ← How files connect
│   │
│   ├── context/
│   │   ├── session-current.json       ← Active session memory
│   │   ├── sessions/                  ← Past session archives
│   │   └── budget-log.json            ← Token usage tracking
│   │
│   └── rollback_points/               ← Full state snapshots
```

Note: `.quorum/` is created at runtime inside user's projects.
It is committed to Git. It does NOT live in the QUORUM-CLAUDE repo itself.

## Human Preferences (Category 9) — Important Note

Category 9 is NOT a file QUORUM creates independently.
The observer/instincts system already maintains this.
`quorum-nervous-system`:
  - Reads from `~/.claude/homunculus/projects/<hash>/instincts/`
  - Caches high-confidence instincts to `.quorum/nervous-system/cached-instincts.json`
  - Writes human corrections as observation entries for observer to process
  - Never duplicates the instincts system — bridges to it

## history_plan.md Rules

This file is SACRED and IMMUTABLE.
Only append. Never modify existing entries.
Every plan.md version is preserved here forever.
If you are tempted to edit an existing entry: DON'T. Add a new one.
