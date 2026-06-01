# Phase 0 — Consolidation & Naming

> **Goal:** Collapse the scattered work into **one Python package `qorum/`**, rename
> ATLAS→Qorum everywhere, adopt `.quorum/` as the per-project memory format the engine
> reads/writes, and lock the tech stack + dependencies. After this phase the project builds,
> imports, and its existing tests pass under the new name.

## Why now / dependencies
- **Depends on:** nothing. This is the first phase.
- Everything downstream imports from `qorum.*` and writes to `.quorum/`. Do the rename once,
  here, so no later phase has to carry an `atlas`↔`qorum` translation layer.

## Current reality (what we're consolidating)
- `d:\Atlas\atlas\` — **the real engine** (Python). This becomes `qorum/`.
- `d:\Atlas\QUORUM-CLAUDE\.quorum\` — the **memory/collaboration schema** (JSON+MD). We adopt
  this directory layout as Qorum's per-project memory; the engine will create/maintain it
  inside each target repo.
- `d:\Atlas\QUORUM-CLAUDE\src\*.ts`, `ATLAS-CLAUDE/`, `Initial_plan.md`, `plan2-5.md` — **reference
  only.** Do not port. Move under `d:\Atlas\_archive\` so the workspace root is clean.

## Scope
**In:** package rename, env-var rename, config class rename, dependency lock, `.env.example`,
repo hygiene, smoke build + existing test run.
**Out:** any behavior change, bug fixes (Phase 1), new features. This phase must be a pure,
reviewable rename + reorg with green tests.

## Target layout (after this phase)
```
d:\Atlas\
  qorum/                       ← was atlas/  (the package)
    __init__.py                ← exposes version + public API
    config.py                  ← QorumConfig (was ATLASConfig)
    main.py
    core/        (orchestrator, plan_generator, schemas, retry, logger)
    adapters/    (board adapters: jira/azure/linear/github + base + detector)
    bot/         (base_adapter + telegram/slack/discord)
    approval/    (state_machine, db)
    output/      (manager, renderer, templates/)
    prompts/     (plan_v1.md, phase_splitter_v1.md, testing_v1.md)
    tests/       (unit/, integration/, fixtures/)
  qorum-plans/                 ← these phase docs
  _archive/                    ← ATLAS-CLAUDE, QUORUM-CLAUDE, old plan*.md, Initial_plan.md
  pyproject.toml               ← NEW (replaces ad-hoc requirements.txt; see below)
  .env.example                 ← unified
  README.md
