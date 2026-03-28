/**
 * Collaboration API routes
 *
 * POST /api/collaboration/plan     — summarize chat + create plan.md
 * GET  /api/collaboration/plan/:id — get plan request state
 * POST /api/collaboration/approve  — approve a plan
 * POST /api/collaboration/reject   — reject a plan
 * GET  /api/collaboration/plans    — list pending plans for a project
 * POST /api/collaboration/story    — create user story from discussion
 */

import { Router } from 'express'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import {
  summarizeConversation,
  buildPlanMarkdown,
  buildTaskMarkdown,
  createApprovalRequest,
  recordApproval,
  recordRejection,
  formatApprovalStatus,
  CollaborationStore,
  type ChatMessage,
  type PlanRequest,
} from '@quorum/collaboration'
import { verifyToken, type AuthRequest } from '../middleware/auth.js'
import { getSocketServer } from '../services/session-runner.js'
import { callLLM } from '../services/llm.js'

export const collaborationRouter = Router()

// ── Schemas ────────────────────────────────────────────────────────────────────

const PlanSchema = z.object({
  project_dir: z.string().min(1),
  messages: z.array(z.object({
    id: z.string(),
    author: z.string(),
    author_id: z.string(),
    content: z.string(),
    timestamp: z.string(),
    thread_id: z.string().optional(),
    is_bot: z.boolean().optional()
  })),
  channel_id: z.string(),
  platform: z.enum(['teams', 'slack', 'discord', 'telegram']),
  required_approvers: z.array(z.string()).default([]),
  quorum: z.enum(['all', 'majority', 'lead', 'any']).default('any')
})

const ApproveSchema = z.object({
  plan_id: z.string(),
  project_dir: z.string()
})

const RejectSchema = z.object({
  plan_id: z.string(),
  project_dir: z.string(),
  reason: z.string().optional()
})


// ── POST /api/collaboration/plan ──────────────────────────────────────────────

collaborationRouter.post('/plan', verifyToken, async (req: AuthRequest, res) => {
  const parse = PlanSchema.safeParse(req.body)
  if (!parse.success) {
    res.status(400).json({ error: parse.error.flatten() })
    return
  }

  const { project_dir, messages, channel_id, platform, required_approvers, quorum } = parse.data
  const userId = req.user!.id

  try {
    const store = new CollaborationStore(project_dir)
    await store.ensureDir()
    const config = await store.getConfig()

    // Summarize conversation
    const summary = await summarizeConversation(
      messages as ChatMessage[],
      (prompt) => callLLM(userId, prompt)
    )

    // Build plan.md + task.md content
    const planMd = buildPlanMarkdown(summary, project_dir)
    const taskMd = buildTaskMarkdown(summary)

    // Create plan request
    const planId = nanoid(10)
    const plan: PlanRequest = {
      id: planId,
      project_dir,
      summary,
      chat_messages: messages as ChatMessage[],
      requester_id: userId,
      channel_id,
      platform,
      created_at: new Date().toISOString(),
      status: 'pending_approval',
      plan_md: planMd,
      task_md: taskMd
    }

    // Create approval request
    const effectiveQuorum = quorum ?? config.quorum
    const approvers = required_approvers.length > 0 ? required_approvers : [userId]
    const approval = createApprovalRequest(
      planId,
      approvers,
      effectiveQuorum,
      config.approval_timeout_hours
    )

    // Persist
    await store.savePlanRequest(plan)
    await store.saveApproval(approval)
    await store.saveChatSummary(planId, `# Summary — ${planId}\n\n${summary.context}`)
    await store.appendAudit({
      event: 'plan_created',
      plan_id: planId,
      user_id: userId,
      details: summary.context,
      timestamp: new Date().toISOString()
    })

    res.json({
      plan_id: planId,
      summary,
      plan_md: planMd,
      task_md: taskMd,
      approval_status: formatApprovalStatus(approval),
      pending_approvers: approvers
    })
  } catch (err) {
    console.error('collaboration/plan error:', err)
    res.status(500).json({ error: (err as Error).message })
  }
})

