---
description: Shows current QUORUM execution state, recent decisions, open questions, and token usage with cost estimate. Use at any time during or after an QUORUM session.
---

# /quorum-status

Check what QUORUM is doing, what decisions were made, and your token spend.

## Usage

```
/quorum-status
/quorum-status --costs
/quorum-status --decisions
/quorum-status --plan
/quorum-status --bugs
```

## What It Shows (default)

```
Current phase: [phase name and description]
Active agent: [which agent is working and on what]
Session progress: [N of N phases complete]

Recent decisions (last 5):
  [decision summary + session ID]

Open questions (from open-questions.json):
  [unresolved items that need human attention]

Token usage this session:
  Phase 1 (architecture): [N] tokens — $[cost]
  Session total: [N] tokens — $[cost]
  Projected to completion: ~$[estimate]

Loops this session:
  [any confidence loops that ran, how many rounds, how resolved]

Interrupt queue: [clear | N items pending]
```

## Options

| Flag | What it shows |
|------|--------------|
| `--costs` | Detailed token breakdown by agent and phase |
| `--decisions` | All decisions made this session with full reasoning |
| `--plan` | Current `.quorum/plan.md` contents formatted for reading |
| `--bugs` | Contents of `.quorum/BUGS.md` for this project |

## How This Works

Reads directly from your project's `.quorum/` folder:
- `plan.md` → current execution state
- `nervous-system/decisions.json` → recent decisions
- `nervous-system/open-questions.json` → unresolved questions
- `context/budget-log.json` → token usage per phase

No agents are invoked. This is a read-only status check.

## Example Output

```
QUORUM STATUS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Project: Restaurant Management SaaS
Phase: 1 — Backend Architecture
Status: WAITING FOR HUMAN APPROVAL

What's done:
  ✅ Complexity classified: COMPLEX
  ✅ Foundation Mode: .quorum/ created
  ✅ Backend architecture designed (15 endpoints, 6 entities)
  ✅ Critic review: 12 verified, 2 unverified (minor)
  ✅ Validator signed off: 100% confidence

Waiting for you:
  CHECKPOINT A — Backend architecture ready for your review
  Full doc: .quorum/context/architecture-proposal.md
  Type APPROVE or describe changes

Recent decisions:
  d_s1_001: Use PostgreSQL (evidence: scale requirements + relational data)
  d_s1_002: JWT auth with refresh tokens (evidence: multi-role requirement)
  d_s1_003: REST API (evidence: simple client-server, no real-time needed)

Open questions: none

Token usage:
  Phase 0 (foundation): 3,200 tokens — $0.002
  Phase 1 (architecture): 18,400 tokens — $0.012
  Session total: 21,600 tokens — $0.014
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
