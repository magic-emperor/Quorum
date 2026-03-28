import { describe, it, expect } from 'vitest'
import {
  createApprovalRequest,
  recordApproval,
  recordRejection,
  checkExpiry,
  formatApprovalStatus,
  pendingApprovers,
  isReadyToExecute
} from '../approval-manager.js'
import type { ApprovalRequest, PlanRequest } from '../types.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pending(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    plan_request_id: 'plan-1',
    required_approvers: ['user-a', 'user-b', 'user-c'],
    approved_by: [],
    rejected_by: [],
    quorum: 'all',
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    status: 'pending',
    ...overrides
  }
}

// ─── createApprovalRequest ───────────────────────────────────────────────────

describe('createApprovalRequest', () => {
  it('creates with correct plan_request_id', () => {
    const a = createApprovalRequest('my-plan', ['u1'], 'any', 24)
    expect(a.plan_request_id).toBe('my-plan')
  })

  it('sets status to pending', () => {
    const a = createApprovalRequest('p', ['u1'], 'any', 24)
    expect(a.status).toBe('pending')
  })

  it('sets expires_at ~24 hours from now', () => {
    const before = Date.now()
    const a = createApprovalRequest('p', ['u1'], 'any', 24)
    const expires = new Date(a.expires_at).getTime()
    expect(expires).toBeGreaterThan(before + 23 * 60 * 60 * 1000)
    expect(expires).toBeLessThan(before + 25 * 60 * 60 * 1000)
  })

  it('starts with empty approved_by and rejected_by', () => {
    const a = createApprovalRequest('p', ['u1', 'u2'], 'all', 24)
    expect(a.approved_by).toHaveLength(0)
    expect(a.rejected_by).toHaveLength(0)
  })
})

// ─── recordApproval — quorum: any ────────────────────────────────────────────

describe('recordApproval — quorum: any', () => {
  it('approves after one approval', () => {
    const a = pending({ quorum: 'any', required_approvers: ['u1', 'u2'] })
    const result = recordApproval(a, 'u1')
    expect(result.status).toBe('approved')
    expect(result.approved_by).toContain('u1')
  })

  it('is idempotent — same user approving twice stays approved once', () => {
    const a = pending({ quorum: 'any', required_approvers: ['u1'] })
    const r1 = recordApproval(a, 'u1')
    const r2 = recordApproval(r1, 'u1')
    expect(r2.approved_by.filter(id => id === 'u1')).toHaveLength(1)
  })

  it('ignores approval when already approved', () => {
    const a = pending({ quorum: 'any', status: 'approved', approved_by: ['u1'] })
    const result = recordApproval(a, 'u2')
    expect(result.approved_by).not.toContain('u2')
  })
})

// ─── recordApproval — quorum: all ────────────────────────────────────────────

describe('recordApproval — quorum: all', () => {
  it('stays pending until all approve', () => {
    let a = pending({ quorum: 'all', required_approvers: ['u1', 'u2', 'u3'] })
    a = recordApproval(a, 'u1')
    expect(a.status).toBe('pending')
    a = recordApproval(a, 'u2')
    expect(a.status).toBe('pending')
  })

  it('approves when all have approved', () => {
    let a = pending({ quorum: 'all', required_approvers: ['u1', 'u2'] })
    a = recordApproval(a, 'u1')
    a = recordApproval(a, 'u2')
    expect(a.status).toBe('approved')
  })
})

// ─── recordApproval — quorum: majority ───────────────────────────────────────

describe('recordApproval — quorum: majority', () => {
  it('approves when majority reached (2 of 3)', () => {
    let a = pending({ quorum: 'majority', required_approvers: ['u1', 'u2', 'u3'] })
    a = recordApproval(a, 'u1')
    expect(a.status).toBe('pending')
    a = recordApproval(a, 'u2')
    expect(a.status).toBe('approved')
  })

  it('approves with 1 of 1', () => {
    let a = pending({ quorum: 'majority', required_approvers: ['u1'] })
    a = recordApproval(a, 'u1')
    expect(a.status).toBe('approved')
  })
})

// ─── recordApproval — quorum: lead ───────────────────────────────────────────

describe('recordApproval — quorum: lead', () => {
  it('approves when the first required approver (lead) approves', () => {
    let a = pending({ quorum: 'lead', required_approvers: ['lead-user', 'u2', 'u3'] })
    a = recordApproval(a, 'lead-user')
    expect(a.status).toBe('approved')
  })

  it('stays pending if non-lead approves first', () => {
    let a = pending({ quorum: 'lead', required_approvers: ['lead-user', 'u2'] })
    a = recordApproval(a, 'u2')
    expect(a.status).toBe('pending')
  })
})

