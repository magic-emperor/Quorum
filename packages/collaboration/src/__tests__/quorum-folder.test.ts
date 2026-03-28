import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { CollaborationStore } from '../quorum-folder.js'
import type { PlanRequest, ApprovalRequest } from '../types.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePlan(id: string): PlanRequest {
  return {
    id,
    project_dir: '/tmp/proj',
    summary: {
      decisions: ['Use Redis'],
      open_questions: [],
      acceptance_criteria: ['Login works'],
      context: 'Auth rewrite',
    },
    chat_messages: [],
    requester_id: 'user-1',
    channel_id: 'channel-1',
    platform: 'teams',
    created_at: new Date().toISOString(),
    status: 'pending_approval',
  }
}

function makeApproval(planId: string): ApprovalRequest {
  return {
    plan_request_id: planId,
    required_approvers: ['user-1', 'user-2'],
    approved_by: [],
    rejected_by: [],
    quorum: 'any',
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    status: 'pending',
  }
}

// ─── Setup: temp project dir per test ────────────────────────────────────────

let projectDir: string
let store: CollaborationStore

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'quorum-test-'))
  store = new CollaborationStore(projectDir)
  await store.ensureDir()
})

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true })
})

// ─── ensureDir ────────────────────────────────────────────────────────────────

describe('ensureDir', () => {
  it('creates .quorum/collaboration/ directory structure', () => {
    expect(existsSync(join(projectDir, '.quorum', 'collaboration'))).toBe(true)
    expect(existsSync(join(projectDir, '.quorum', 'collaboration', 'approvals'))).toBe(true)
    expect(existsSync(join(projectDir, '.quorum', 'collaboration', 'chat-summaries'))).toBe(true)
  })

  it('creates contributors.json with empty array', async () => {
    const contributors = await store.getContributors()
    expect(contributors).toEqual([])
  })

  it('creates config.json with defaults', async () => {
    const config = await store.getConfig()
    expect(config.quorum).toBe('any')
    expect(config.approval_timeout_hours).toBe(24)
    expect(config.auto_execute_on_approval).toBe(true)
  })

  it('is idempotent — calling twice does not throw', async () => {
    await expect(store.ensureDir()).resolves.not.toThrow()
  })
})

// ─── PlanRequest round-trip ───────────────────────────────────────────────────

describe('savePlanRequest / getPlanRequest', () => {
  it('saves and retrieves a plan', async () => {
    const plan = makePlan('plan-abc')
    await store.savePlanRequest(plan)
    const retrieved = await store.getPlanRequest('plan-abc')
    expect(retrieved).toEqual(plan)
  })

  it('returns null for unknown plan ID', async () => {
    const result = await store.getPlanRequest('does-not-exist')
    expect(result).toBeNull()
  })

  it('overwrites an existing plan on second save (update)', async () => {
    const plan = makePlan('plan-xyz')
    await store.savePlanRequest(plan)
    const updated = { ...plan, status: 'approved' as const }
    await store.savePlanRequest(updated)
    const retrieved = await store.getPlanRequest('plan-xyz')
    expect(retrieved?.status).toBe('approved')
  })
})

// ─── ApprovalRequest round-trip ───────────────────────────────────────────────

describe('saveApproval / getApproval', () => {
  it('saves and retrieves an approval', async () => {
    const approval = makeApproval('plan-1')
    await store.saveApproval(approval)
    const retrieved = await store.getApproval('plan-1')
    expect(retrieved?.plan_request_id).toBe('plan-1')
    expect(retrieved?.status).toBe('pending')
  })

  it('returns null for unknown plan ID', async () => {
    expect(await store.getApproval('unknown')).toBeNull()
  })

  it('reflects status update after re-save', async () => {
    const approval = makeApproval('plan-2')
    await store.saveApproval(approval)
    await store.saveApproval({ ...approval, status: 'approved', approved_by: ['user-1'] })
    const retrieved = await store.getApproval('plan-2')
    expect(retrieved?.status).toBe('approved')
    expect(retrieved?.approved_by).toContain('user-1')
  })
})

// ─── Audit trail ─────────────────────────────────────────────────────────────

describe('appendAudit', () => {
  it('appends entries without overwriting previous ones', async () => {
    await store.appendAudit({ event: 'plan_created', plan_id: 'p1', timestamp: new Date().toISOString() })
    await store.appendAudit({ event: 'approved', plan_id: 'p1', user_id: 'u1', timestamp: new Date().toISOString() })

    // Read audit file directly to verify
    const { readFile } = await import('fs/promises')
    const raw = await readFile(join(projectDir, '.quorum', 'collaboration', 'audit-trail.json'), 'utf-8')
    const trail = JSON.parse(raw) as unknown[]
    expect(trail).toHaveLength(2)
  })

  it('preserves all fields on each entry', async () => {
    const entry = { event: 'plan_created', plan_id: 'p42', user_id: 'sarah', details: 'auth rewrite', timestamp: '2026-03-27T10:00:00Z' }
    await store.appendAudit(entry)
    const { readFile } = await import('fs/promises')
    const raw = await readFile(join(projectDir, '.quorum', 'collaboration', 'audit-trail.json'), 'utf-8')
    const trail = JSON.parse(raw) as typeof entry[]
    expect(trail[0]).toMatchObject(entry)
  })
})

// ─── writePlanMd / writeTaskMd ────────────────────────────────────────────────

describe('writePlanMd / writeTaskMd', () => {
  it('writes plan.md to .quorum/ folder', async () => {
    const path = await store.writePlanMd(projectDir, '# Plan\n\nContext here.')
    expect(existsSync(path)).toBe(true)
    const { readFile } = await import('fs/promises')
    expect(await readFile(path, 'utf-8')).toContain('Context here.')
  })

  it('writes task.md to .quorum/ folder', async () => {
    const path = await store.writeTaskMd(projectDir, '# Task\n\nDo this.')
    expect(existsSync(path)).toBe(true)
  })
})

// ─── Contributors ─────────────────────────────────────────────────────────────

describe('upsertContributor', () => {
  it('adds a new contributor', async () => {
    await store.upsertContributor({
      quorum_user_id: 'u1',
      name: 'Sarah',
      role: 'lead',
      platforms: { teams: 'teams-id-sarah' }
    })
    const contributors = await store.getContributors()
    expect(contributors).toHaveLength(1)
    expect(contributors[0]?.name).toBe('Sarah')
  })

  it('updates an existing contributor without adding a duplicate', async () => {
    await store.upsertContributor({ quorum_user_id: 'u1', name: 'Sarah', role: 'lead', platforms: {} })
    await store.upsertContributor({ quorum_user_id: 'u1', name: 'Sarah K.', role: 'lead', platforms: { slack: 'U123' } })
    const contributors = await store.getContributors()
    expect(contributors).toHaveLength(1)
    expect(contributors[0]?.name).toBe('Sarah K.')
    expect(contributors[0]?.platforms.slack).toBe('U123')
  })
})
