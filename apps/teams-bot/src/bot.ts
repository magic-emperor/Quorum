import {
  TeamsActivityHandler,
  TurnContext,
  CardFactory,
  MessageFactory,
  type InvokeResponse
} from 'botbuilder'
import { buildApprovalCard } from './cards/approval-card.js'
import { createPlan, approvePlan, rejectPlan, getQuorumToken, triggerExecution, createStory } from './quorum-client.js'
import { handleWatchCommand } from './handlers/watch.js'
import { handleStopCommand } from './handlers/stop.js'

// ─── In-memory store of Teams user → QUORUM token ─────────────────────────────
// In production this should be persisted (e.g. SQLite via quorum-server)
const tokenStore = new Map<string, string>()

// ─── Store last N messages per channel for /quorum plan ───────────────────────
const channelHistory = new Map<string, Array<{
  id: string; author: string; author_id: string; content: string; timestamp: string
}>>()
const MAX_HISTORY = 50

export class ATLASTeamsBot extends TeamsActivityHandler {

  constructor() {
    super()

    // ── Every message: store in channel history ──────────────────────────────
    this.onMessage(async (ctx, next) => {
      const msg = ctx.activity
      const channelId = msg.channelData?.['channel']?.['id'] ?? msg.conversation.id
      const author = msg.from.name ?? 'Unknown'
      const authorId = msg.from.id
      const text = msg.text?.trim() ?? ''

      if (text && !author.toLowerCase().includes('quorum')) {
        const history = channelHistory.get(channelId) ?? []
        history.push({
          id: msg.id ?? `${Date.now()}`,
          author,
          author_id: authorId,
          content: text,
          timestamp: typeof msg.timestamp === 'string' ? msg.timestamp : new Date().toISOString()
        })
        // Keep only last MAX_HISTORY messages
        if (history.length > MAX_HISTORY) history.shift()
        channelHistory.set(channelId, history)
      }

      // Handle Action.Submit from Adaptive Cards (emulator + Teams fallback)
      if (!text && msg.value && typeof msg.value === 'object') {
        await this.handleCardAction(ctx)
        await next()
        return
      }

      // Route commands
      const lower = text.toLowerCase()

      if (lower.startsWith('@quorum plan') || lower === '/quorum plan') {
        await this.handlePlanCommand(ctx, channelId)
      } else if (lower.startsWith('@quorum story') || lower === '/quorum story') {
        // Optional: "@quorum story for mobile app" passes hint after 'story'
        const hint = text.replace(/@quorum story\s*/i, '').trim() || undefined
        await this.handleStoryCommand(ctx, channelId, hint)
      } else if (lower.startsWith('@quorum status') || lower === '/quorum status') {
        await this.handleStatusCommand(ctx)
      } else if (lower.startsWith('@quorum help') || lower === '/quorum help' || lower === '/start') {
        await this.handleHelpCommand(ctx)
      } else if (lower.startsWith('@quorum logout') || lower === '/quorum logout') {
        await this.handleLogoutCommand(ctx)
      } else if (lower.startsWith('@quorum login') || lower === '/quorum login') {
        await this.handleLoginCommand(ctx)
      } else if (lower.startsWith('@quorum watch') || lower === '/atlas watch') {
        const args = text.replace(/@quorum watch\s*/i, '').trim()
        const quorumToken = await this.getToken(ctx.activity.from.id)
        if (!quorumToken) {
          await ctx.sendActivity('🔐 Link your QUORUM account first: type `@QUORUM login`')
        } else {
          await handleWatchCommand(ctx, channelId, quorumToken, args)
        }
      } else if (lower.startsWith('@quorum stop') || lower === '/quorum stop') {
        const args = text.replace(/@quorum stop\s*/i, '').trim() || undefined
        const quorumToken = await this.getToken(ctx.activity.from.id)
        if (!quorumToken) {
          await ctx.sendActivity('🔐 Link your QUORUM account first: type `@QUORUM login`')
        } else {
          await handleStopCommand(ctx, quorumToken, args)
        }
      }

      await next()
    })

    // handleTeamsCardActionInvoke is overridden below — no registration needed here

    this.onMembersAdded(async (ctx, next) => {
      for (const member of ctx.activity.membersAdded ?? []) {
        if (member.id !== ctx.activity.recipient.id) {
          await ctx.sendActivity(
            '👋 **QUORUM Bot installed!**\n\n' +
            'I turn team discussions into executed code.\n\n' +
            'Type `@QUORUM help` to get started.'
          )
        }
      }
      await next()
    })
  }

  // ── Teams card action invoke (Action.Execute — real Teams only) ──────────────

