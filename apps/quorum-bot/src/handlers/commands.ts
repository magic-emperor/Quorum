import type { BotContext, BotMessage } from '../types.js'
import { approvalCard, approvedCard, rejectedCard } from '../cards/card-builder.js'

// ─── Shared command handlers ───────────────────────────────────────────────────
// All platform adapters call these after parsing their platform-specific events.
// The BotContext abstraction hides platform differences from handler logic.

const SERVER_URL = (process.env['QUORUM_SERVER_URL'] ?? 'http://localhost:3001').replace(/\/$/, '')
const BOT_SECRET = process.env['BOT_SECRET'] ?? ''

// ─── /atlas plan ──────────────────────────────────────────────────────────────

export async function handlePlan(ctx: BotContext, quorumToken: string): Promise<void> {
  const messages = ctx.getHistory(30).filter(m => !m.isBot)

  if (messages.length < 3) {
    await ctx.reply('💬 Not enough conversation to summarize yet.\n\nHave the team discuss the feature first, then call @QUORUM plan when ready.')
    return
  }

  const projectDir = process.env['DEFAULT_PROJECT_DIR'] ?? ''
  if (!projectDir) {
    await ctx.reply('⚠️ `DEFAULT_PROJECT_DIR` not set. Ask your admin to configure the bot.')
    return
  }

  await ctx.reply('⚙️ Analyzing conversation...')

  const resp = await fetch(`${SERVER_URL}/api/collaboration/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${quorumToken}`, 'x-bot-secret': BOT_SECRET },
    body: JSON.stringify({
      project_dir: projectDir,
      messages: messages.map(m => ({ id: m.id, author: m.author, author_id: m.authorId, content: m.text, timestamp: m.timestamp })),
      channel_id: ctx.channelId,
      platform: ctx.platform,
      quorum: 'any'
    })
  })

  const data = await resp.json() as {
    plan_id?: string; summary?: { context: string; decisions: string[]; acceptance_criteria: string[] }; error?: string
  }

  if (!resp.ok || !data.plan_id) {
    await ctx.reply(`❌ Failed to create plan: ${data.error ?? resp.statusText}`)
    return
  }

  const card = approvalCard({
    planId: data.plan_id,
    projectDir,
    summary: data.summary?.context ?? '',
    decisions: data.summary?.decisions ?? [],
    acceptanceCriteria: data.summary?.acceptance_criteria ?? [],
    requesterName: ctx.userName,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  })

  await ctx.replyCard(card)
}

// ─── /atlas story ─────────────────────────────────────────────────────────────

export async function handleStory(ctx: BotContext, quorumToken: string, contextHint?: string): Promise<void> {
  const messages = ctx.getHistory(30).filter(m => !m.isBot)

  if (messages.length < 2) {
    await ctx.reply('💬 Not enough conversation. Discuss the feature first, then call @QUORUM story.')
    return
  }

  await ctx.reply('✍️ Writing user story from discussion...')

  const resp = await fetch(`${SERVER_URL}/api/collaboration/story`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${quorumToken}`, 'x-bot-secret': BOT_SECRET },
    body: JSON.stringify({
      messages: messages.map(m => ({ id: m.id, author: m.author, author_id: m.authorId, content: m.text, timestamp: m.timestamp })),
      context_hint: contextHint
    })
  })

  const data = await resp.json() as { story_id?: string; story?: string; error?: string }

  if (!resp.ok || !data.story) {
    await ctx.reply(`❌ Failed to create story: ${data.error ?? resp.statusText}`)
    return
  }

  const stories = data.story.split(/\n---\n/).map(s => s.trim()).filter(Boolean)
  for (const story of stories) {
    await ctx.reply(`\`\`\`\n${story}\n\`\`\``)
  }
  await ctx.reply(`📋 Story ID: \`${data.story_id}\` — Copy into Jira / Linear / Azure Boards.`)
}

// ─── Approval button handler ──────────────────────────────────────────────────

export async function handleApprove(
  ctx: BotContext,
  quorumToken: string,
  planId: string,
  projectDir: string,
  messageIdToUpdate?: string
): Promise<void> {
  const resp = await fetch(`${SERVER_URL}/api/collaboration/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${quorumToken}`, 'x-bot-secret': BOT_SECRET },
    body: JSON.stringify({ plan_id: planId, project_dir: projectDir })
  })

  const data = await resp.json() as {
    plan_ready?: boolean
    approval_status?: string
    summary?: { context: string; decisions: string[]; acceptance_criteria: string[] }
    error?: string
  }

  if (!resp.ok) {
    await ctx.reply(`❌ Approval failed: ${data.error ?? resp.statusText}`)
    return
  }

  if (data.plan_ready) {
    if (messageIdToUpdate) {
      await ctx.updateCard(messageIdToUpdate, approvedCard(planId, ctx.userName))
    }

    // Build description from summary so atlas knows what to actually do
    let description = `Execute approved plan ${planId}`
    if (data.summary) {
      const parts = [data.summary.context]
      if (data.summary.decisions.length > 0) parts.push('Decisions: ' + data.summary.decisions.join('; '))
      if (data.summary.acceptance_criteria.length > 0) parts.push('Done when: ' + data.summary.acceptance_criteria.join('; '))
      description = parts.join('. ')
    }

    const execResp = await fetch(`${SERVER_URL}/api/sessions/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${quorumToken}` },
      body: JSON.stringify({ command: 'fast', description, project_dir: projectDir, auto: true })
    })

    if (execResp.ok) {
      const execData = await execResp.json() as { session_id?: string }
      await ctx.reply(`▶️ Execution started. Session: \`${execData.session_id}\``)
    } else {
      await ctx.reply('⚠️ Plan approved but execution trigger failed.')
    }
  } else {
    await ctx.reply(`✅ Your approval recorded. ${data.approval_status ?? ''}`)
  }
}

