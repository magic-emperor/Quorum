---
description: Modify, extend, or fix something in an existing project using QUORUM. Reads full project context, makes targeted changes without running the full pipeline. Faster than /quorum-new for existing codebases.
---

# /quorum-enhance

Modify, extend, or fix something in an existing project — with full project context from `.quorum/`, no re-explanation required.

## Usage

```
/quorum-enhance [description of what to change or add]
```

## Examples

```
/quorum-enhance Add password reset to the existing auth system
/quorum-enhance Fix the N+1 query issue in the dashboard loading
/quorum-enhance Add CSV export to the reports module
/quorum-enhance The login flow is broken after the last session, fix it
/quorum-enhance Add rate limiting to all public API endpoints
```

## What Happens

1. Reads `.quorum/` for full project context (no re-explanation needed)
2. Reads `function-registry.json` to locate affected code precisely
3. Runs targeted architecture check (not full Phase 1) if structural change
4. Runs `quorum-critic` throughout for assumption prevention
5. Makes changes with full context of existing system
6. Tests affected flows specifically (not full regression)
7. Updates all `.quorum/` files with new knowledge

## Difference From /quorum-new

| | `/quorum-new` | `/quorum-enhance` |
|---|---|---|
| Use for | New features or projects | Existing features |
| Architecture phase | Full Phase 1 | Targeted check only |
| Design phase | Full Phase 2 | Skipped if not UI change |
| Testing | Full regression | Affected flows only |
| Context | Loaded or Foundation Mode | Always loaded from .quorum/ |

## When to Use Which

Use `/quorum-new` when:
- Building something that doesn't exist yet
- Adding a major new module or feature area
- Starting a new project from scratch

Use `/quorum-enhance` when:
- Fixing a bug
- Adding to an existing feature
- Refactoring existing code
- Making a configuration change
- Anything where the codebase already has context

## Mid-run Control

Type `/stop` to pause. QUORUM saves exact state.
Resume with: `/quorum-enhance continue current task`
Check state with: `/quorum-status`
