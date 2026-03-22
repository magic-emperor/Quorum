import TelegramBot from 'node-telegram-bot-api'
import { getStatus, interruptSession, generateLinkToken } from './api.js'

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN not set')
  process.exit(1)
}

// Map of chat_id → atlas-server JWT (user must login to get this)
// In a real deployment, store this in a persistent store
const userTokens = new Map<string, string>()

const bot = new TelegramBot(BOT_TOKEN, { polling: true })
console.log('ATLAS Telegram Bot started (standalone mode)')

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, [
    '👋 *ATLAS Console Bot*',
    '',
    'I help you monitor and control your ATLAS sessions from Telegram.',
    '',
    'Commands:',
    '/login <token> — Authenticate with your API token',
    '/status — Check current session',
    '/stop — Interrupt running session',
    '/help — Show this message'
  ].join('\n'), { parse_mode: 'Markdown' })
})

bot.onText(/\/login (.+)/, (msg, match) => {
  const token = match?.[1]?.trim()
  if (!token) {
    bot.sendMessage(msg.chat.id, '❌ Usage: /login <your-jwt-token>')
    return
  }
  userTokens.set(msg.chat.id.toString(), token)
  bot.sendMessage(msg.chat.id, '✅ Authenticated! Use /status to check your sessions.')
})

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id.toString()
  const token = userTokens.get(chatId)
  if (!token) {
    bot.sendMessage(msg.chat.id, '❌ Not logged in. Use /login <token>')
    return
  }

  const session = await getStatus(chatId, token)
  if (!session) {
    bot.sendMessage(msg.chat.id, 'No sessions found.')
    return
  }

  const statusEmoji: Record<string, string> = {
    pending: '⏳', running: '🔄', completed: '✅',
    failed: '❌', interrupted: '🛑', error: '⚠️'
  }

  bot.sendMessage(msg.chat.id, [
    `📊 *Latest Session*`,
    `Command: \`atlas ${session.command}\``,
    session.description ? `Description: ${session.description}` : '',
    `Status: ${statusEmoji[session.status] ?? '❓'} ${session.status}`,
    `Started: ${new Date(session.created_at).toLocaleString()}`
  ].filter(Boolean).join('\n'), { parse_mode: 'Markdown' })
})

bot.onText(/\/stop/, async (msg) => {
  const chatId = msg.chat.id.toString()
  const token = userTokens.get(chatId)
  if (!token) {
    bot.sendMessage(msg.chat.id, '❌ Not logged in. Use /login <token>')
    return
  }

  const session = await getStatus(chatId, token)
  if (!session || session.status !== 'running') {
    bot.sendMessage(msg.chat.id, 'No running session to stop.')
    return
  }

  const ok = await interruptSession(session.id, token)
  bot.sendMessage(msg.chat.id, ok ? '🛑 Session interrupted.' : '❌ Failed to interrupt session.')
})

bot.on('error', (err) => {
  console.error('Bot error:', err.message)
})
