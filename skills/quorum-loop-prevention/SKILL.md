---
name: quorum-loop-prevention
description: Rules for all QUORUM confidence loops. Read before any agent enters a confidence loop with another agent. Extends loop-operator with QUORUM-specific escalation triggers, budgets, and hallucination prevention.
---

# Atlas Loop Prevention

## When to Use

Read before any agent enters a confidence loop with another agent.
All QUORUM loops use loop-operator as their base layer.

## Foundation

All loop-operator rules apply to every QUORUM loop.
This skill adds QUORUM-specific escalation triggers on top.

## QUORUM-Specific Escalation Triggers

Add these to loop-operator's standard escalation conditions:

Escalate immediately when:
```
1. Confidence delta < 5% across 2 consecutive rounds
   Meaning: agents are talking but not actually improving the design
   Signal: loop is stuck, not productive

2. Same specific challenge raised in consecutive rounds by Validator
   Meaning: Architect cannot or will not address this point
   Signal: requires external input to break the deadlock

3. Semantic similarity > 85% between consecutive rounds
   Meaning: different words, same argument, no new information
   Signal: spinning in place

4. Token budget for this loop phase at 90%
   Meaning: cost control — better to escalate than exhaust budget
   Signal: force resolution
```

When escalating:
```
NEVER surface as: "agents couldn't agree"
ALWAYS surface as: ONE specific question to human

Format:
  "QUORUM CONFIDENCE LOOP ESCALATION

  Architect and Validator have disagreed across [N] rounds on:
  [EXACT POINT OF DISAGREEMENT — one sentence]

  Architect's position: [position + reasoning]
  Validator's concern: [concern + reasoning]

  Both positions are evidence-based. Human judgment required.

  Question: [single question that resolves this]
  Option A: [choice] — consequence: [tradeoff]
  Option B: [choice] — consequence: [tradeoff]"
```

## Loop Budgets (QUORUM-specific)

```
Architect/Validator loop:
  Max rounds: 3
  Max tokens: 15,000 across all rounds combined

Design loop:
  Max rounds: 3
  Max tokens: 10,000 across all rounds combined

Bug fix loop (Testing → Builder):
  Max attempts per bug: 2
  Max tokens: 20,000 per bug

Integration negotiation:
  Max rounds: 2
  Max tokens: 10,000
```

## Hallucination Prevention in Loops

The fundamental problem: same AI model debating itself can converge
on a wrong answer because both instances share the same blind spots.

Mitigation:
`quorum-critic` runs alongside every loop.
After every round, Critic checks all new claims from both sides.
Claims flagged as UNVERIFIED cannot be used to resolve the loop.
Only VERIFIED claims count toward resolution.

This means: loop can only end when both sides are making
evidence-backed arguments. Not just confident-sounding ones.
