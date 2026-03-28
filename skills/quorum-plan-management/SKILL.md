---
name: quorum-plan-management
description: Rules for working with plan.md files, history_plan.md, and processing human interrupts during agent execution. Read when updating plan.md or processing the interrupt queue.
---

# Atlas Plan Management

## When to Use

Read this skill when working with `plan.md` files, `history_plan.md`,
or when processing human interrupts during agent execution.

## plan.md Structure

```markdown
# QUORUM Execution Plan
Project: [name]
Session: [ID]
Last updated: [timestamp]
Phase: [current phase]
Status: [IN_PROGRESS | BLOCKED | COMPLETE]

## Active Task
[One specific task being worked on right now]
Agent: [which agent is working on it]
Started: [timestamp]

## Completed Steps
- [x] [step] — [agent] — [session ID] — [timestamp]

## Current Steps
- [ ] [step] — [agent] working — started [timestamp]
- [ ] [step] — queued, waiting for above

## Upcoming Steps
- [ ] [step] — [planned for next]

## Human Checkpoints
- [x] CHECKPOINT A — Approved [timestamp]
- [ ] CHECKPOINT B — Pending

## Interrupt Queue Status
[clear | N items pending]

## Flags
[Any Orchestrator-noted items needing attention]
```

## Surgical Update Rules

ALWAYS surgical — never full rewrites:
1. Read current `plan.md` fully first
2. Find the SPECIFIC section that changed
3. Update ONLY that section and timestamp it
4. Never touch sections not affected by the change
5. Never remove Completed Steps — they are the record

NEVER:
- Rewrite the entire file because one thing changed
- Delete completed steps
- Start a new plan.md without archiving the current one

## history_plan.md — Append Format

```markdown
---
## plan.md v[N] | Session: [ID] | [ISO timestamp]
Created by: quorum-orchestrator
Agents used this session:
  quorum-orchestrator (claude-opus-4-6)
  quorum-backend-architect (claude-sonnet-4-6)
  [... complete list with models]
Status when archived: [COMPLETED | IN_PROGRESS | INTERRUPTED]
Archived because: [session ended | direction change | human request]

### What was planned:
[Upcoming Steps from plan.md at creation]

### What was completed:
[Completed Steps at archiving]

### What was in progress:
[Current Steps at archiving]

### Not started:
[Remaining Upcoming Steps]

### Session notes:
[Any important context — decisions made, blockers hit, human feedback]
---
```

## Interrupt Queue Processing

`interrupt-queue.json` structure:
```json
{
  "queue": [
    {
      "id": "int_[timestamp]",
      "received_at": "[ISO timestamp]",
      "content": "[exact human input — do not paraphrase]",
      "status": "pending | processing | resolved",
      "classification": null,
      "impact_assessment": null,
      "resolution": null
    }
  ]
}
```

Processing each interrupt at checkpoint:

**Step 1:** Read the interrupt content exactly as typed

**Step 2:** Classify:
```
CORRECTION:      Human fixing a specific implementation detail
                 Example: "use SendGrid not nodemailer"
                 → Update plan surgically, continue

ADDITION:        Human adding a new requirement
                 Example: "also add export to CSV"
                 → Add to Upcoming Steps, continue

DIRECTION_CHANGE: Human changing approach
                 Example: "actually let's use GraphQL instead of REST"
                 → Pause, assess impact, confirm with human before continuing

MAJOR_FLAW:      Human found a critical problem
                 Example: "we can't use OAuth here, we need SAML"
                 → STOP execution, surface diagnosis, wait for human

QUESTION:        Human asking something (not changing anything)
                 Example: "why did you choose Redis?"
                 → Answer in next output, continue execution
```

**Step 3:** Impact assessment against plan.md:
```
Which upcoming steps are affected? [list]
Which steps are NOT affected? [list]
Can execution continue or must it stop? [yes/no with reason]
```

**Step 4:** Update plan.md surgically:
```
- Update ONLY affected upcoming steps
- Add: "Updated: [timestamp] based on human input [int_ID]"
- Do not touch completed steps
- Do not rewrite unaffected steps
```

**Step 5:** Mark interrupt resolved in queue with classification, impact, and resolution.

## Hard Stop Protocol (/stop command)

When human types `/stop`:
```
1. Current agent completes its current atomic action (never mid-write)
2. Orchestrator saves state to plan.md:
   Current step: "INTERRUPTED at [step] — [timestamp]"
   Note: "Resume with /quorum-enhance [continue current task]"
3. Archive current plan.md to history_plan.md
4. State is clean. Files are not corrupted.
```
