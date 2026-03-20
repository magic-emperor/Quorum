---
name: atlas-foundation-mode
description: Activates when .atlas/ does not exist or decisions.json is empty. Seeds the Nervous System BEFORE agents start working, so the Critic has evidence and loops can resolve. Read this before starting any brand new project.
---

# Atlas Foundation Mode

## When to Use

Activates when `.atlas/` does not exist or `decisions.json` is empty.
Read this before starting any brand new project.

## The Problem This Solves

New project → no `decisions.json` → Critic blocks everything
→ nothing gets built → loop forever.

Foundation Mode seeds the Nervous System BEFORE agents start working.
Critic then has evidence. Loops resolve. Building proceeds.

## Step 1: Read Everything Before Asking Anything

Attempt to read (skip if not found):
```
package.json / requirements.txt / go.mod
README.md
Folder structure (glob **)
.env.example
Any existing documentation
```

For brand new project with zero files:
Extract from human's description:
- Who are the users? (role inference)
- What do they do? (action inference)
- What gets stored? (entity inference)
- How many users expected? (scale inference)
- Any technologies mentioned explicitly?

## Step 2: Form Proposals, Not Questions

For everything inferrable: propose it with explicit reasoning.
For genuine unknowns: ask ONE targeted question.

Proposal format:
```
ATLAS FOUNDATION ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━

Based on your description, here is what I've determined:

APPLICATION TYPE: [type] — because [evidence from description]

PROPOSED TECH STACK:
  Backend: [choice] — because [specific reason from description clues]
  Frontend: [choice] — because [specific reason]
  Database: [choice] — because [specific reason — what data structure requires this]
  Auth: [choice] — because [user roles and security needs]
  Deployment: [choice] — because [scale and infrastructure clues]

USER ROLES IDENTIFIED: [list extracted from description]

CORE ENTITIES IDENTIFIED: [list extracted from description]

COMPLEXITY: [SIMPLE | COMPLEX] — because [deciding factor]

[IF any items could not be determined:]
ONE QUESTION I NEED ANSWERED:
  [The single most architecturally impactful unknown]
  Why this matters: [consequence of different answers]
  Options: A) [option] B) [option]

Does this match your vision? Type APPROVE or tell me what to change.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Question Validity Filter

Before asking any question:
Test: "Does the answer to this change what gets built?"
YES → ask it (maximum 3 questions total)
NO → decide it yourself, log the decision with reasoning

Questions to NEVER ask (agent decides these):
- "Which database?" (decide from data model needs)
- "What folder structure?" (follow existing conventions or standard for framework)
- "What color scheme?" (Design Architect handles this)
- "Which package manager?" (detect from files or default to npm)
- "REST or GraphQL?" (decide from API complexity)

## Step 3: Seed the Nervous System

After human confirms the foundation proposal:
```
Create folder: .atlas/
Create folder: .atlas/nervous-system/
Create folder: .atlas/index/
Create folder: .atlas/context/
Create folder: .atlas/rollback_points/

Write: .atlas/nervous-system/stack.json
  {confirmed tech stack from approved proposal}

Write: .atlas/nervous-system/decisions.json
  [one ADR entry per major tech decision made in foundation]

Write: .atlas/nervous-system/open-questions.json
  [any items not resolved in foundation — tracking them]

Create empty files with headers:
  .atlas/nervous-system/actions.json     → []
  .atlas/nervous-system/reasoning.json   → []
  .atlas/nervous-system/function-registry.json → []
  .atlas/nervous-system/bug-registry.json → []
  .atlas/nervous-system/env-registry.json → []
  .atlas/nervous-system/test-coverage.json → {}
  .atlas/nervous-system/cached-instincts.json → []

Write: .atlas/plan.md
  [Phase 0 marked COMPLETE, Phase 1 as next step]

Write: .atlas/history_plan.md
  [Foundation Mode session archived as v1]

Write: .atlas/BUGS.md
  [Header only: # BUGS — Project: [name] — Maintained by: atlas-testing]

Write: .atlas/DEVGUIDE.md
  [Skeleton: project name, description, tech stack table from stack.json]

Create: .atlas/interrupt-queue.json
  {"queue": []}
```

## Step 4: Exit Foundation Mode

Output:
```
FOUNDATION MODE COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━
.atlas/ created and seeded.
Tech stack confirmed: [summary]
[N] initial decisions recorded.
Critic Agent now has evidence to work with.

Proceeding to [Phase 1 | Phase 3 (simple project)]
━━━━━━━━━━━━━━━━━━━━━━━━
```

Log to `history_plan.md` under plan.md v1.