```

## File-level work breakdown

### 1. Move + rename the package
- `git mv atlas qorum` (or copy if not yet a git repo — **init one first**, see task 0).
- Update **every** intra-package import `from atlas.` → `from qorum.` (≈ all files under the
  package; ~30 files). Representative: `qorum/core/orchestrator.py`, `qorum/bot/base_adapter.py`,
  `qorum/output/manager.py`, all `tests/`.
- Rename the public class `ATLASConfig` → `QorumConfig`, `ATLASOrchestrator` → `QorumOrchestrator`,
  `ATLASPlanGenerator` → `QorumPlanGenerator`, `ATLASOutputManager` → `QorumOutputManager`,
  `ATLASApprovalPipeline` → `QorumApprovalPipeline`, `ATLASRenderer` → `QorumRenderer`,
  `BaseAtlasAdapter` → `BaseQorumAdapter`. Keep logic identical.

### 2. Rename config fields + env vars (`qorum/config.py`)
- `atlas_output_path` → `qorum_output_path`, `atlas_model_*` → `qorum_model_*`,
  `atlas_db_path` → `qorum_db_path`, `atlas_platform_override` → `qorum_platform_override`,
  `atlas_log_level/cache_ttl/max_children/large_ticket_phase_limit` → `qorum_*`.
- Env-var prefix `ATLAS_` → `QORUM_` (pydantic-settings reads from these names).
- **Do not** change `anthropic_api_key` yet — Phase 2 replaces provider config. Leave the
  Claude-only requirement intact here so tests still pass.
- Command surface: keep `/atlas` working but **add `/qorum` as the primary alias** in
  `bot/base_adapter.py` `parse_*_command` (accept both prefixes). Full chat rework is Phase 4.

### 3. Adopt `.quorum/` schema as canonical memory format
- Add `qorum/memory/schema.py` documenting the `.quorum/` layout (nervous-system/*.json,
  collaboration/*, plan.md, task.md, indexes) as Pydantic models or typed dicts — **definitions
  only**, no writers yet (writers land in Phases 6–8). Copy the concrete shapes from
  `_archive/QUORUM-CLAUDE/.quorum/`.

### 4. Dependency lock (`pyproject.toml`)
- Convert `atlas/requirements.txt` into `pyproject.toml` (PEP 621). Pin: `python>=3.11`,
  `pydantic>=2`, `pydantic-settings`, `anthropic`, `aiofiles`, `httpx`, `structlog` (or current
  logger dep), `python-telegram-bot`, `slack-bolt`, `discord.py`, `pytest`, `pytest-asyncio`.
- Reserve (commented, enabled in later phases): `openai`, `google-genai`, `mistralai`,
  `fastapi`, `uvicorn`, `websockets`, `botbuilder-core`, `claude-agent-sdk`.

### 5. `.env.example` (unified, documented)
- One block per concern: AI provider keys (placeholder for all 8 — Phase 2 wires them),
  board tokens (Azure/Jira/GitHub/Linear), bot tokens (Telegram/Slack/Discord), paths, flags.

### 6. Repo hygiene
- `d:\Atlas\_archive\` ← move `ATLAS-CLAUDE/`, `QUORUM-CLAUDE/`, `Initial_plan.md`,
  `plan2.md`–`plan5.md`, `researchplan4.md`, `ATLAS_BA_Agent_MasterPlan.md`, `everything-claude-code/`.
- `.gitignore`: `.env`, `*.db`, `__pycache__/`, `qorum-output/`, `.venv/`.

## Ordered tasks
0. `git init` at `d:\Atlas` (the master plan notes this is not yet a repo). First commit = current state, **before** rename, so the rename is a reviewable diff.
1. Move reference material to `_archive/`.
2. `git mv atlas qorum`; bulk-update imports `atlas.`→`qorum.`.
3. Rename classes + config fields + env prefix (tasks 1–2 above).
4. Add `qorum/memory/schema.py` (definitions only).
5. Write `pyproject.toml` + `.env.example` + `.gitignore` + root `README.md`.
6. `pip install -e .` in a fresh `.venv`; fix import errors.
7. Run existing tests; fix only rename-related breakage (real bugs are Phase 1).
8. Commit: `chore: consolidate atlas→qorum, lock stack`.

## Interfaces / schemas touched
- `QorumConfig` (renamed). No signature changes to public methods beyond names.
- `qorum/memory/schema.py` (new, declarative).

## Edge cases
- **Not a git repo yet** → init before moving files (task 0) so nothing is lost.
- **Hardcoded `"atlas"` strings** in log event names (`"atlas.process.start"`) and the
  output folder name → rename to `qorum.*` / `qorum-output`; grep for the literal `atlas`
  (case-insensitive) and review each hit.
- **`.atlas/` vs `.quorum/`** references in code/tests → standardize on `.quorum/`.

## Verification
- `python -c "import qorum"` succeeds.
- `pytest qorum/tests` runs; failures are pre-existing logic bugs (catalogued for Phase 1),
  **not** import/name errors.
- `grep -ri "atlas" qorum/` returns only intentional references (none expected in code).

## Definition of Done
- Single `qorum/` package; no `atlas` imports or class names remain.
- `pip install -e .` clean; tests execute under the new name.
- Reference material archived; workspace root is clean; first two commits exist
  (pre-rename snapshot + rename).
