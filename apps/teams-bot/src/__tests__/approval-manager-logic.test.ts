/**
 * Tests for approval-card builders and quorum-client request shaping.
 * We test pure functions only — no network, no bot framework.
 */
import { describe, it, expect } from 'vitest'
import { buildApprovalCard, buildApprovedCard, buildRejectedCard, buildProgressCard } from '../cards/approval-card.js'
import type { ConversationSummary } from '@quorum/collaboration'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const summary: ConversationSummary = {
  decisions: ['Switch to Redis sessions', 'Add CSRF protection'],
  open_questions: ['Which Redis provider?'],
  acceptance_criteria: ['Login works', 'Session persists 7 days'],
  assigned_to: 'Ahmed',
  context: 'Replacing JWT auth with Redis sessions to fix XSS vulnerability.',
  ticket_ref: 'PROJ-99'
}

// ─── buildApprovalCard ────────────────────────────────────────────────────────

describe('buildApprovalCard', () => {
  it('produces a valid AdaptiveCard object', () => {
    const card = buildApprovalCard({
      planId: 'plan-123',
      projectDir: '/projects/myapp',
      summary,
      requesterName: 'Sarah',
      expiresAt: new Date(Date.now() + 86400000).toISOString()
    })
    expect(card.type).toBe('AdaptiveCard')
    expect(card.$schema).toContain('adaptivecards.io')
  })

  it('includes plan ID in the card data', () => {
    const card = buildApprovalCard({ planId: 'plan-abc', projectDir: '/p', summary, requesterName: 'Sarah', expiresAt: new Date().toISOString() })
    const json = JSON.stringify(card)
    expect(json).toContain('plan-abc')
  })

  it('includes approve and reject actions', () => {
    const card = buildApprovalCard({ planId: 'p', projectDir: '/p', summary, requesterName: 'S', expiresAt: new Date().toISOString() })
    const actions = card.actions as Array<{ title: string }>
    expect(actions.some(a => a.title.includes('Approve'))).toBe(true)
    expect(actions.some(a => a.title.includes('Reject'))).toBe(true)
  })

  it('includes the context text from summary', () => {
    const card = buildApprovalCard({ planId: 'p', projectDir: '/p', summary, requesterName: 'S', expiresAt: new Date().toISOString() })
    expect(JSON.stringify(card)).toContain('Replacing JWT auth')
  })

  it('shows requester name', () => {
    const card = buildApprovalCard({ planId: 'p', projectDir: '/p', summary, requesterName: 'Alice', expiresAt: new Date().toISOString() })
    expect(JSON.stringify(card)).toContain('Alice')
  })

  it('includes acceptance criteria when present', () => {
    const json = JSON.stringify(buildApprovalCard({ planId: 'p', projectDir: '/p', summary, requesterName: 'S', expiresAt: new Date().toISOString() }))
    expect(json).toContain('Login works')
    expect(json).toContain('Session persists 7 days')
  })

  it('handles empty decisions gracefully', () => {
    const noDecisions = { ...summary, decisions: [] }
    const card = buildApprovalCard({ planId: 'p', projectDir: '/p', summary: noDecisions, requesterName: 'S', expiresAt: new Date().toISOString() })
    expect(JSON.stringify(card)).toContain('None recorded')
  })

  it('sets approve action verb to "approve"', () => {
    const card = buildApprovalCard({ planId: 'p', projectDir: '/p', summary, requesterName: 'S', expiresAt: new Date().toISOString() })
    const actions = card.actions as Array<{ verb?: string; title: string }>
    const approve = actions.find(a => a.title.includes('Approve'))
    expect(approve?.verb).toBe('approve')
  })

  it('sets reject action verb to "reject"', () => {
    const card = buildApprovalCard({ planId: 'p', projectDir: '/p', summary, requesterName: 'S', expiresAt: new Date().toISOString() })
    const actions = card.actions as Array<{ verb?: string; title: string; card?: unknown }>
    // Direct reject button and ShowCard both have verb reject
    const rejectAction = actions.find(a => a.title === '❌ Reject')
    expect(rejectAction?.verb).toBe('reject')
  })
})

// ─── buildApprovedCard ────────────────────────────────────────────────────────

describe('buildApprovedCard', () => {
  it('shows approved status', () => {
    const card = buildApprovedCard('plan-1', 'Sarah')
    expect(JSON.stringify(card)).toContain('Approved')
  })

  it('shows the approver name', () => {
    const card = buildApprovedCard('plan-1', 'Sarah')
    expect(JSON.stringify(card)).toContain('Sarah')
  })

  it('includes the plan ID', () => {
    const card = buildApprovedCard('plan-xyz', 'Ahmed')
    expect(JSON.stringify(card)).toContain('plan-xyz')
  })

  it('has no action buttons (read-only after approval)', () => {
    const card = buildApprovedCard('plan-1', 'Sarah')
    expect(card.actions).toBeUndefined()
  })
})

// ─── buildRejectedCard ────────────────────────────────────────────────────────

describe('buildRejectedCard', () => {
  it('shows rejected status', () => {
    const card = buildRejectedCard('plan-1', 'Bob', 'Wrong approach')
    expect(JSON.stringify(card)).toContain('Rejected')
  })

  it('shows the rejection reason when provided', () => {
    const card = buildRejectedCard('plan-1', 'Bob', 'Wrong approach')
    expect(JSON.stringify(card)).toContain('Wrong approach')
  })

  it('works without a rejection reason', () => {
    expect(() => buildRejectedCard('plan-1', 'Bob')).not.toThrow()
  })

  it('includes the rejector name', () => {
    const card = buildRejectedCard('plan-1', 'Charlie')
    expect(JSON.stringify(card)).toContain('Charlie')
  })
})

// ─── buildProgressCard ───────────────────────────────────────────────────────

describe('buildProgressCard', () => {
  it('shows error styling for failure status', () => {
    const card = buildProgressCard('p1', 'Build failed', 'Compilation error in auth.ts')
    expect(JSON.stringify(card)).toContain('❌')
  })

  it('shows success styling for done status', () => {
    const card = buildProgressCard('p1', 'Build complete', 'PR #47 opened')
    expect(JSON.stringify(card)).toContain('✅')
  })

  it('shows gear for in-progress status', () => {
    const card = buildProgressCard('p1', 'Running tests', 'Phase 5 of 6')
    expect(JSON.stringify(card)).toContain('⚙️')
  })

  it('includes the detail text', () => {
    const card = buildProgressCard('p1', 'Done', 'PR #47 opened. 4 tests passing.')
    expect(JSON.stringify(card)).toContain('PR #47 opened')
  })

  it('includes plan ID', () => {
    const card = buildProgressCard('plan-unique-id', 'Done', '')
    expect(JSON.stringify(card)).toContain('plan-unique-id')
  })
})
