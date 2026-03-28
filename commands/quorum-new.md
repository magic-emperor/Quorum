---
description: Start a new feature or application from scratch using the QUORUM autonomous agent pipeline. Triggers complexity detection, foundation mode if needed, then Phase 1 architecture pipeline with human checkpoint.
---

# /quorum-new

Start a new feature or application using the full QUORUM autonomous agent pipeline.

## Usage

```
/quorum-new [description of what to build]
```

## Examples

```
/quorum-new Build a SaaS platform for restaurant management with real-time orders
/quorum-new Add a complete user authentication system with OAuth and 2FA
/quorum-new Create a notification system with email and in-app alerts
/quorum-new Build a simple portfolio website with contact form
```

## What Happens

1. `quorum-classifier` determines **SIMPLE** or **COMPLEX** from your description
2. **IF SIMPLE:** builds directly, minimal overhead, one quick review
3. **IF COMPLEX:** runs full pipeline
   - Foundation Mode if first time in this project (~10 min — never runs again)
   - Phase 1: Backend architecture proposed → **you approve** (~5 min)
   - Phase 2: Design options generated → you pick (future — Phase 2)
   - Phase 3: Backend + frontend built in parallel (future — Phase 2)
   - Phase 4: Connected and integrated (future — Phase 3)
   - Phase 5: Tested in real browser (future — Phase 3)
   - Phase 6: Cost and scaling analysis (optional, future — Phase 3)
4. You receive: working application + full documentation

## Your Total Time

| Project type | Time |
|---|---|
| Simple project | 5-10 minutes |
| Complex project (Phase 1 MVP) | ~20-30 minutes |
| Complex project (full pipeline, future) | ~40 minutes |

## Context Behavior

**First time in project** (no `.quorum/`):
  Foundation Mode activates. ~10 minute setup. Never runs again.

**Returning to existing project** (`.quorum/` exists):
  Picks up full context automatically. No re-explanation needed.

## What Gets Created

After a successful `/quorum-new` run, your project will have:

```
your-project/
  .quorum/
    plan.md                  ← Execution plan with full history
    history_plan.md          ← Immutable version archive
    DEVGUIDE.md              ← Architecture documentation
    BUGS.md                  ← Bug registry
    nervous-system/
      decisions.json         ← All architectural decisions + reasoning
      stack.json             ← Confirmed tech stack
      actions.json           ← All agent actions taken
      [... 8 more files]
    context/
      architecture-proposal.md  ← If complex: backend architecture
```

## Related Commands

- `/quorum-enhance` — modify existing features (faster, targeted)
- `/quorum-status` — see what's happening and cost report
- `/quorum-rollback` — return to a previous state

## How to Stop Mid-Run

Type `/stop` at any time. QUORUM will:
1. Complete the current atomic action (never mid-write)
2. Save exact state to `.quorum/plan.md`
3. You can resume with `/quorum-enhance continue current task`
