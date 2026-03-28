/**
 * Tests for bot command routing logic.
 * Uses manual mocking — no real Teams connection needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock quorum-client before importing bot ──────────────────────────────────

vi.mock('../quorum-client.js', () => ({
  createPlan: vi.fn(),
  approvePlan: vi.fn(),
  rejectPlan: vi.fn(),
  getQuorumToken: vi.fn().mockResolvedValue('mock-quorum-token'),
  triggerExecution: vi.fn(),
  createStory: vi.fn()
}))

import * as atlasClient from '../quorum-client.js'

// ─── Command routing pure-logic tests ────────────────────────────────────────
// We test the routing rules without instantiating the full TeamsActivityHandler,
// since that requires Bot Framework adapters and Azure credentials.

describe('Command routing rules', () => {
  const commands = [
    { input: '@quorum plan',         expected: 'plan' },
    { input: '@QUORUM plan',         expected: 'plan' },
    { input: '@QUORUM PLAN',         expected: 'plan' },
    { input: '/quorum plan',         expected: 'plan' },
    { input: '@quorum story',        expected: 'story' },
    { input: '@QUORUM story',        expected: 'story' },
    { input: '@quorum story for mobile app', expected: 'story' },
    { input: '@quorum status',       expected: 'status' },
    { input: '@QUORUM STATUS',       expected: 'status' },
    { input: '@quorum help',         expected: 'help' },
    { input: '/quorum help',         expected: 'help' },
    { input: '/start',              expected: 'help' },
    { input: '@quorum login',        expected: 'login' },
    { input: 'Hello team!',         expected: null },
    { input: 'We should use Redis', expected: null },
  ]

  function route(text: string): string | null {
    const lower = text.toLowerCase()
    if (lower.startsWith('@quorum plan') || lower === '/quorum plan')   return 'plan'
    if (lower.startsWith('@quorum story') || lower === '/quorum story') return 'story'
    if (lower.startsWith('@quorum status') || lower === '/quorum status') return 'status'
    if (lower.startsWith('@quorum help') || lower === '/quorum help' || lower === '/start') return 'help'
    if (lower.startsWith('@quorum login') || lower === '/quorum login') return 'login'
    return null
  }

  for (const { input, expected } of commands) {
    it(`"${input}" → ${expected ?? 'no command'}`, () => {
      expect(route(input)).toBe(expected)
    })
  }
})

// ─── Story hint extraction ────────────────────────────────────────────────────

describe('Story context hint extraction', () => {
  function extractHint(text: string): string | undefined {
    const hint = text.replace(/@quorum story\s*/i, '').trim()
    return hint || undefined
  }

  it('extracts hint after "@quorum story"', () => {
    expect(extractHint('@quorum story for mobile app')).toBe('for mobile app')
  })

  it('returns undefined when no hint', () => {
    expect(extractHint('@quorum story')).toBeUndefined()
  })

  it('handles mixed case', () => {
    expect(extractHint('@QUORUM Story for the web dashboard')).toBe('for the web dashboard')
  })

  it('trims whitespace', () => {
    expect(extractHint('@quorum story   ')).toBeUndefined()
  })
})

// ─── Card action data shape ───────────────────────────────────────────────────

describe('Card action data validation', () => {
  function isValidCardData(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false
    const d = data as Record<string, unknown>
    return typeof d['action'] === 'string' &&
           typeof d['plan_id'] === 'string' &&
           typeof d['project_dir'] === 'string'
  }

  it('accepts valid approve action', () => {
    expect(isValidCardData({ action: 'approve', plan_id: 'plan-1', project_dir: '/p' })).toBe(true)
  })

  it('accepts valid reject action', () => {
    expect(isValidCardData({ action: 'reject', plan_id: 'plan-1', project_dir: '/p' })).toBe(true)
  })

  it('accepts reject with optional reason', () => {
    expect(isValidCardData({ action: 'reject', plan_id: 'p', project_dir: '/p', rejection_reason: 'Bad plan' })).toBe(true)
  })

  it('rejects missing plan_id', () => {
    expect(isValidCardData({ action: 'approve', project_dir: '/p' })).toBe(false)
  })

  it('rejects missing project_dir', () => {
    expect(isValidCardData({ action: 'approve', plan_id: 'p' })).toBe(false)
  })

  it('rejects null', () => {
    expect(isValidCardData(null)).toBe(false)
  })
})

// ─── Atlas client mock contracts ─────────────────────────────────────────────

describe('quorum-client mock contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getQuorumToken returns a token', async () => {
    const token = await quorumClient.getQuorumToken('teams-user-123')
    expect(token).toBe('mock-quorum-token')
  })

  it('createPlan can be mocked with expected return shape', async () => {
    const mockResult = {
      plan_id: 'p-abc',
      summary: {
        context: 'Auth rewrite',
        decisions: ['Use Redis'],
        acceptance_criteria: ['Login works'],
        open_questions: [],
        ticket_ref: null,
        assigned_to: null
      },
      plan_md: '# Plan',
      task_md: '# Task',
      approval_status: '⏳ Waiting (0/1)',
      pending_approvers: ['user-1']
    }
    vi.mocked(quorumClient.createPlan).mockResolvedValue(mockResult)

    const result = await quorumClient.createPlan('token', '/p', [], 'channel-1', 'teams')
    expect(result.plan_id).toBe('p-abc')
    expect(result.summary.decisions).toContain('Use Redis')
  })

  it('approvePlan can be mocked returning plan_ready=true', async () => {
    vi.mocked(quorumClient.approvePlan).mockResolvedValue({
      status: 'approved',
      approval_status: '✅ Approved (1/1)',
      plan_ready: true
    })

    const result = await quorumClient.approvePlan('token', 'plan-1', '/p')
    expect(result.plan_ready).toBe(true)
    expect(result.status).toBe('approved')
  })

  it('rejectPlan can be mocked', async () => {
    vi.mocked(quorumClient.rejectPlan).mockResolvedValue({ status: 'rejected' })
    const result = await quorumClient.rejectPlan('token', 'plan-1', '/p', 'Wrong approach')
    expect(result.status).toBe('rejected')
  })

  it('createStory can be mocked with story text', async () => {
    vi.mocked(quorumClient.createStory).mockResolvedValue({
      story_id: 's-1',
      story: 'TITLE: Password reset\n\nUSER STORY:\nAs a user...'
    })
    const result = await quorumClient.createStory('token', [])
    expect(result.story).toContain('TITLE:')
  })
})
