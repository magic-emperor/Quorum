import { App, type BlockAction, type ButtonAction } from '@slack/bolt'
import type { BotMessage, BotContext, SentMessage, AdapterConfig } from '../types.js'
import { renderCard, type PlatformCard } from '../cards/card-builder.js'
import { handlePlan, handleStory, handleHelp, handleStatus, handleApprove, handleReject, handleLogout, handleCompact, getQuorumToken } from '../handlers/commands.js'

// ─── Slack Adapter ────────────────────────────────────────────────────────────
// Uses @slack/bolt. Handles slash commands and @QUORUM mentions.
// Button actions are handled via interactivity (POST /slack/events).

// Channel message history — in-memory per channel
const channelHistory = new Map<string, BotMessage[]>()
const MAX_HISTORY = 50

function getHistory(channelId: string): BotMessage[] {
  return channelHistory.get(channelId) ?? []
}

function recordMessage(channelId: string, msg: BotMessage): void {
  const history = channelHistory.get(channelId) ?? []
  history.push(msg)
  if (history.length > MAX_HISTORY) history.shift()
  channelHistory.set(channelId, history)
}

export function createSlackAdapter(config: AdapterConfig): App {
  const app = new App({
    token: process.env['SLACK_BOT_TOKEN'],
    signingSecret: process.env['SLACK_SIGNING_SECRET'],
    appToken: process.env['SLACK_APP_TOKEN'],
    socketMode: !!process.env['SLACK_APP_TOKEN']
  })

  // Build a BotContext for Slack
  function makeContext(channelId: string, userId: string, userName: string, say: (msg: unknown) => Promise<unknown>, client: App['client']): BotContext {
    let lastMsgTs: string | undefined

    return {
      platform: 'slack',
      channelId,
      userId,
      userName,
      async reply(text: string) {
        await say({ text })
      },
      async replyCard(card: PlatformCard): Promise<SentMessage> {
        const blocks = renderCard(card, 'slack') as unknown[]
        const result = await say({ blocks, text: 'QUORUM Plan' }) as { ts?: string }
        lastMsgTs = result.ts
        return { id: result.ts }
      },
      async updateCard(messageId: string, card: PlatformCard) {
        const blocks = renderCard(card, 'slack') as unknown[]
        await client.chat.update({ channel: channelId, ts: messageId, blocks, text: 'QUORUM' })
      },
      getHistory: (limit = 30) => getHistory(channelId).slice(-limit),
      recordMessage: (msg: BotMessage) => recordMessage(channelId, msg),
      replaceHistory: (messages: BotMessage[]) => channelHistory.set(channelId, messages)
    }
  }

  // Record all messages to history
  app.message(async ({ message, client }) => {
    const msg = message as { ts: string; user?: string; text?: string; channel: string; bot_id?: string }
    if (!msg.text || msg.bot_id) return

    const userInfo = await client.users.info({ user: msg.user ?? '' }).catch(() => null)
    const userName = (userInfo?.user as { real_name?: string } | null)?.real_name ?? msg.user ?? 'Unknown'

    const botMsg: BotMessage = {
      id: msg.ts,
      text: msg.text,
      author: userName,
      authorId: msg.user ?? '',
      channelId: msg.channel,
      platform: 'slack',
      timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
      isBot: !!msg.bot_id
    }
    recordMessage(msg.channel, botMsg)
  })

  // Handle @atlas mention
  app.event('app_mention', async ({ event, say, client }) => {
    const e = event as { user: string; text: string; channel: string; ts: string }
    const text = e.text.replace(/<@[^>]+>/, '').trim()
    const lower = text.toLowerCase()

    const userInfo = await client.users.info({ user: e.user }).catch(() => null)
    const userName = (userInfo?.user as { real_name?: string } | null)?.real_name ?? e.user

    const quorumToken = await getQuorumToken('slack', e.user)
    const ctx = makeContext(e.channel, e.user, userName, say as (msg: unknown) => Promise<unknown>, client)

    if (!quorumToken && !lower.includes('help') && !lower.includes('login') && !lower.includes('logout')) {
      await ctx.reply(`🔐 Link your QUORUM account first.\n<${config.atlasServerUrl}/api/auth/slack/link?slack_user_id=${encodeURIComponent(e.user)}|Click here to link> (expires in 10 minutes)`)
      return
    }

    if (lower.includes('plan')) {
      await handlePlan(ctx, quorumToken!)
    } else if (lower.includes('story')) {
      const hint = text.replace(/story\s*/i, '').trim() || undefined
      await handleStory(ctx, quorumToken!, hint)
    } else if (lower.includes('status')) {
      await handleStatus(ctx, quorumToken)
    } else if (lower.includes('help')) {
      await handleHelp(ctx)
    } else if (lower.includes('compact')) {
      await handleCompact(ctx)
    } else if (lower.includes('logout')) {
      await handleLogout(ctx, e.user)
    } else if (lower.includes('login')) {
      await ctx.reply(`🔐 Link your QUORUM account:\n<${config.atlasServerUrl}/api/auth/slack/link?slack_user_id=${encodeURIComponent(e.user)}|Click here to link> (expires in 10 minutes)`)
    }
  })

  // Handle approve/reject button clicks
  app.action<BlockAction>({ action_id: /^(approve|reject)_plan$/ }, async ({ action, ack, body, client }) => {
    await ack()

    const btn = action as ButtonAction
    const payload = JSON.parse(btn.value ?? '{}') as { plan_id: string; project_dir: string }
    const userId = body.user.id
    const userName = body.user.name ?? userId
    const channelId = (body.channel as { id?: string } | undefined)?.id ?? ''
    const messageTs = (body.message as { ts?: string } | undefined)?.ts

    const quorumToken = await getQuorumToken('slack', userId)
    if (!quorumToken) {
      await client.chat.postMessage({ channel: channelId, text: '🔐 Link your QUORUM account first.' })
      return
    }

    const say = async (msg: unknown) => {
      await client.chat.postMessage({ channel: channelId, ...(msg as object) })
    }
    const ctx = makeContext(channelId, userId, userName, say, client)

    if (btn.action_id === 'approve_plan') {
      await handleApprove(ctx, quorumToken, payload.plan_id, payload.project_dir, messageTs)
    } else {
      await handleReject(ctx, quorumToken, payload.plan_id, payload.project_dir, undefined, messageTs)
    }
  })

  // Handle "Reject with reason" — opens a Slack modal
  app.action<BlockAction>({ action_id: 'reject_reason_plan' }, async ({ action, ack, body, client }) => {
    await ack()

    const btn = action as ButtonAction
    const payload = JSON.parse(btn.value ?? '{}') as { plan_id: string; project_dir: string }
    const channelId = (body.channel as { id?: string } | undefined)?.id ?? ''
    const messageTs = (body.message as { ts?: string } | undefined)?.ts

    await client.views.open({
      trigger_id: (body as { trigger_id: string }).trigger_id,
      view: {
        type: 'modal',
        callback_id: 'reject_reason_modal',
        private_metadata: JSON.stringify({ plan_id: payload.plan_id, project_dir: payload.project_dir, channel_id: channelId, message_ts: messageTs }),
        title: { type: 'plain_text', text: 'Reject Plan' },
        submit: { type: 'plain_text', text: 'Reject' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [{
          type: 'input',
          block_id: 'reason_block',
          element: { type: 'plain_text_input', action_id: 'reason_input', multiline: true },
          label: { type: 'plain_text', text: 'Why are you rejecting this plan?' }
        }]
      }
    })
  })

  // Handle modal submission
  app.view('reject_reason_modal', async ({ ack, view, body, client }) => {
    await ack()

    const meta = JSON.parse(view.private_metadata) as { plan_id: string; project_dir: string; channel_id: string; message_ts?: string }
    const reason = view.state.values['reason_block']?.['reason_input']?.value ?? ''
    const userId = body.user.id
    const userName = body.user.name ?? userId

    const quorumToken = await getQuorumToken('slack', userId)
    if (!quorumToken) {
      await client.chat.postMessage({ channel: meta.channel_id, text: '🔐 Link your QUORUM account first.' })
      return
    }

    const say = async (msg: unknown) => {
      await client.chat.postMessage({ channel: meta.channel_id, ...(msg as object) })
    }
    const ctx = makeContext(meta.channel_id, userId, userName, say, client)
    await handleReject(ctx, quorumToken, meta.plan_id, meta.project_dir, reason, meta.message_ts)
  })

  return app
}
