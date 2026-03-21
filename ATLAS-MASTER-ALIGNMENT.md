# ATLAS — Master Alignment Document
# Read this before touching any file. Every file. Every time.

Version: 4.0 (final)
Last updated: March 2026

---

## WHAT ATLAS IS

ATLAS is a standalone autonomous development framework.
One command. Fourteen coordinated AI agents. Complete application built.
Permanent memory. Any AI provider. Three interfaces.

ATLAS ships as three products sharing one core engine:

  CLI TOOL          npm install -g @atlas/cli
                    atlas new "build me a SaaS"
                    Works in any terminal. No IDE required.

  MCP SERVER        node packages/mcp/dist/server.js
                    Works with Claude Desktop, Cursor, Windsurf,
                    any MCP-compatible client. 14 tools.

  VS CODE EXT       Install from VS Code marketplace.
                    (Phase 5 — not yet built)

---

## WHAT ATLAS IS NOT

NOT locked to Anthropic.
  Claude is the default because most users have it.
  Every model call routes through model-router.
  Change atlas.config.json to use GPT-4o, Gemini, DeepSeek, Ollama.
  No code changes required.

---

## COMPLETE REPOSITORY STRUCTURE

ATLAS-CLAUDE/
  packages/
    core/                          THE ENGINE
      src/
        engine.ts                  Main ATLASEngine class — all 25 commands wired
        types.ts                   All TypeScript interfaces
        config.ts                  loadConfig() — loads atlas.config.json
        agent-runner.ts            Reads .md files → calls APIs
        tool-executor.ts           file_read/write/bash/glob/grep
        providers/
          base.ts
          anthropic.ts             Claude
          openai.ts                GPT + Groq + DeepSeek (all OpenAI-compatible)
          google.ts                Gemini
          local.ts                 Ollama
          index.ts                 buildRoutingTable() — auto-detects providers
          discover.ts              discoverProviderModels() — finds available models
        memory/
          nervous-system.ts        .atlas/ folder manager
          task-manager.ts          Task CRUD + impact analysis + task-index.json
          plan-manager.ts          Plan CRUD + phase tracking + plan-index.json
          goal-guardian.ts         goal.md scope enforcement
          session-brief.ts         500-token context generator
          function-registry.ts     Maps every function — 98.8% cheaper navigation
        testing/
          e2e-runner.ts            Playwright browser testing
          test-generator.ts        Auto-generates tests from .atlas/ knowledge
          app-detector.ts          Detects + starts the app
          index.ts
        commands/                  One file per command group
          index.ts                 Barrel export
          init.ts                  atlas init
          fast.ts                  atlas fast
          next.ts                  atlas next
          pause-resume.ts          atlas pause / resume
          doctor.ts                atlas doctor
          discuss.ts               atlas discuss
          verify.ts                atlas verify
          ship.ts                  atlas ship
          review.ts                atlas review
          map.ts                   atlas map
          debug.ts                 atlas debug
          session-report.ts        atlas session-report
          seed-backlog-note.ts     atlas seed / backlog / note
          agents-profile.ts        atlas agents / profile

    cli/
      src/
        index.ts                   All 25 commands with flags

    mcp/
      src/
        server.ts                  14 MCP tools — uses @atlas/core

  agents/                          System prompt .md files (14 agents)
    atlas-orchestrator.md
    atlas-classifier.md
    atlas-critic.md
    atlas-backend-architect.md
    atlas-backend-validator.md
    atlas-design-architect.md
    atlas-design-validator.md
    atlas-frontend-builder.md
    atlas-integration.md
    atlas-testing.md
    atlas-scaling.md
    atlas-nervous-system.md
    atlas-planner.md
    atlas-task-manager.md

---

## WHAT LIVES IN USER PROJECTS (.atlas/)

project/
  .atlas/
    goal.md                  ← HUMAN writes once, AI reads only
    task.md                  ← append only, forever
    task-index.json          ← fast lookup (500 tokens vs 50,000)
    implementation-plan.md   ← append only, human approved
    plan-index.json          ← fast lookup
    plan.md                  ← active execution (surgical updates)
    history_plan.md          ← immutable session history
    BUGS.md                  ← append only, forever
    DEVGUIDE.md              ← living architecture doc
    HANDOFF.md               ← created by atlas pause, deleted by atlas resume
    HANDOFF.json             ← machine-readable pause state
    NOTES.md                 ← quick human notes
    SEEDS.md                 ← future ideas to surface later
    BACKLOG.md               ← parked items outside active tasks

    nervous-system/
      decisions.json
      actions.json
      reasoning.json
      open-questions.json
      conflicts.json
      function-registry.json   ← CRITICAL: maps every function in codebase
      bug-registry.json
      stack.json

    context/
      session-brief.md         ← 500-token context, regenerated each session
      architecture-proposal.md
      design-proposal.md
      test-report.md
      review-report.md
      codebase-map.md
      session-report.md
      budget-log.json

    rollback_points/           ← created after each checkpoint