// ─── recordRejection ─────────────────────────────────────────────────────────

describe('recordRejection', () => {
  it('immediately sets status to rejected', () => {
    const a = pending()
    const result = recordRejection(a, 'u1', 'Wrong approach')
    expect(result.status).toBe('rejected')
    expect(result.rejection_reason).toBe('Wrong approach')
    expect(result.rejected_by).toContain('u1')
  })

  it('does nothing if already rejected', () => {
    const a = pending({ status: 'rejected', rejected_by: ['u1'] })
    const result = recordRejection(a, 'u2', 'Another reason')
    expect(result.rejected_by).not.toContain('u2')
  })

  it('works without a reason', () => {
    const result = recordRejection(pending(), 'u1')
    expect(result.status).toBe('rejected')
    expect(result.rejection_reason).toBeUndefined()
  })
})

// ─── checkExpiry ─────────────────────────────────────────────────────────────

describe('checkExpiry', () => {
  it('returns expired when past expiry date', () => {
    const a = pending({ expires_at: new Date(Date.now() - 1000).toISOString() })
    expect(checkExpiry(a).status).toBe('expired')
  })

  it('keeps pending when not yet expired', () => {
    const a = pending({ expires_at: new Date(Date.now() + 99999).toISOString() })
    expect(checkExpiry(a).status).toBe('pending')
  })

  it('does not change already-approved approval', () => {
    const a = pending({ status: 'approved', expires_at: new Date(Date.now() - 1000).toISOString() })
    expect(checkExpiry(a).status).toBe('approved')
  })
})

// ─── formatApprovalStatus ────────────────────────────────────────────────────

describe('formatApprovalStatus', () => {
  it('shows tick and counts for approved', () => {
    const a = pending({ status: 'approved', approved_by: ['u1', 'u2'], required_approvers: ['u1', 'u2'] })
    expect(formatApprovalStatus(a)).toContain('✅')
  })

  it('shows cross and reason for rejected', () => {
    const a = pending({ status: 'rejected', rejection_reason: 'Bad idea' })
    const s = formatApprovalStatus(a)
    expect(s).toContain('❌')
    expect(s).toContain('Bad idea')
  })

  it('shows clock for expired', () => {
    const a = pending({ status: 'expired' })
    expect(formatApprovalStatus(a)).toContain('⏰')
  })

  it('shows hourglass and percentage for pending', () => {
    const a = pending({ required_approvers: ['u1', 'u2'], approved_by: ['u1'] })
    const s = formatApprovalStatus(a)
    expect(s).toContain('⏳')
    expect(s).toContain('1/2')
  })
})

// ─── pendingApprovers ─────────────────────────────────────────────────────────

describe('pendingApprovers', () => {
  it('returns users who have not yet approved', () => {
    const a = pending({ required_approvers: ['u1', 'u2', 'u3'], approved_by: ['u1'] })
    expect(pendingApprovers(a)).toEqual(['u2', 'u3'])
  })

  it('returns empty when all approved', () => {
    const a = pending({ required_approvers: ['u1'], approved_by: ['u1'] })
    expect(pendingApprovers(a)).toHaveLength(0)
  })
})

// ─── isReadyToExecute ─────────────────────────────────────────────────────────

describe('isReadyToExecute', () => {
  const basePlan: PlanRequest = {
    id: 'p1',
    project_dir: '/tmp/proj',
    summary: { decisions: [], open_questions: [], acceptance_criteria: [], context: '' },
    chat_messages: [],
    requester_id: 'u1',
    channel_id: 'c1',
    platform: 'teams',
    created_at: new Date().toISOString(),
    status: 'pending_approval'
  }

  it('returns true when both plan and approval are approved', () => {
    const plan = { ...basePlan, status: 'approved' as const }
    const approval = pending({ status: 'approved' })
    expect(isReadyToExecute(plan, approval)).toBe(true)
  })

  it('returns false when plan approved but approval pending', () => {
    const plan = { ...basePlan, status: 'approved' as const }
    const approval = pending({ status: 'pending' })
    expect(isReadyToExecute(plan, approval)).toBe(false)
  })

  it('returns false when approval approved but plan not yet approved', () => {
    const plan = { ...basePlan, status: 'pending_approval' as const }
    const approval = pending({ status: 'approved' })
    expect(isReadyToExecute(plan, approval)).toBe(false)
  })
})
