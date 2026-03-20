---
description: Modify, extend, or fix something in an existing project using ATLAS. Reads full project context, makes targeted changes without running the full pipeline. Faster than /atlas-new for existing codebases.
---

# /atlas-enhance

Modify, extend, or fix something in an existing project — with full project context from `.atlas/`, no re-explanation required.

## Usage

```
/atlas-enhance [description of what to change or add]
```

## Examples

```
/atlas-enhance Add password reset to the existing auth system
/atlas-enhance Fix the N+1 query issue in the dashboard loading
/atlas-enhance Add CSV export to the reports module
/atlas-enhance The login flow is broken after the last session, fix it
/atlas-enhance Add rate limiting to all public API endpoints
```

## What Happens

1. Reads `.atlas/` for full project context (no re-explanation needed)
2. Reads `function-registry.json` to locate affected code precisely
3. Runs targeted architecture check (not full Phase 1) if structural change
4. Runs `atlas-critic` throughout for assumption prevention
5. Makes changes with full context of existing system
6. Tests affected flows specifically (not full regression)
7. Updates all `.atlas/` files with new knowledge

## Difference From /atlas-new

| | `/atlas-new` | `/atlas-enhance` |
|---|---|---|
| Use for | New features or projects | Existing features |
| Architecture phase | Full Phase 1 | Targeted check only |
| Design phase | Full Phase 2 | Skipped if not UI change |
| Testing | Full regression | Affected flows only |
| Context | Loaded or Foundation Mode | Always loaded from .atlas/ |

## When to Use Which

Use `/atlas-new` when:
- Building something that doesn't exist yet
- Adding a major new module or feature area
- Starting a new project from scratch

Use `/atlas-enhance` when:
- Fixing a bug
- Adding to an existing feature
- Refactoring existing code
- Making a configuration change
- Anything where the codebase already has context

## Mid-run Control

Type `/stop` to pause. ATLAS saves exact state.
Resume with: `/atlas-enhance continue current task`
Check state with: `/atlas-status`