// ── GET /api/collaboration/plan/:id ──────────────────────────────────────────

collaborationRouter.get('/plan/:id', verifyToken, async (req: AuthRequest, res) => {
  const { project_dir } = req.query as { project_dir?: string }
  if (!project_dir) { res.status(400).json({ error: 'project_dir required' }); return }

  const store = new CollaborationStore(project_dir)
  const plan = await store.getPlanRequest(req.params['id']!)
  if (!plan) { res.status(404).json({ error: 'Plan not found' }); return }

  const approval = await store.getApproval(req.params['id']!)
  res.json({ plan, approval_status: approval ? formatApprovalStatus(approval) : null })
})

// ── POST /api/collaboration/approve ──────────────────────────────────────────

collaborationRouter.post('/approve', verifyToken, async (req: AuthRequest, res) => {
  const parse = ApproveSchema.safeParse(req.body)
  if (!parse.success) { res.status(400).json({ error: parse.error.flatten() }); return }

  const { plan_id, project_dir } = parse.data
  const userId = req.user!.id

  try {
    const store = new CollaborationStore(project_dir)
    const plan = await store.getPlanRequest(plan_id)
    if (!plan) { res.status(404).json({ error: 'Plan not found' }); return }

    let approval = await store.getApproval(plan_id)
    if (!approval) { res.status(404).json({ error: 'Approval not found' }); return }

    approval = recordApproval(approval, userId)
    await store.saveApproval(approval)

    await store.appendAudit({
      event: 'approved',
      plan_id,
      user_id: userId,
      timestamp: new Date().toISOString()
    })

    // Write plan.md + task.md to .quorum/ when approved
    if (approval.status === 'approved') {
      if (plan.plan_md) await store.writePlanMd(project_dir, plan.plan_md)
      if (plan.task_md) await store.writeTaskMd(project_dir, plan.task_md)

      // Update plan status
      plan.status = 'approved'
      await store.savePlanRequest(plan)

      // Emit socket event so web UI updates live
      const io = getSocketServer()
      io?.emit('collaboration:approved', { plan_id, project_dir })
    }

    res.json({
      status: approval.status,
      approval_status: formatApprovalStatus(approval),
      plan_ready: approval.status === 'approved',
      summary: approval.status === 'approved' ? plan.summary : undefined
    })
  } catch (err) {
    console.error('collaboration/approve error:', err)
    res.status(500).json({ error: (err as Error).message })
  }
})

// ── POST /api/collaboration/reject ───────────────────────────────────────────

