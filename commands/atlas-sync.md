---
description: Force re-index of entire project. Updates project-index.json and function-registry.json. Use after major manual changes outside ATLAS, after large merges, or when agents seem to not know about recent code changes.
---

# /atlas-sync

Force re-index the project so ATLAS agents have accurate knowledge of the current codebase.

## Usage

```
/atlas-sync
/atlas-sync --functions-only
/atlas-sync --report
```

## When to Use

- After manually editing code outside ATLAS (the index may be stale)
- After merging a large pull request with many changed files
- After major refactoring that moved files around
- When returning to a project after a long break
- When agents seem to not know about recent code changes

> **Note:** Incremental updates via git hooks handle routine changes automatically. Use `/atlas-sync` only when the index is genuinely stale.

## What It Does

1. Full scan of project file structure
2. Rebuilds `project-index.json` completely from scratch
3. Updates `function-registry.json`:
   - New functions added
   - Modified functions updated
   - Deleted functions marked (`deleted: true`)
   - `called_from` arrays reconciled
4. Detects deleted files and marks them in index
5. Updates `dependency-graph.json`
6. Updates `stack.json` if `package.json` changed

## Output

```
ATLAS SYNC COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━
Files added since last sync: [N] ([list])
Files modified: [N] ([list])
Files deleted: [N] ([list])
Functions added: [N]
Functions modified: [N]
Functions deleted: [N]
Duration: [seconds]
Status: COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Options

| Flag | What it does |
|------|-------------|
| `--functions-only` | Only rescan functions, skip file index rebuild |
| `--report` | Show what changed without updating (dry run) |

## Cost Note

Full sync reads every file in the project.
For large projects this may take a few minutes and use significant tokens.
The `--functions-only` flag is cheaper for targeted updates.
