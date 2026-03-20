---
description: Return the project to a previous rollback point created by ATLAS. Lists available rollback points, confirms selection, then restores. Commits new restore point so rollback can itself be rolled back.
---

# /atlas-rollback

Return your project to a previous state that ATLAS saved automatically.

## Usage

```
/atlas-rollback
/atlas-rollback --list
/atlas-rollback --to rp_001_architecture_approved
```

## Rollback Points ATLAS Creates Automatically

| Point | Created when |
|-------|-------------|
| `rp_001_architecture_approved` | Human approves backend architecture at Checkpoint A |
| `rp_002_design_approved` | Human selects design option at Checkpoint B |
| `rp_003_build_complete` | Backend + frontend builds finish |
| `rp_004_integration_complete` | API contract mismatches resolved |
| `rp_005_testing_complete` | All tests pass + Checkpoint C approved |

## What Happens

**Without flags** — shows menu:
```
ATLAS ROLLBACK — Available Restore Points

  rp_001  Architecture approved  [timestamp]
  rp_002  Design selected        [timestamp]
  rp_003  Build complete         [timestamp]
  rp_004  Integration complete   [timestamp]
  rp_005  Testing complete       [timestamp]

Type: SELECT [rp_ID] or CANCEL
```

**On selection:**
1. Shows what will change:
   ```
   Rolling back to: rp_002 (Design selected)

   Files that will be restored: [N files changed since rp_002]
   .atlas/ state: restored to session [ID]
   Git commits since rp_002: [N commits]

   This is SAFE — a new rollback point will be created before restoring,
   so you can roll back the rollback if needed.

   Confirm? Type: YES / CANCEL
   ```
2. Creates new rollback point: `rp_[N]_pre_rollback_[timestamp]`
3. Restores files from the selected point
4. Restores `.atlas/` to the snapshot from that point
5. Updates `plan.md` to show rollback event

**Your work is never permanently lost.**
Every rollback creates a new restore point first.

## What Gets Restored

- All source code files from that point
- `.atlas/plan.md` state from that point
- `.atlas/nervous-system/` from that point

**NOT restored:**
- `.atlas/history_plan.md` — always append-only, never reverted
- `BUGS.md` — bugs found are always preserved, even through rollbacks
- `bug-registry.json` — bug knowledge is permanent

## Related Commands

- `/atlas-status` — see current state before deciding to rollback
- `/atlas-sync` — re-index after major manual changes instead of rolling back
