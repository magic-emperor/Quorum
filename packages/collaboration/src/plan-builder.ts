import type { ConversationSummary, PlanRequest, ChatMessage, Platform, ApprovalQuorum } from './types.js'
import { buildPlanMarkdown, buildTaskMarkdown } from './summarizer.js'
import { CollaborationStore } from './quorum-folder.js'
import { createApprovalRequest } from './approval-manager.js'
import { nanoid } from 'nanoid'

// ─── Plan Builder ─────────────────────────────────────────────────────────────
// Orchestrates the full plan creation flow:
//   1. Optionally merges acceptance criteria from a PM ticket
//   2. Builds plan.md and task.md from the conversation summary
//   3. Persists everything to .quorum/collaboration/
//   4. Returns the PlanRequest ready for the approval workflow

export interface PMTicketData {
  ticket_id: string
  title: string
  description?: string
  acceptance_criteria?: string[]
  url?: string
}

export interface BuildPlanOptions {
  projectDir: string
  summary: ConversationSummary
  messages: ChatMessage[]
  requesterId: string
  channelId: string
  platform: Platform
  quorum?: ApprovalQuorum
  requiredApprovers?: string[]
  pmTicket?: PMTicketData     // optional: merge AC from PM tool ticket
  timeoutHours?: number
}

export interface BuildPlanResult {
  plan: PlanRequest
  planMd: string
  taskMd: string
  approvalId: string
}

export async function buildPlan(opts: BuildPlanOptions): Promise<BuildPlanResult> {
  const {
    projectDir,
    summary,
    messages,
    requesterId,
    channelId,
    platform,
    quorum = 'any',
    requiredApprovers = [],
    pmTicket,
    timeoutHours = 24
  } = opts

  // Merge PM ticket acceptance criteria into summary if provided
  const enrichedSummary: ConversationSummary = pmTicket?.acceptance_criteria?.length
    ? {
        ...summary,
        acceptance_criteria: [
          ...summary.acceptance_criteria,
          ...pmTicket.acceptance_criteria.filter(ac => !summary.acceptance_criteria.includes(ac))
        ],
        ticket_ref: pmTicket.ticket_id ?? summary.ticket_ref
      }
    : summary

  const planId = nanoid()

  // Build markdown content
  const planMd = buildPlanMarkdown(enrichedSummary, projectDir)
  const taskMd = buildTaskMarkdown(enrichedSummary)

  // Create the plan request
  const plan: PlanRequest = {
    id: planId,
    project_dir: projectDir,
    summary: enrichedSummary,
    chat_messages: messages,
    requester_id: requesterId,
    channel_id: channelId,
    platform,
    created_at: new Date().toISOString(),
    status: 'pending_approval',
    plan_md: planMd,
    task_md: taskMd
  }

  // Create the approval request
  const approval = createApprovalRequest(planId, requiredApprovers, quorum, timeoutHours)

  // Persist to .quorum/
  const store = new CollaborationStore(projectDir)
  await store.ensureDir()
  await store.savePlanRequest(plan)
  await store.saveApproval(approval)

  // Save chat summary as markdown
  const summaryMd = buildChatSummaryMarkdown(enrichedSummary, messages, pmTicket)
  await store.saveChatSummary(planId, summaryMd)

  // Audit
  await store.appendAudit({
    event: 'plan_created',
    plan_id: planId,
    user_id: requesterId,
    details: `platform=${platform} quorum=${quorum} ticket=${enrichedSummary.ticket_ref ?? 'none'}`,
    timestamp: new Date().toISOString()
  })

  return { plan, planMd, taskMd, approvalId: planId }
}

// ─── Execute an approved plan ─────────────────────────────────────────────────
// Writes plan.md and task.md to .quorum/ root and marks the plan as executing.

export async function executePlan(
  projectDir: string,
  planId: string,
  approverId: string
): Promise<{ planMdPath: string; taskMdPath: string }> {
  const store = new CollaborationStore(projectDir)
  const plan = await store.getPlanRequest(planId)

  if (!plan) throw new Error(`Plan ${planId} not found`)
  if (!plan.plan_md || !plan.task_md) throw new Error(`Plan ${planId} has no markdown content`)

  // Write to .quorum/ root so quorum fast can read them
  const planMdPath = await store.writePlanMd(projectDir, plan.plan_md)
  const taskMdPath = await store.writeTaskMd(projectDir, plan.task_md)

  // Update plan status
  const updated: PlanRequest = { ...plan, status: 'executing' }
  await store.savePlanRequest(updated)

  await store.appendAudit({
    event: 'plan_executing',
    plan_id: planId,
    user_id: approverId,
    details: `plan.md written to ${planMdPath}`,
    timestamp: new Date().toISOString()
  })

  return { planMdPath, taskMdPath }
}

// ─── Mark plan as done / failed ───────────────────────────────────────────────

export async function completePlan(
  projectDir: string,
  planId: string,
  result: 'done' | 'failed',
  details?: string
): Promise<void> {
  const store = new CollaborationStore(projectDir)
  const plan = await store.getPlanRequest(planId)
  if (!plan) return

  const updated: PlanRequest = { ...plan, status: result }
  await store.savePlanRequest(updated)

  await store.appendAudit({
    event: `plan_${result}`,
    plan_id: planId,
    details: details ?? result,
    timestamp: new Date().toISOString()
  })
}

// ─── Build chat summary markdown ──────────────────────────────────────────────

function buildChatSummaryMarkdown(
  summary: ConversationSummary,
  messages: ChatMessage[],
  pmTicket?: PMTicketData
): string {
  const date = new Date().toISOString().split('T')[0]
  const lines: string[] = [
    `# Chat Summary`,
    ``,
    `**Date:** ${date}`,
  ]

  if (summary.ticket_ref) lines.push(`**Ticket:** ${summary.ticket_ref}`)
  if (pmTicket?.url) lines.push(`**Ticket URL:** ${pmTicket.url}`)

  lines.push(``, `## Context`, ``, summary.context, ``)

  if (summary.decisions.length > 0) {
    lines.push(`## Decisions`, ``)
    summary.decisions.forEach(d => lines.push(`- ${d}`))
    lines.push(``)
  }

  if (summary.acceptance_criteria.length > 0) {
    lines.push(`## Acceptance Criteria`, ``)
    summary.acceptance_criteria.forEach(ac => lines.push(`- ${ac}`))
    lines.push(``)
  }

  if (summary.open_questions.length > 0) {
    lines.push(`## Open Questions`, ``)
    summary.open_questions.forEach(q => lines.push(`- ${q}`))
    lines.push(``)
  }

  lines.push(`## Raw Conversation (${messages.length} messages)`, ``)
  messages.slice(-20).forEach(m => {
    const time = new Date(m.timestamp).toLocaleTimeString()
    lines.push(`**${m.author}** [${time}]: ${m.content}`)
  })

  return lines.join('\n')
}