  override async handleTeamsCardActionInvoke(ctx: TurnContext): Promise<InvokeResponse> {
    await this.handleCardAction(ctx)
    return { status: 200, body: {} }
  }

  // ── /quorum plan ─────────────────────────────────────────────────────────────

  private async handlePlanCommand(ctx: TurnContext, channelId: string): Promise<void> {
    const userId = ctx.activity.from.id
    const quorumToken = await this.getToken(userId)

    if (!quorumToken) {
      await ctx.sendActivity(
        '🔐 You need to link your QUORUM account first.\n\n' +
        'Type `@QUORUM login` to connect.'
      )
      return
    }

    const messages = channelHistory.get(channelId) ?? []
    const relevant = messages.filter(m => !m.content.toLowerCase().startsWith('@quorum'))

    if (relevant.length < 3) {
      await ctx.sendActivity(
        '💬 Not enough conversation to summarize yet.\n\n' +
        'Have the team discuss the feature first, then call `@QUORUM plan` when ready.'
      )
      return
    }

    await ctx.sendActivity('⚙️ Analyzing conversation...')

    // Get project dir from activity or env fallback
    const projectDir = process.env['DEFAULT_PROJECT_DIR'] ?? ''
    if (!projectDir) {
      await ctx.sendActivity('⚠️ `DEFAULT_PROJECT_DIR` not set. Ask your admin to configure the bot.')
      return
    }

    try {
      const result = await createPlan(
        quorumToken,
        projectDir,
        relevant.slice(-30),  // last 30 messages
        channelId,
        'teams'
      )

      const card = buildApprovalCard({
        planId: result.plan_id,
        projectDir,
        summary: result.summary,
        requesterName: ctx.activity.from.name ?? 'Unknown',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      })

      await ctx.sendActivity(
        MessageFactory.attachment(CardFactory.adaptiveCard(card))
      )
    } catch (err) {
      await ctx.sendActivity(`❌ Failed to create plan: ${(err as Error).message}`)
    }
  }

  // ── Adaptive Card button handler ─────────────────────────────────────────────
  // Called from both Action.Submit (emulator) and Action.Execute (real Teams).
  // All responses go via ctx.sendActivity — never return values, never use ctx async.

  private async handleCardAction(ctx: TurnContext): Promise<void> {
    const data = ctx.activity.value as {
      action?: 'approve' | 'reject'
      plan_id?: string
      project_dir?: string
      rejection_reason?: string
    }

    if (!data?.action || !data?.plan_id || !data?.project_dir) {
      await ctx.sendActivity('⚠️ Invalid card data — missing action, plan_id, or project_dir.')
      return
    }

    const userId = ctx.activity.from.id
    const userName = ctx.activity.from.name ?? 'Unknown'
    const quorumToken = await this.getToken(userId)

    if (!quorumToken) {
      await ctx.sendActivity('🔐 Link your QUORUM account first: type `@QUORUM login`')
      return
    }

    if (data.action === 'approve') {
      try {
        const result = await approvePlan(quorumToken, data.plan_id, data.project_dir)

        if (result.plan_ready) {
          await ctx.sendActivity(`✅ **Plan approved** by ${userName}. Triggering execution...`)
          try {
            const execResult = await triggerExecution(quorumToken, data.project_dir, data.plan_id, result.summary)
            await ctx.sendActivity(
              `⚙️ Execution started.\nSession: \`${execResult.session_id}\`\n\nType \`@QUORUM status\` to check progress.`
            )
          } catch (execErr) {
            await ctx.sendActivity(`⚠️ Plan approved but execution trigger failed: ${(execErr as Error).message}`)
          }
        } else {
          await ctx.sendActivity(`✅ Approval recorded. ${result.approval_status}`)
        }
      } catch (err) {
        await ctx.sendActivity(`❌ Approval failed: ${(err as Error).message}`)
      }
      return
    }

    if (data.action === 'reject') {
      try {
        await rejectPlan(quorumToken, data.plan_id, data.project_dir, data.rejection_reason)
        const reasonLine = data.rejection_reason ? `\nReason: _${data.rejection_reason}_` : ''
        await ctx.sendActivity(
          `❌ **Plan rejected** by ${userName}.${reasonLine}\n\nContinue the discussion and call \`@QUORUM plan\` again when ready.`
        )
      } catch (err) {
        await ctx.sendActivity(`❌ Reject failed: ${(err as Error).message}`)
      }
      return
    }

    await ctx.sendActivity('⚠️ Unknown action.')
  }

  // ── /quorum story ────────────────────────────────────────────────────────────