collaborationRouter.post('/reject', verifyToken, async (req: AuthRequest, res) => {
  const parse = RejectSchema.safeParse(req.body)
  if (!parse.success) { res.status(400).json({ error: parse.error.flatten() }); return }

  const { plan_id, project_dir, reason } = parse.data
  const userId = req.user!.id

  try {
    const store = new CollaborationStore(project_dir)
    let approval = await store.getApproval(plan_id)
    if (!approval) { res.status(404).json({ error: 'Approval not found' }); return }

    approval = recordRejection(approval, userId, reason)
    await store.saveApproval(approval)

    const plan = await store.getPlanRequest(plan_id)
    if (plan) {
      plan.status = 'rejected'
      await store.savePlanRequest(plan)
    }

    await store.appendAudit({
      event: 'rejected',
      plan_id,
      user_id: userId,
      details: reason,
      timestamp: new Date().toISOString()
    })

    res.json({ status: 'rejected', reason })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// ── GET /api/collaboration/plans ─────────────────────────────────────────────

collaborationRouter.get('/plans', verifyToken, async (req: AuthRequest, res) => {
  const { project_dir } = req.query as { project_dir?: string }
  if (!project_dir) { res.status(400).json({ error: 'project_dir required' }); return }

  // List all pending approval files for this project
  const { readdir } = await import('fs/promises')
  const { existsSync } = await import('fs')
  const { join } = await import('path')
  const approvalsDir = join(project_dir, '.atlas', 'collaboration', 'approvals')

  if (!existsSync(approvalsDir)) {
    res.json({ plans: [] })
    return
  }

  const files = await readdir(approvalsDir)
  const planFiles = files.filter(f => f.endsWith('-plan.json'))
  const store = new CollaborationStore(project_dir)

  const plans = await Promise.all(
    planFiles.map(async (f) => {
      const id = f.replace('-plan.json', '')
      const plan = await store.getPlanRequest(id)
      const approval = await store.getApproval(id)
      return { plan, approval_status: approval ? formatApprovalStatus(approval) : null }
    })
  )

  res.json({ plans: plans.filter(p => p.plan !== null) })
})

// ── POST /api/collaboration/story ─────────────────────────────────────────────
// Create a user story from a team discussion (no approval needed — just output)

const StorySchema = z.object({
  messages: z.array(z.object({
    id: z.string(),
    author: z.string(),
    author_id: z.string(),
    content: z.string(),
    timestamp: z.string()
  })),
  context_hint: z.string().optional()  // optional extra context ("this is for mobile app")
})

collaborationRouter.post('/story', verifyToken, async (req: AuthRequest, res) => {
  const parse = StorySchema.safeParse(req.body)
  if (!parse.success) {
    res.status(400).json({ error: parse.error.flatten() })
    return
  }

  const { messages, context_hint } = parse.data
  const userId = req.user!.id

  if (messages.length < 2) {
    res.status(400).json({ error: 'Need at least 2 messages to create a user story' })
    return
  }

  try {
    const transcript = messages
      .filter(m => !m.author.toLowerCase().includes('atlas'))
      .map(m => `[${m.author}]: ${m.content}`)
      .join('\n')

    const prompt = `You are the QUORUM Story Writer. Read this team discussion and create user stories.

${context_hint ? `CONTEXT: ${context_hint}\n\n` : ''}DISCUSSION:
${transcript}

Create user stories from this discussion.
If the discussion covers one feature: one story.
If it covers multiple features: multiple stories separated by ---.

Use this exact format for each story:

TITLE: [Short feature name — max 60 chars]

USER STORY:
As a [specific type of user],
I want to [do something specific],
So that [I get a specific benefit].

ACCEPTANCE CRITERIA:
- [ ] [Testable condition 1]
- [ ] [Testable condition 2]
- [ ] [Testable condition 3]

NOTES:
[Technical constraints or open questions, or "None"]

STORY POINTS: [1/2/3/5/8/13]
PRIORITY: [Critical/High/Medium/Low]
LABELS: [comma-separated]`

    const storyText = await callLLM(userId, prompt)
    const storyId = nanoid(10)

    res.json({
      story_id: storyId,
      story: storyText,
      message_count: messages.length
    })
  } catch (err) {
    console.error('collaboration/story error:', err)
    res.status(500).json({ error: (err as Error).message })
  }
})

// ── POST /api/collaboration/compact ──────────────────────────────────────────
// Summarize a raw transcript for /compact — secured by bot-secret only (no user JWT needed)

collaborationRouter.post('/compact', async (req, res) => {
  const secret = req.headers['x-bot-secret']
  if (secret !== process.env['BOT_SECRET']) {
    res.status(401).json({ error: 'Unauthorized' }); return
  }
  const { prompt } = req.body as { prompt?: string }
  if (!prompt) { res.status(400).json({ error: 'prompt required' }); return }

  // Use the server's own bot user for LLM calls (no user token needed)
  const botUserId = 'bot'
  try {
    const summary = await callLLM(botUserId, prompt)
    res.json({ summary })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})
