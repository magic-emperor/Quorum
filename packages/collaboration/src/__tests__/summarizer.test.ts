import { describe, it, expect, vi } from 'vitest'
import { summarizeConversation, buildPlanMarkdown, buildTaskMarkdown } from '../summarizer.js'
import type { ChatMessage, ConversationSummary } from '../types.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const goodMessages: ChatMessage[] = [
  { id: '1', author: 'Sarah', author_id: 'u1', content: 'We should switch from JWT to Redis sessions', timestamp: '2026-03-27T10:00:00Z' },
  { id: '2', author: 'Ahmed', author_id: 'u2', content: 'Agreed. JWT tokens are getting stolen in XSS attacks', timestamp: '2026-03-27T10:01:00Z' },
  { id: '3', author: 'Sarah', author_id: 'u1', content: 'We need session expiry of 7 days and auto-refresh', timestamp: '2026-03-27T10:02:00Z' },
  { id: '4', author: 'Ahmed', author_id: 'u2', content: 'I will pick up this ticket PROJ-42', timestamp: '2026-03-27T10:03:00Z' },
]

const fullSummary: ConversationSummary = {
  decisions: ['Replace JWT with Redis sessions', 'Session expiry: 7 days with auto-refresh'],
  open_questions: ['Which Redis provider to use'],
  acceptance_criteria: ['User stays logged in for 7 days', 'Session refreshes automatically on activity'],
  assigned_to: 'Ahmed',
  context: 'Replacing JWT authentication with Redis sessions to fix XSS vulnerability.',
  ticket_ref: 'PROJ-42'
}

const emptySummary: ConversationSummary = {
  decisions: [],
  open_questions: [],
  acceptance_criteria: [],
  context: 'No decisions made yet.',
}

// ─── summarizeConversation ───────────────────────────────────────────────────

describe('summarizeConversation', () => {
  it('passes transcript to LLM and returns parsed JSON', async () => {
    const mockLLM = vi.fn().mockResolvedValue(JSON.stringify(fullSummary))
    const result = await summarizeConversation(goodMessages, mockLLM)

    expect(mockLLM).toHaveBeenCalledOnce()
    expect(result.decisions).toEqual(fullSummary.decisions)
    expect(result.context).toBe(fullSummary.context)
    expect(result.ticket_ref).toBe('PROJ-42')
  })

  it('excludes bot messages from the transcript', async () => {
    const messagesWithBot: ChatMessage[] = [
      ...goodMessages,
      { id: '99', author: 'QUORUM Bot', author_id: 'bot', content: 'Creating plan...', timestamp: '2026-03-27T10:04:00Z', is_bot: true }
    ]
    const mockLLM = vi.fn().mockResolvedValue(JSON.stringify(fullSummary))
    await summarizeConversation(messagesWithBot, mockLLM)

    const prompt = mockLLM.mock.calls[0][0] as string
    expect(prompt).not.toContain('QUORUM Bot')
    expect(prompt).not.toContain('Creating plan...')
  })

  it('strips markdown fences from LLM response', async () => {
    const withFences = '```json\n' + JSON.stringify(fullSummary) + '\n```'
    const mockLLM = vi.fn().mockResolvedValue(withFences)
    const result = await summarizeConversation(goodMessages, mockLLM)
    expect(result.decisions).toHaveLength(2)
  })

  it('returns fallback structure when LLM returns invalid JSON', async () => {
    const mockLLM = vi.fn().mockResolvedValue('Sorry, I cannot summarize this.')
    const result = await summarizeConversation(goodMessages, mockLLM)

    expect(result.decisions).toEqual([])
    expect(result.open_questions).toEqual([])
    expect(result.acceptance_criteria).toEqual([])
    expect(result.context).toBeTruthy()  // fallback puts raw text in context
  })

  it('handles LLM throwing an error', async () => {
    const mockLLM = vi.fn().mockRejectedValue(new Error('API rate limit'))
    await expect(summarizeConversation(goodMessages, mockLLM)).rejects.toThrow('API rate limit')
  })

  it('includes all message content in the prompt', async () => {
    const mockLLM = vi.fn().mockResolvedValue(JSON.stringify(emptySummary))
    await summarizeConversation(goodMessages, mockLLM)

    const prompt = mockLLM.mock.calls[0][0] as string
    expect(prompt).toContain('switch from JWT to Redis sessions')  // raw message text
    expect(prompt).toContain('Sarah')
    expect(prompt).toContain('Ahmed')
  })
})

// ─── buildPlanMarkdown ───────────────────────────────────────────────────────

describe('buildPlanMarkdown', () => {
  it('includes context section', () => {
    const md = buildPlanMarkdown(fullSummary, '/projects/myapp')
    expect(md).toContain('## Context')
    expect(md).toContain(fullSummary.context)
  })

  it('includes decisions as bullet list', () => {
    const md = buildPlanMarkdown(fullSummary, '/projects/myapp')
    expect(md).toContain('## Decisions')
    for (const d of fullSummary.decisions) {
      expect(md).toContain(`- ${d}`)
    }
  })

  it('includes acceptance criteria as checkboxes', () => {
    const md = buildPlanMarkdown(fullSummary, '/projects/myapp')
    expect(md).toContain('## Acceptance Criteria')
    for (const ac of fullSummary.acceptance_criteria) {
      expect(md).toContain(`- [ ] ${ac}`)
    }
  })

  it('includes ticket reference when present', () => {
    const md = buildPlanMarkdown(fullSummary, '/projects/myapp')
    expect(md).toContain('PROJ-42')
  })

  it('includes assigned_to when present', () => {
    const md = buildPlanMarkdown(fullSummary, '/projects/myapp')
    expect(md).toContain('## Assigned To')
    expect(md).toContain('Ahmed')
  })

  it('omits empty sections', () => {
    const md = buildPlanMarkdown(emptySummary, '/projects/myapp')
    expect(md).not.toContain('## Decisions')
    expect(md).not.toContain('## Acceptance Criteria')
    expect(md).not.toContain('## Open Questions')
    expect(md).not.toContain('## Assigned To')
  })

  it('includes today\'s date', () => {
    const md = buildPlanMarkdown(fullSummary, '/projects/myapp')
    const today = new Date().toISOString().split('T')[0]
    expect(md).toContain(today)
  })
})

// ─── buildTaskMarkdown ────────────────────────────────────────────────────────

describe('buildTaskMarkdown', () => {
  it('produces checkboxes for acceptance criteria', () => {
    const md = buildTaskMarkdown(fullSummary)
    expect(md).toContain('## Done When')
    for (const ac of fullSummary.acceptance_criteria) {
      expect(md).toContain(`- [ ] ${ac}`)
    }
  })

  it('includes context as "what to build"', () => {
    const md = buildTaskMarkdown(fullSummary)
    expect(md).toContain('## What to Build')
    expect(md).toContain(fullSummary.context)
  })

  it('includes decisions as implementation notes', () => {
    const md = buildTaskMarkdown(fullSummary)
    expect(md).toContain('## Implementation Notes')
    expect(md).toContain('Replace JWT with Redis sessions')
  })

  it('starts with Pending execution status', () => {
    const md = buildTaskMarkdown(fullSummary)
    expect(md).toContain('Pending execution')
  })
})
