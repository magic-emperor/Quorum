# Qorum — Phase Plans

Detailed, self-contained execution plans. Each `phase-NN-*.md` is written so an executor
(human or agent) can read **one file** and build that phase without re-deriving context.

**Master plan:** `C:\Users\Faiza\.claude\plans\i-have-many-things-prancy-bear.md`
(big picture, decisions, code audit, end-to-end workflow). Read it once before starting.

## Reading order (dependencies run top-down)

| Phase | File | Goal | Depends on |
|------:|------|------|------------|
| 0 | [phase-00-consolidation.md](phase-00-consolidation.md) | One `qorum` package; rename ATLAS→Qorum; lock stack | — |
| 1 | [phase-01-foundation-hardening.md](phase-01-foundation-hardening.md) | Fix bugs B1–B12; make the existing flow correct | 0 |
| 2 | [phase-02-provider-agnostic-ai.md](phase-02-provider-agnostic-ai.md) | Any API key works (8 providers, per-role tiers) | 1 |
| 3 | [phase-03-tool-agent-harness.md](phase-03-tool-agent-harness.md) | Qorum-native tools + agent harness (the leveler) | 2 |
| 4 | [phase-04-bot-core-telegram.md](phase-04-bot-core-telegram.md) | Bot event model + Telegram dev harness | 1 |
| 5 | [phase-05-chat-ingestion-boundary.md](phase-05-chat-ingestion-boundary.md) | Chat boundary engine + summarizer | 4, 2 |
| 6 | [phase-06-classifier-locator.md](phase-06-classifier-locator.md) | Classify + locate target repo (new vs enhancement) | 5, 2 |
| 7 | [phase-07-plan-approval.md](phase-07-plan-approval.md) | plan.md into repo + approval flow + quorum rules | 6 |
| 8 | [phase-08-execution-git.md](phase-08-execution-git.md) | Agent executes in repo; git stash/branch/commit (no push) | 3, 7 |
| 9 | [phase-09-build-test-gate.md](phase-09-build-test-gate.md) | Build/test gate before commit/push | 8 |
| 10 | [phase-10-realtime-visibility.md](phase-10-realtime-visibility.md) | Event bus + VS Code extension + web dashboard | 8 |
| 11 | [phase-11-board-front-door.md](phase-11-board-front-door.md) | `quorum watch` + bidirectional ticket updates | 7 |
| 12 | [phase-12-teams-adapter.md](phase-12-teams-adapter.md) | Microsoft Teams (lead production channel) | 4, 7 |
| 13 | [phase-13-whatsapp-slack-discord.md](phase-13-whatsapp-slack-discord.md) | WhatsApp + finish Slack/Discord | 4, 7 |
| 14 | [phase-14-multidev-enterprise.md](phase-14-multidev-enterprise.md) | `.quorum/` sync, identity, security/env gates | 7 |

## Milestones
- **M1 (Phases 0–3):** correct, provider-agnostic engine with a tool/agent harness.
- **M2 (Phases 4–7):** chat → plan → approve, end-to-end, plan lands in the target repo.
- **M3 (Phases 8–10):** Qorum executes, the developer watches live and reviews the diff,
  commit on approval (no push). *This is the viral demo.*
- **M4 (Phases 11–14):** boards integrated, Teams + other channels, enterprise hardening.

## Per-phase file template
Each phase file has: Goal · Why now / dependencies · Scope (in/out) · Design ·
File-level work breakdown · Ordered tasks · Interfaces/schemas · Edge cases ·
Verification · Definition of Done.
