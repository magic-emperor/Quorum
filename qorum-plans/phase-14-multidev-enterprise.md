# Phase 14 — Multi-Developer Sync + Enterprise Hardening

> **Goal:** Make Qorum safe for a real team and a real company: concurrent `.quorum/` writes without
> corruption, one identity per person across platforms, and security/secrets/env gates so generated
> work meets an enterprise bar before it ships.

## Why now / dependencies
- **Depends on:** Phase 7 (approval/contributors/audit), Phase 8 (commit/git), Phase 11 (boards),
  Phases 12–13 (multiple platform identities to unify).
- Last phase: hardening over the working product, not new core flow.

## Scope
**In:** `.quorum/` concurrency strategy, cross-platform identity mapping, `quorum security` +
`quorum env` gates wired into the pipeline, secrets scanning at commit, multi-dev approval edge cases.
**Out:** SSO provisioning UI, billing, hosted multi-tenant infra (separate productization track).

## Design

### A) Multi-developer `.quorum/` sync — `qorum/memory/sync.py`
Problem: two devs in the same repo both mutate `.quorum/nervous-system/*.json`.
- **Optimistic concurrency:** every JSON write includes a `version` hash of the prior content; write
  only if unchanged, else re-read + merge + retry. (`write_json_cas(path, mutate_fn)`.)
- **File strategies (from the future-plan):**
  - `nervous-system/*.json` → merge, last-writer-wins per top-level key (keys are independent records).
  - `collaboration/audit-trail.json` → **append-only** (no conflicts by construction).
  - `collaboration/approvals/*.json` → **immutable once written** (new version = new file).
- **Git-level:** `.quorum/` is committed; add a `.gitattributes` merge strategy for the append-only
  files; document that nervous-system conflicts resolve by union. Conflicts that can't auto-resolve →
  recorded in `.quorum/nervous-system/conflicts.json` (already in schema) + surfaced in chat.
- If `quorum-server` (Phase 10) is running, it brokers writes via WebSocket presence to avoid most
  races in the first place.

### B) Cross-platform identity — `qorum/bot/identity.py` (unify)
- `contributors.json`: one contributor record with `platforms: { teams_id, slack_id, discord_id,
  telegram_id, whatsapp_phone, board_account }` + `role` (`lead`/`dev`/`reviewer`).
- `resolve_contributor(platform, platform_user_id) -> Contributor`. Used by the quorum engine so
  "approve in Teams" and "approve in Slack" count as the same person; required-approver lists are
  platform-agnostic.
- `/qorum link <platform>` flow to self-register a platform id to a contributor (verified via a code).

### C) `quorum security` gate — `qorum/security/scan.py` (uses `security` agent + tools)
- Runs as an **optional gate after the build/test gate (Phase 9), before commit/push**:
  - `npm audit` / `pip-audit` / `cargo audit` (dependency CVEs) per detected toolchain.
  - OWASP-style static checks via the `security` agent over the **diff** (injection, authz, secrets in
    code) — evidence-only, reports findings with file:line.
  - Severity gate: high/critical → block commit (or explicit override, audit-logged); medium/low → warn.

### D) `quorum env` + secrets — `qorum/security/env.py`
- Validate `.env` vs `.env.example` (missing/extra vars); generate/update `.env.example` from code usage.
- **Secrets scanner** runs as a **pre-commit guard inside Phase 8's `git.commit`**: regex/entropy scan
  of staged diff for keys/tokens; block the commit if a secret is detected (this is why the secrets
  check was referenced in Phase 8).

### E) Multi-dev approval edge cases (extend Phase 7 quorum)
- Concurrent votes from different platforms → dedupe by resolved contributor (not platform id).
- A required approver who is offline past timeout → escalation list (`lead` fallback) configurable.
- Audit trail records the **contributor**, the platform used, and the timestamp for every vote.

## File-level work breakdown
- `qorum/memory/sync.py` (CAS writes + merge strategies) + `.gitattributes`.
- `qorum/bot/identity.py` (unify) + `/qorum link` command.
- `qorum/security/{scan,env,secrets}.py` + `security` agent def.
- `qorum/execution/{runner,git_flow}.py` — insert security gate (post-test) + secrets pre-commit guard.
- `quorum.config.json` — security gate thresholds, escalation rules, sync mode.

## Ordered tasks
1. `write_json_cas` + per-file merge strategies + conflicts.json surfacing + tests (simulate concurrent writers).
2. Unify identity + `/qorum link` + route quorum engine through resolved contributors.
3. Secrets scanner as a pre-commit guard in `git.commit` (blocks on detection) + tests.
4. `quorum env` validate/generate; `quorum security` dependency + diff scan gate.
5. Multi-dev approval edge cases + escalation + audit enrichment.
6. Tests + commit `feat: multi-dev sync + enterprise hardening`.

## Edge cases
- **Lost update** under concurrency → CAS retry; if it keeps losing (hot key) → queue via server.
- **Append-only file corrupted by a bad merge** → validate JSONL on read; quarantine bad lines + warn.
- **Same person, two platform ids, both approve** → counts once.
- **Secret falsely flagged** (e.g. example key) → allowlist file (`.qorum-secrets-allow`) with audit.
- **Security gate blocks a legitimate change** → explicit override (audit-logged), never silent bypass.
- **`.env` drift across team** → `quorum env` reports; doesn't auto-write real secrets.
- **Offline approver / timezone** → escalation chain; timeout from Phase 7 still applies.

## Verification
- `tests/unit/test_cas_sync.py` — two concurrent mutators → no lost update; audit-trail append safe.
- `tests/unit/test_identity.py` — multi-platform votes resolve to one contributor; quorum counts correctly.
- `tests/unit/test_secrets_guard.py` — staged diff with a fake key → commit blocked; allowlisted → allowed.
- `tests/integration/test_security_gate.py` — vulnerable dep / injection in diff → high severity blocks
  commit; override path audited.
- Manual: two devs drive the same repo concurrently → no `.quorum/` corruption; identity unified across
  Teams + Slack approvals.

## Definition of Done
- Concurrent `.quorum/` writes are safe (CAS + append-only + documented git merge); conflicts surfaced.
- One identity per person across all platforms; quorum rules count people, not platform accounts.
- Security + secrets + env gates run before commit/push; high-severity findings block (override audited).
- Qorum is team-safe and meets an enterprise pre-ship bar.
