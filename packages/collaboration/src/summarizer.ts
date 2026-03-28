import type { ChatMessage, ConversationSummary } from './types.js'

// ─── Summarizer ───────────────────────────────────────────────────────────────
// Sends conversation messages to the LLM and extracts structured decisions.
// Caller passes in a raw LLM function so this package stays provider-agnostic.

export type LLMCallFn = (prompt: string) => Promise<string>

export async function summarizeConversation(
  messages: ChatMessage[],
  callLLM: LLMCallFn
): Promise<ConversationSummary> {
  const transcript = messages
    .filter(m => !m.is_bot)
    .map(m => `[${m.author} @ ${new Date(m.timestamp).toLocaleTimeString()}]: ${m.content}`)
    .join('\n')

  const prompt = `You are analyzing a team conversation to extract implementation decisions.

CONVERSATION:
${transcript}

Extract the following as JSON. Be specific — capture actual decisions, not vague intentions.

{
  "decisions": [
    // Concrete things the team agreed to do.
    // Example: "Replace JWT with Redis session tokens"
    // NOT: "Improve the auth system"
  ],
  "open_questions": [
    // Things discussed but not resolved.
    // Example: "Which Redis provider to use — not decided"
  ],
  "acceptance_criteria": [
    // Specific conditions that define "done".
    // Infer these from the conversation if not explicitly stated.
    // Example: "User can log in with email/password"
    // Example: "Session persists across page refreshes"
  ],
  "assigned_to": "name of person who will do the work, or null if not mentioned",
  "context": "2-3 sentence summary of what is being built and why",
  "ticket_ref": "ticket ID if mentioned (e.g. PROJ-123, #456), or null"
}

Return ONLY valid JSON. No markdown, no explanation.`

  const raw = await callLLM(prompt)

  // Extract JSON object — works regardless of whether LLM wraps in ```json, ```, or nothing
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]) as ConversationSummary
    } catch { /* malformed JSON — fall through to fallback */ }
  }

  // Fallback: return minimal structure so the flow doesn't break
  return {
    decisions: [],
    open_questions: [],
    acceptance_criteria: [],
    context: raw.slice(0, 300),
    assigned_to: undefined,
    ticket_ref: undefined
  }
}

// ─── Build the plan.md content from a summary ────────────────────────────────

export function buildPlanMarkdown(summary: ConversationSummary, projectDir: string): string {
  const date = new Date().toISOString().split('T')[0]
  const lines: string[] = [
    `# Plan`,
    ``,
    `**Created:** ${date}`,
    `**Source:** Team discussion${summary.ticket_ref ? ` — ${summary.ticket_ref}` : ''}`,
    `**Project:** ${projectDir}`,
    ``,
    `## Context`,
    ``,
    summary.context,
    ``
  ]

  if (summary.decisions.length > 0) {
    lines.push(`## Decisions`, ``)
    for (const d of summary.decisions) {
      lines.push(`- ${d}`)
    }
    lines.push(``)
  }

  if (summary.acceptance_criteria.length > 0) {
    lines.push(`## Acceptance Criteria`, ``)
    for (const ac of summary.acceptance_criteria) {
      lines.push(`- [ ] ${ac}`)
    }
    lines.push(``)
  }

  if (summary.open_questions.length > 0) {
    lines.push(`## Open Questions`, ``)
    for (const q of summary.open_questions) {
      lines.push(`- ${q}`)
    }
    lines.push(``)
  }

  if (summary.assigned_to) {
    lines.push(`## Assigned To`, ``, summary.assigned_to, ``)
  }

  return lines.join('\n')
}

// ─── Build task.md from a summary ────────────────────────────────────────────

export function buildTaskMarkdown(summary: ConversationSummary): string {
  const date = new Date().toISOString().split('T')[0]
  const lines: string[] = [
    `# Task`,
    ``,
    `**Created:** ${date}`,
    `**Status:** Pending execution`,
    ``,
    `## What to Build`,
    ``,
    summary.context,
    ``
  ]

  if (summary.decisions.length > 0) {
    lines.push(`## Implementation Notes`, ``)
    for (const d of summary.decisions) {
      lines.push(`- ${d}`)
    }
    lines.push(``)
  }

  if (summary.acceptance_criteria.length > 0) {
    lines.push(`## Done When`, ``)
    for (const ac of summary.acceptance_criteria) {
      lines.push(`- [ ] ${ac}`)
    }
    lines.push(``)
  }

  return lines.join('\n')
}
