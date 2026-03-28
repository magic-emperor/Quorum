import TelegramBot from 'node-telegram-bot-api'
import type { BotMessage, BotContext, SentMessage, AdapterConfig } from '../types.js'
import { renderCard, type PlatformCard } from '../cards/card-builder.js'
import { handlePlan, handleStory, handleHelp, handleStatus, handleApprove, handleReject, handleLogout, handleCompact, getQuorumToken } from '../handlers/commands.js'

// ─── Telegram Adapter ─────────────────────────────────────────────────────────
// Migrates the existing standalone apps/telegram-bot/ into the unified bot.
// Added: @QUORUM plan, @QUORUM story, approval inline keyboards.

const chatHistory = new Map<string, BotMessage[]>()
const MAX_HISTORY = 50

// Pending "reject with reason" state: chatId → { planId, projectDir }
const pendingRejectReason = new Map<string, { planId: string; projectDir: string }>()

function recordMessage(chatId: string, msg: BotMessage): void {
  const history = chatHistory.get(chatId) ?? []
  history.push(msg)
  if (history.length > MAX_HISTORY) history.shift()
  chatHistory.set(chatId, history)
}

export function createTelegramAdapter(_config: AdapterConfig): TelegramBot {
  const token = process.env['TELEGRAM_BOT_TOKEN']
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set')

  const bot = new TelegramBot(token, { polling: false })
  console.log('QUORUM Telegram adapter started')

  // Delay polling start to let Telegram release any lingering connections
  setTimeout(() => {
    bot.startPolling({ restart: false }).catch(() => {})
  }, 5000)

  function makeContext(chatId: string, userId: string, userName: string): BotContext {
    return {
      platform: 'telegram',
      channelId: chatId,
      userId,
      userName,
      async reply(text: string) {
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' })
      },
      async replyCard(card: PlatformCard): Promise<SentMessage> {
        const payload = renderCard(card, 'telegram') as { text: string; reply_markup?: unknown; parse_mode?: string }
        const sent = await bot.sendMessage(chatId, payload.text, {
          parse_mode: (payload.parse_mode as 'Markdown' | 'MarkdownV2' | 'HTML' | undefined) ?? 'Markdown',
          reply_markup: payload.reply_markup as TelegramBot.ReplyKeyboardMarkup | undefined
        })
        return { id: String(sent.message_id) }
      },
      async updateCard(messageId: string, card: PlatformCard) {
        const payload = renderCard(card, 'telegram') as { text: string; reply_markup?: unknown; parse_mode?: string }
        await bot.editMessageText(payload.text, {
          chat_id: chatId,
          message_id: parseInt(messageId),
          parse_mode: (payload.parse_mode as 'Markdown' | 'MarkdownV2' | 'HTML' | undefined) ?? 'Markdown'
        })
      },
      getHistory: (limit = 30) => (chatHistory.get(chatId) ?? []).slice(-limit),
      recordMessage: (msg: BotMessage) => recordMessage(chatId, msg),
      replaceHistory: (messages: BotMessage[]) => chatHistory.set(chatId, messages)
    }
  }

  // Record all messages — also handle pending "reject with reason" replies
  bot.on('message', async (msg) => {
    if (!msg.text || msg.from?.is_bot) return

    const chatId = String(msg.chat.id)
    const pending = pendingRejectReason.get(chatId)
    if (pending) {
      pendingRejectReason.delete(chatId)
      const quorumToken = await getQuorumToken('telegram', chatId)
      if (!quorumToken) { await bot.sendMessage(msg.chat.id, '🔐 Link your account first: /login'); return }
      const ctx = makeContext(chatId, String(msg.from?.id ?? ''), msg.from?.first_name ?? 'Unknown')
      await handleReject(ctx, quorumToken, pending.planId, pending.projectDir, msg.text)
      return
    }

    recordMessage(chatId, {
      id: String(msg.message_id),
      text: msg.text,
      author: msg.from?.first_name ?? 'Unknown',
      authorId: String(msg.from?.id ?? ''),
      channelId: String(msg.chat.id),
      platform: 'telegram',
      timestamp: new Date((msg.date ?? 0) * 1000).toISOString(),
      isBot: msg.from?.is_bot ?? false
    })
  })

  // /start and /help
  bot.onText(/\/(start|help)/, async (msg) => {
    const ctx = makeContext(String(msg.chat.id), String(msg.from?.id ?? ''), msg.from?.first_name ?? 'Unknown')
    await handleHelp(ctx)
  })

  // /login
  bot.onText(/\/login/, async (msg) => {
    const serverUrl = process.env['QUORUM_SERVER_URL'] ?? 'http://localhost:3001'
    const botSecret = process.env['BOT_SECRET'] ?? ''
    const chatId = String(msg.chat.id)
    try {
      const resp = await fetch(`${serverUrl}/api/auth/telegram/generate-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bot-secret': botSecret },
        body: JSON.stringify({ chat_id: chatId })
      })
      const data = await resp.json() as { url?: string; error?: string }
      if (!resp.ok || !data.url) throw new Error(data.error ?? 'Could not generate link')
      await bot.sendMessage(msg.chat.id,
        `🔐 *Link your QUORUM account*\n\nOpen this link in your browser:\n${data.url}\n\n_Already logged in? It links automatically\\. Otherwise you\\'ll see a login form\\._\n\n_Expires in 10 minutes\\._`,
        { parse_mode: 'MarkdownV2' }
      )
    } catch (err) {
      await bot.sendMessage(msg.chat.id, `❌ Could not generate login link: ${(err as Error).message}`)
    }
  })

  // /compact — summarize and compress in-memory history
  bot.onText(/\/compact/, async (msg) => {
    const ctx = makeContext(String(msg.chat.id), String(msg.from?.id ?? ''), msg.from?.first_name ?? 'Unknown')
    await handleCompact(ctx)
  })

  // /logout
  bot.onText(/\/logout/, async (msg) => {
    const chatId = String(msg.chat.id)
    const ctx = makeContext(chatId, String(msg.from?.id ?? ''), msg.from?.first_name ?? 'Unknown')
    await handleLogout(ctx, chatId)
  })

  // /status
  bot.onText(/\/status/, async (msg) => {
    const quorumToken = await getQuorumToken('telegram', String(msg.chat.id))
    const ctx = makeContext(String(msg.chat.id), String(msg.from?.id ?? ''), msg.from?.first_name ?? 'Unknown')
    await handleStatus(ctx, quorumToken)
  })

  // /stop
  bot.onText(/\/stop/, async (msg) => {
    const quorumToken = await getQuorumToken('telegram', String(msg.chat.id))
    if (!quorumToken) { await bot.sendMessage(msg.chat.id, '❌ Not linked. Send /login first.'); return }
    const serverUrl = process.env['QUORUM_SERVER_URL'] ?? 'http://localhost:3001'
    const botSecret = process.env['BOT_SECRET'] ?? ''
    const projectDir = process.env['DEFAULT_PROJECT_DIR'] ?? ''
    const resp = await fetch(`${serverUrl}/api/sessions/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${quorumToken}`, 'x-bot-secret': botSecret },
      body: JSON.stringify({ project_dir: projectDir, stop_latest: true })
    })
    await bot.sendMessage(msg.chat.id, resp.ok ? '⏹️ Session interrupted.' : '❌ No running session to stop.')
  })

  // /plan — create plan from recent chat
  bot.onText(/\/(plan|atlas plan)/, async (msg) => {
    const quorumToken = await getQuorumToken('telegram', String(msg.chat.id))
    if (!quorumToken) { await bot.sendMessage(msg.chat.id, '🔐 Link your account first: /login'); return }
    const ctx = makeContext(String(msg.chat.id), String(msg.from?.id ?? ''), msg.from?.first_name ?? 'Unknown')
    await handlePlan(ctx, quorumToken)
  })

  // /story — create user story
  bot.onText(/\/(story|atlas story)(.*)/, async (msg, match) => {
    const quorumToken = await getQuorumToken('telegram', String(msg.chat.id))
    if (!quorumToken) { await bot.sendMessage(msg.chat.id, '🔐 Link your account first: /login'); return }
    const hint = match?.[2]?.trim() || undefined
    const ctx = makeContext(String(msg.chat.id), String(msg.from?.id ?? ''), msg.from?.first_name ?? 'Unknown')
    await handleStory(ctx, quorumToken, hint)
  })

  // Handle approval inline keyboard callbacks
  bot.on('callback_query', async (query) => {
    if (!query.data) return

    const parts = query.data.split(':')
    const action = parts[0]
    const planId = parts[1]
    const projectDir = parts.slice(2).join(':')

    const chatId = String(query.message?.chat.id ?? '')
    const userId = String(query.from.id)
    const userName = query.from.first_name ?? 'Unknown'
    const messageId = String(query.message?.message_id ?? '')

    await bot.answerCallbackQuery(query.id)

    const quorumToken = await getQuorumToken('telegram', chatId)
    if (!quorumToken) { await bot.sendMessage(query.message!.chat.id, '🔐 Link your account first: /login'); return }

    const ctx = makeContext(chatId, userId, userName)

    if (action === 'approve' && planId && projectDir) {
      await handleApprove(ctx, quorumToken, planId, projectDir, messageId)
    } else if (action === 'reject_reason' && planId && projectDir) {
      pendingRejectReason.set(chatId, { planId, projectDir })
      await bot.sendMessage(query.message!.chat.id, '💬 Type your rejection reason and send it as the next message:',
        { reply_markup: { force_reply: true, selective: true } })
    } else if (action === 'reject' && planId && projectDir) {
      await handleReject(ctx, quorumToken, planId, projectDir, undefined, messageId)
    }
  })

  bot.on('polling_error', (err: Error & { code?: string }) => {
    if (err.code !== 'EFATAL' && !err.message?.includes('ENOTFOUND') && !err.message?.includes('ECONNREFUSED')) {
      console.error('[Telegram] Polling error:', err.message)
    }
  })

  return bot
}
