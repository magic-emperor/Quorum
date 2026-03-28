/**
 * HTTP client for the QUORUM server collaboration API.
 * The Teams bot calls these on behalf of authenticated users.
 */

const SERVER_URL = (process.env['QUORUM_SERVER_URL'] ?? 'http://localhost:3001').replace(/\/$/, '')
const BOT_SECRET = process.env['BOT_SECRET'] ?? ''

interface PlanResponse {
  plan_id: string
  summary: {
    context: string
    decisions: string[]
    acceptance_criteria: string[]
    open_questions: string[]
    assigned_to?: string
    ticket_ref?: string
  }
  plan_md: string
  task_md: string
  approval_status: string
  pending_approvers: string[]
  error?: string
}

interface ApprovalResponse {
  status: string
  approval_status: string
  plan_ready: boolean
  summary?: {
    context: string
    decisions: string[]
    acceptance_criteria: string[]
  }
  error?: string
}

/** POST /api/collaboration/plan — summarize messages + create plan */
export async function createPlan(
  quorumToken: string,
  projectDir: string,
  messages: Array<{ id: string; author: string; author_id: string; content: string; timestamp: string }>,
  channelId: string,
  platform: 'teams' | 'slack' | 'discord' | 'telegram',
  requiredApprovers: string[] = [],
  quorum: 'all' | 'majority' | 'lead' | 'any' = 'any'
): Promise<PlanResponse> {
  const resp = await fetch(`${SERVER_URL}/api/collaboration/plan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${quorumToken}`,
      'x-bot-secret': BOT_SECRET
    },
    body: JSON.stringify({
      project_dir: projectDir,
      messages,
      channel_id: channelId,
      platform,
      required_approvers: requiredApprovers,
      quorum
    })
  })

  const data = await resp.json() as PlanResponse
  if (!resp.ok) throw new Error(data.error ?? resp.statusText)
  return data
}

/** POST /api/collaboration/approve */
export async function approvePlan(
  quorumToken: string,
  planId: string,
  projectDir: string
): Promise<ApprovalResponse> {
  const resp = await fetch(`${SERVER_URL}/api/collaboration/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${quorumToken}`,
      'x-bot-secret': BOT_SECRET
    },
    body: JSON.stringify({ plan_id: planId, project_dir: projectDir })
  })

  const data = await resp.json() as ApprovalResponse
  if (!resp.ok) throw new Error(data.error ?? resp.statusText)
  return data
}

/** POST /api/collaboration/reject */
export async function rejectPlan(
  quorumToken: string,
  planId: string,
  projectDir: string,
  reason?: string
): Promise<{ status: string; error?: string }> {
  const resp = await fetch(`${SERVER_URL}/api/collaboration/reject`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${quorumToken}`,
      'x-bot-secret': BOT_SECRET
    },
    body: JSON.stringify({ plan_id: planId, project_dir: projectDir, reason })
  })

  const data = await resp.json() as { status: string; error?: string }
  if (!resp.ok) throw new Error(data.error ?? resp.statusText)
  return data
}

/** GET /api/auth/teams/bot-status — look up QUORUM token for a Teams user */
export async function getQuorumToken(teamsUserId: string): Promise<string | null> {
  try {
    const resp = await fetch(`${SERVER_URL}/api/auth/teams/bot-status`, {
      headers: { 'x-bot-secret': BOT_SECRET, 'x-teams-user-id': teamsUserId }
    })
    if (!resp.ok) return null
    const data = await resp.json() as { token?: string }
    return data.token ?? null
  } catch {
    // Server unreachable — bot still loads, commands will show "server down" message
    return null
  }
}

/** POST /api/collaboration/story — create user story from discussion */
export async function createStory(
  quorumToken: string,
  messages: Array<{ id: string; author: string; author_id: string; content: string; timestamp: string }>,
  contextHint?: string
): Promise<{ story_id: string; story: string; error?: string }> {
  const resp = await fetch(`${SERVER_URL}/api/collaboration/story`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${quorumToken}`,
      'x-bot-secret': BOT_SECRET
    },
    body: JSON.stringify({ messages, context_hint: contextHint })
  })

  const data = await resp.json() as { story_id: string; story: string; error?: string }
  if (!resp.ok) throw new Error(data.error ?? resp.statusText)
  return data
}

/** Trigger atlas fast execution after plan approval */
export async function triggerExecution(
  quorumToken: string,
  projectDir: string,
  planId: string,
  summary?: { context: string; decisions: string[]; acceptance_criteria: string[] }
): Promise<{ session_id: string; error?: string }> {
  // Build a concrete description from the plan summary so atlas knows what to do.
  // Fallback to plan ID only if summary is unavailable (should not happen post-approve).
  let description: string
  if (summary) {
    const parts = [summary.context]
    if (summary.decisions.length > 0) {
      parts.push('Decisions: ' + summary.decisions.join('; '))
    }
    if (summary.acceptance_criteria.length > 0) {
      parts.push('Done when: ' + summary.acceptance_criteria.join('; '))
    }
    description = parts.join('. ')
  } else {
    description = `Execute approved plan ${planId}`
  }

  const resp = await fetch(`${SERVER_URL}/api/sessions/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${quorumToken}`
    },
    body: JSON.stringify({
      command: 'fast',
      description,
      project_dir: projectDir,
      auto: true
    })
  })

  const data = await resp.json() as { session_id: string; error?: string }
  if (!resp.ok) throw new Error(data.error ?? resp.statusText)
  return data
}