---

## THE 25 CLI COMMANDS

atlas init                       Initialize project — creates .atlas/ + goal.md
atlas new <desc>                 Full pipeline — new feature or app
atlas enhance <desc>             Targeted change on existing feature
atlas fast <desc>                Quick task — no full pipeline (< 5 files)
atlas next                       Auto-detect what to do next
atlas pause                      Save mid-session state cleanly
atlas resume                     Restore paused session
atlas doctor [--repair]          Health check + auto-fix issues
atlas discuss <feature>          Context gathering before planning
atlas verify                     Interactive UAT — confirm deliverables
atlas ship [--draft]             Create pull request
atlas review [path]              Code + security review
atlas map [area]                 Agents read and summarize codebase
atlas debug <error>              Systematic root-cause debugging
atlas session-report             Summary of this session
atlas seed <idea>                Capture future idea (non-disruptive)
atlas backlog [add|list|promote] Backlog management
atlas note <text>                Quick note to NOTES.md
atlas agents                     List agents + model assignments
atlas profile <name>             Switch model tier (fast/balanced/quality)
atlas status                     Current state, routing, costs
atlas rollback [point]           Return to previous state
atlas sync                       Re-index project + rebuild function registry
atlas help                       List all commands
atlas update                     Update to latest version

---

## THE 14 MCP TOOLS

atlas_new                        Build new feature
atlas_enhance                    Modify existing feature
atlas_fast                       Quick task
atlas_next                       What to do next
atlas_status                     Current state (routing/decisions/progress flags)
atlas_task_list                  List tasks by status
atlas_goal                       Read project goal
atlas_discuss                    Gather context before planning
atlas_debug                      Systematic debugging
atlas_review                     Code + security review
atlas_functions                  Query function registry (98.8% cheaper than file reads)
atlas_rollback                   Revert to rollback point
atlas_session_report             Session summary
atlas_doctor                     Health check

---

## HOW FUNCTION REGISTRY WORKS

Without registry:
  Agent needs function X → reads entire file: 15,000 tokens
  Finds callers → reads 3 more files: 45,000 tokens
  Total: 60,000 tokens for navigation

With registry:
  Agent queries function-registry.json: 200 tokens
  Gets: file path, line number, callers, callees, purpose, tags
  Reads only the specific lines needed: 500 tokens
  Total: 700 tokens
  Savings: 98.8%

function-registry.json is auto-maintained by:
  - atlas sync (full rebuild of src/**)
  - End of every atlas enhance session (FunctionRegistry.scanAndUpdate())
  - MCP atlas_functions tool exposes it for direct query

---

## THREE RULES FOR EVERY CODE CHANGE

Rule 1: Model agnostic first
  Every AI call through model-router.
  Never hardcode provider names outside providers/.
  If you find a hardcoded model string: fix it.

Rule 2: Memory persistent always
  Every significant action writes to .atlas/.
  Next session must have full context.
  If something is not being saved: fix it.

Rule 3: Human in control
  Three checkpoints: architecture, design, testing.
  Never auto-proceed (unless --auto flag is set).
  Never make irreversible changes without approval.

---

## BUILD ORDER — NEVER DEVIATE

Phase 1 (DONE): Core memory system (NervousSystem, TaskManager, PlanManager, GoalGuardian, SessionBrief)
Phase 2 (DONE): Provider system (Anthropic, OpenAI-compat, Google, Ollama, auto-discovery)
Phase 3 (DONE): 21 CLI commands + engine dispatch + CLI rewrite (25 commands total)
Phase 4 (DONE): FunctionRegistry + engine helpers (scope guard, rollback points, plan gate) + MCP server (14 tools)
Phase 5 (NEXT): VS Code extension

DO NOT build Phase 5 until Phase 4 is tested and working on a real project.

---

## WHAT SUCCESS LOOKS LIKE

A developer installs ATLAS once:
  npm install -g @atlas/cli

Day 1 — new project:
  atlas init              # creates .atlas/, prompts for goal
  atlas discuss "feature" # surfaces important questions first
  atlas new "feature"     # builds it (40 min total human time)

Day 2 — adding to it:
  atlas next              # tells them what to do
  atlas enhance "change"  # scope check + function registry + targeted build
  atlas verify            # confirms everything works
  atlas ship              # creates PR

Day 30 — team is using it:
  New developer joins.
  They read .atlas/goal.md: know what we're building.
  They read .atlas/task.md: know everything that was done.
  atlas agents: see which AI is doing what.
  Productive in 30 minutes.

Day 90 — the AI knows more than any individual:
  function-registry.json has every function, purpose, callers.
  bug-registry.json has every bug ever found, prevention patterns.
  decisions.json has every architectural decision with reasoning.
