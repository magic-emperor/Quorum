# Phase 6 — Classifier + Project Locator

> **Goal:** Solve two gaps. **(1) Classification** — decide whether an Intent is actionable, what
> *type* of work it is, and how *complex*, then route it to the right agents and model tier.
> **(2) Project location** — decide *which codebase* the work targets and whether it's a new
> project or an enhancement, so the plan lands in the **correct repo's `.quorum/`** (closing B6).

## Why now / dependencies
- **Depends on:** Phase 5 (`Intent` + `ChatSummary`), Phase 2 (LLM roles).
- **Consumed by:** Phase 7 (plan synthesis writes to the located repo), Phase 8 (executor runs in it).

## Scope
**In:** actionability gate, work-type + complexity classifier, routing map, the project registry,
new-vs-enhancement detection, repo resolution + confirm card, repointing output to the target
`.quorum/`. **Out:** generating the plan (Phase 7), executing (Phase 8).

## Design

### A) Classifier — `qorum/collaboration/classifier.py`
Three sequential checks (uses the `classify` role / `classifier` agent):
```
1. ACTIONABILITY GATE
   Is this a concrete work request? → {actionable: bool, reason, clarifying_question?}
   If not actionable → bot asks the ONE clarifying question and STOPS (no plan). 
2. WORK-TYPE
   one of: bug | feature | enhancement | refactor | chore | question
   → selects plan template + agent route (see routing map).
3. COMPLEXITY
   SIMPLE | COMPLEX  (reuse ATLAS classifier rules — multi-role/payments/realtime/>3 entities/
   >1 integration/background jobs/etc. → COMPLEX; tie → COMPLEX)
   → pipeline depth (single plan vs phased) + model tier (fast/default/premium).
```
Output `Classification` (Pydantic): `{ actionable, work_type, complexity, model_tier,
agent_route: list[str], reasoning, clarifying_question? }`.

**Routing map** (work_type → agents, consumed by Phase 8):
```
bug         → coder, tester
feature     → planner, coder, reviewer, tester
enhancement → planner, coder, reviewer, tester
refactor    → reviewer(lead), coder, tester
chore       → coder
question     → (no execution) answer in chat
```

### B) Project Locator — `qorum/collaboration/locator.py`
**Registry** `qorum/registry.json` (project-level, committed):
```json
{ "mappings": [
  { "match": {"platform":"telegram","channel_id":"-100123"}, "repo_path":"D:/work/payments",
    "default_branch":"main" },
  { "match": {"board_project":"PAY"}, "repo_path":"D:/work/payments", "default_branch":"main" }
] }
```
Resolution algorithm:
```
locate(intent, classification) -> LocateResult:
  1. Look up registry by channel/workspace (chat) or board project (board). → repo_path?
  2. If repo_path found:
       grep the repo for summary.referenced_paths / symbols.
       hits  → mode = ENHANCEMENT, target_repo = repo_path,
               plan dir = repo/.quorum/  (module-scoped: src/<module>/.quorum/ if localized)
       no hits but repo mapped → still ENHANCEMENT (general), plan at repo/.quorum/
  3. If NO mapping:
       intent clearly says "build new X" → mode = NEW_PROJECT,
               scaffold dir = qorum_workspace/<slug>/  + seed fresh .quorum/
       else → mode = UNRESOLVED → ask the user to map a repo (offer /qorum map <path>).
  4. Multi-repo signals (paths across two mapped repos) → mode = MULTI,
       ask which / offer to split into 2 plans.
LocateResult = { mode, target_repo|scaffold_path, plan_dir, default_branch, confidence, why }
```
- **Confirm on the card** (Phase 7 approval card includes this): "Enhancement to `payments`,
  branch `qorum/<id>`" with a [Change target] button. Human can redirect before anything is written.
- `/qorum map <channel> <repo_path>` command to populate the registry; `/qorum where` to show
  the current mapping.

### C) Repoint output (closes B6)
- Phase 1 already made `OutputManager.save_plans(..., root)` take a root. Here, the orchestrator
  passes `LocateResult.plan_dir` (the target repo's `.quorum/`) as the root. Plans, chat-summaries,
  nervous-system entries now live **inside the project**, committed with it.

## File-level work breakdown
- `qorum/collaboration/classifier.py` + `schemas.py` (`Classification`).
- `qorum/collaboration/locator.py` + `LocateResult` + `qorum/registry.py` (load/save registry).
- `qorum/agents/defs/classifier.md`, `locator.md` (prompts; reuse ATLAS classifier rules).
- `qorum/bot/actions.py` — add `change_target`, `map_repo` actions.
- Orchestrator: insert classify→locate between ingestion (Phase 5) and plan (Phase 7).

## Ordered tasks
1. `Classification` schema + classifier agent + actionability gate (with clarifying-question stop).
2. Routing map constant + tests.
3. Registry load/save + `/qorum map` / `/qorum where` commands.
4. `locator.locate` (all 4 modes) + grep-based new-vs-enhancement detection + tests.
5. Wire classify→locate into the orchestrator; pass `plan_dir` to OutputManager.
6. Confirm/redirect card hooks (rendered in Phase 7).
7. Commit `feat: classifier + project locator`.

## Edge cases
- **Actionable but ambiguous type** → default to `enhancement` (safest full route); note low confidence.
- **Repo mapped but path moved/deleted** → locator validates `repo_path` exists; if not, prompt to remap.
- **referenced_paths empty** (chat never named files) → ENHANCEMENT (general) if mapped; else UNRESOLVED.
- **New project name collision** with existing scaffold dir → suffix or ask.
- **Multi-repo** → never silently pick one; ask or split.
- **`question` work-type** → skip plan/execute entirely; answer inline (reuse summarizer/LLM).
- **Monorepo** → module-scoped plan dir via the localized-paths heuristic.

## Verification
- `tests/unit/test_classifier.py` — fixtures for each work_type + SIMPLE/COMPLEX + a non-actionable
  case that returns a clarifying question and no plan.
- `tests/unit/test_locator.py` — enhancement (paths exist), new-project, unresolved, multi-repo;
  assert `plan_dir` is the target repo's `.quorum/`, never the global folder.
- Manual: map a channel to a scratch repo; mention referencing an existing file → locator reports
  ENHANCEMENT into that repo's `.quorum/`.

## Definition of Done
- Non-actionable chatter never produces a plan (asks a question instead).
- Work-type + complexity routes to the right agents + model tier.
- Plans are written into the **correct target repo's `.quorum/`** with a human-confirmable target;
  new-vs-enhancement is auto-detected. B6 fully closed.