export async function handleReject(
  ctx: BotContext,
  quorumToken: string,
  planId: string,
  projectDir: string,
  reason?: string,
  messageIdToUpdate?: string
): Promise<void> {
  await fetch(`${SERVER_URL}/api/collaboration/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${quorumToken}`, 'x-bot-secret': BOT_SECRET },
    body: JSON.stringify({ plan_id: planId, project_dir: projectDir, reason })
  })

  if (messageIdToUpdate) {
    const card = rejectedCard(planId, ctx.userName, reason)
    await ctx.updateCard(messageIdToUpdate, card)
  }

  await ctx.reply('❌ Plan rejected. Continue discussing and call @QUORUM plan again after changes.')
}

// ─── /atlas status ────────────────────────────────────────────────────────────

export async function handleStatus(ctx: BotContext, quorumToken: string | null): Promise<void> {
  if (!quorumToken) {
    await ctx.reply('❌ Not linked. Type `@QUORUM login` to connect your account.')
    return
  }
  await ctx.reply('✅ QUORUM account linked. Ready to create and execute plans.')
}

// ─── /atlas help ─────────────────────────────────────────────────────────────

export async function handleHelp(ctx: BotContext): Promise<void> {
  await ctx.reply([
    '**QUORUM Bot**',
    '',
    '`@QUORUM plan` — Summarize discussion → plan.md → approval → execute',
    '`@QUORUM story` — Summarize discussion → user story for Jira/Linear/Azure',
    '`@QUORUM story for <context>` — Story with extra context',
    '`@QUORUM watch [tool] [keyword]` — Monitor PM tool for tickets → auto-plan',
    '`@QUORUM watch stop` — Stop PM tool watcher',
    '`@QUORUM compact` — Summarize and compress conversation history',
    '`@QUORUM stop` — Interrupt running execution',
    '`@QUORUM status` — Check account and session status',
    '`@QUORUM login` — Link your QUORUM Console account',
    '`@QUORUM logout` — Unlink your QUORUM account from this chat',
    '`@QUORUM help` — Show this message'
  ].join('\n'))
}

// ─── /compact ────────────────────────────────────────────────────────────────

export async function handleCompact(ctx: BotContext): Promise<void> {
  const messages = ctx.getHistory(50).filter(m => !m.isBot)
  if (messages.length < 3) {
    await ctx.reply('💬 Not enough history to compact yet.')
    return
  }

  await ctx.reply('🗜️ Compacting conversation history...')

  const transcript = messages.map(m => `[${m.author}]: ${m.text}`).join('\n')
  const prompt = `Summarize this team conversation into 4-6 concise bullet points capturing the key decisions, context, and any open questions. Be factual and brief.\n\n${transcript}`

  try {
    const resp = await fetch(`${SERVER_URL}/api/collaboration/compact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
      body: JSON.stringify({ prompt })
    })
    const data = await resp.json() as { summary?: string; error?: string }
    if (!resp.ok || !data.summary) throw new Error(data.error ?? 'No summary returned')

    const summaryMsg: BotMessage = {
      id: `compact-${Date.now()}`,
      text: `[Compacted summary]\n${data.summary}`,
      author: 'QUORUM',
      authorId: 'quorum-bot',
      channelId: ctx.channelId,
      platform: ctx.platform,
      timestamp: new Date().toISOString(),
      isBot: true
    }
    ctx.replaceHistory([summaryMsg])
    await ctx.reply(`✅ History compacted (${messages.length} messages → 1 summary).\n\n${data.summary}`)
  } catch (err) {
    await ctx.reply(`❌ Compact failed: ${(err as Error).message}`)
  }
}

// ─── /atlas logout ───────────────────────────────────────────────────────────

export async function handleLogout(ctx: BotContext, platformUserId: string): Promise<void> {
  try {
    const resp = await fetch(`${SERVER_URL}/api/auth/${ctx.platform}/unlink`, {
      method: 'DELETE',
      headers: { 'x-bot-secret': BOT_SECRET, [`x-${ctx.platform}-user-id`]: platformUserId }
    })
    if (resp.ok) {
      await ctx.reply('👋 Logged out. Your QUORUM account has been unlinked.\n\nUse `/login` to reconnect.')
    } else {
      await ctx.reply('⚠️ You were not linked — nothing to log out from.')
    }
  } catch {
    await ctx.reply('❌ Could not reach QUORUM server.')
  }
}

// ─── Token lookup ─────────────────────────────────────────────────────────────

export async function getQuorumToken(platform: string, platformUserId: string): Promise<string | null> {
  try {
    const resp = await fetch(`${SERVER_URL}/api/auth/${platform}/bot-status`, {
      headers: { 'x-bot-secret': BOT_SECRET, [`x-${platform}-user-id`]: platformUserId }
    })
    if (!resp.ok) return null
    const data = await resp.json() as { token?: string }
    return data.token ?? null
  } catch {
    return null
  }
}