  private async handleStoryCommand(ctx: TurnContext, channelId: string, contextHint?: string): Promise<void> {
    const userId = ctx.activity.from.id
    const quorumToken = await this.getToken(userId)

    if (!quorumToken) {
      await ctx.sendActivity('🔐 Link your QUORUM account first: type `@QUORUM login`')
      return
    }

    const messages = channelHistory.get(channelId) ?? []
    const relevant = messages.filter(m => !m.content.toLowerCase().startsWith('@quorum'))

    if (relevant.length < 2) {
      await ctx.sendActivity('💬 Not enough conversation to create a story from. Discuss the feature first, then call `@QUORUM story`.')
      return
    }

    await ctx.sendActivity('✍️ Writing user story from discussion...')

    try {
      const result = await createStory(quorumToken, relevant.slice(-30), contextHint)
      // Split into multiple messages if multiple stories returned
      const stories = result.story.split(/\n---\n/).map(s => s.trim()).filter(Boolean)
      for (const story of stories) {
        await ctx.sendActivity(`\`\`\`\n${story}\n\`\`\``)
      }
      await ctx.sendActivity(`📋 Story ID: \`${result.story_id}\` — Copy and paste into Jira / Linear / Azure Boards.`)
    } catch (err) {
      await ctx.sendActivity(`❌ Failed to create story: ${(err as Error).message}`)
    }
  }

  // ── Helper commands ────────────────────────────────────────────────────────

  private async handleHelpCommand(ctx: TurnContext): Promise<void> {
    await ctx.sendActivity([
      '**QUORUM Bot**',
      '',
      '`@QUORUM plan` — Summarize discussion → create plan.md → approval → execute',
      '`@QUORUM story` — Summarize discussion → create user story for Jira/Linear/Azure',
      '`@QUORUM story for mobile app` — Story with extra context',
      '`@QUORUM status` — Check current session status',
      '`@QUORUM watch [tool] [keyword]` — Monitor PM tool for tickets → auto-plan',
      '`@QUORUM watch stop` — Stop the PM tool watcher',
      '`@QUORUM stop` — Interrupt a running execution session',
      '`@QUORUM login` — Link your QUORUM Console account',
      '`@QUORUM logout` — Unlink your QUORUM account from this chat',
      '`@QUORUM help` — Show this message',
      '',
      '**Difference:**',
      '`plan` = technical plan for developers (needs approval to execute)',
      '`story` = BA artifact for stakeholders (no approval, instant output)'
    ].join('\n'))
  }

  private async handleStatusCommand(ctx: TurnContext): Promise<void> {
    const userId = ctx.activity.from.id
    const hasToken = tokenStore.has(userId)
    await ctx.sendActivity(
      hasToken
        ? '✅ QUORUM account linked. Ready to execute plans.'
        : '❌ Not linked. Type `@QUORUM login` to connect your account.'
    )
  }

  private async handleLoginCommand(ctx: TurnContext): Promise<void> {
    const serverUrl = process.env['QUORUM_SERVER_URL'] ?? 'http://localhost:3001'
    const teamsUserId = ctx.activity.from.id
    await ctx.sendActivity(
      `🔐 **Link your QUORUM account**\n\n` +
      `Open this URL in your browser while logged into QUORUM Console:\n\n` +
      `${serverUrl}/api/auth/teams/link?teams_user_id=${encodeURIComponent(teamsUserId)}\n\n` +
      `*Link expires in 10 minutes.*`
    )
  }

  private async handleLogoutCommand(ctx: TurnContext): Promise<void> {
    const serverUrl = process.env['QUORUM_SERVER_URL'] ?? 'http://localhost:3001'
    const botSecret = process.env['BOT_SECRET'] ?? ''
    const teamsUserId = ctx.activity.from.id
    tokenStore.delete(teamsUserId)
    try {
      const resp = await fetch(`${serverUrl}/api/auth/teams/unlink`, {
        method: 'DELETE',
        headers: { 'x-bot-secret': botSecret, 'x-teams-user-id': teamsUserId }
      })
      await ctx.sendActivity(resp.ok
        ? '👋 Logged out. Your QUORUM account has been unlinked.\n\nType `@QUORUM login` to reconnect.'
        : '⚠️ You were not linked — nothing to log out from.')
    } catch {
      await ctx.sendActivity('❌ Could not reach QUORUM server.')
    }
  }

  // ── Token management ───────────────────────────────────────────────────────

  private async getToken(teamsUserId: string): Promise<string | null> {
    // Check in-memory cache first
    if (tokenStore.has(teamsUserId)) {
      return tokenStore.get(teamsUserId)!
    }
    // Fall back to server lookup
    const token = await getQuorumToken(teamsUserId)
    if (token) tokenStore.set(teamsUserId, token)
    return token
  }
}
