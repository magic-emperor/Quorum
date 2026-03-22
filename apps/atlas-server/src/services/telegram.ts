import TelegramBot from 'node-telegram-bot-api'
import { db } from '../db/schema.js'
import { signToken } from '../middleware/auth.js'

let bot: TelegramBot | null = null

/** Start Telegram bot polling if token is configured */
export function startTelegramBot(): void {
  const token = process.env['TELEGRAM_BOT_TOKEN']
  if (!token) {
    console.log('No TELEGRAM_BOT_TOKEN — Telegram bot disabled')
    return
  }

  bot = new TelegramBot(token, { polling: true })
  console.log('Telegram bot started')

  // /start — welcome message
  bot.onText(/\/start/, (msg) => {
    bot!.sendMessage(msg.chat.id, [
      '👋 Welcome to *ATLAS Console*!',
      '',
      'Commands:',
      '/login — Link your ATLAS account',
      '/status — Check current session status',
      '/stop — Stop the running session',
      '/help — Show this message'
    ].join('\n'), { parse_mode: 'Markdown' })
  })

  // /login — generate a one-time link for the user to open in browser
  bot.onText(/\/login/, async (msg) => {
    const chatId = msg.chat.id.toString()

    // Check if already linked
    const existing = db.prepare(
      'SELECT user_id FROM telegram_links WHERE chat_id = ?'
    ).get(chatId) as { user_id: string } | undefined

    if (existing) {
      bot!.sendMessage(chatId,
        '✅ Your Telegram is already linked to an ATLAS account.\n' +
        'Send /status to check your session or /help for commands.'
      )
      return
    }

    const publicUrl = process.env['PUBLIC_URL'] ?? 'https://atlasconsole.app'
    const linkUrl = `${publicUrl}/telegram-auth?chat_id=${chatId}`

    bot!.sendMessage(chatId, [
      '🔗 *Link your ATLAS account*',
      '',
      'Open this link in your browser and log in:',
      linkUrl,
      '',
      '_Link expires in 10 minutes_'
    ].join('\n'), { parse_mode: 'Markdown' })
  })

  // /status — show current session status
  bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id.toString()
    const link = db.prepare(
      'SELECT user_id FROM telegram_links WHERE chat_id = ?'
    ).get(chatId) as { user_id: string } | undefined

    if (!link) {
      bot!.sendMessage(chatId, '❌ Not linked. Send /login to connect your account.')
      return
    }

    const session = db.prepare(`
      SELECT command, description, status, created_at
      FROM sessions WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(link.user_id) as {
      command: string; description: string; status: string; created_at: string
    } | undefined

    if (!session) {
      bot!.sendMessage(chatId, 'No sessions found. Run `atlas new` from the CLI or console.')
      return
    }

    bot!.sendMessage(chatId, [
      `📊 *Latest Session*`,
      `Command: \`atlas ${session.command}\``,
      `Description: ${session.description ?? '(none)'}`,
      `Status: ${statusEmoji(session.status)} ${session.status}`,
      `Started: ${new Date(session.created_at).toLocaleString()}`
    ].join('\n'), { parse_mode: 'Markdown' })
  })

  // /stop — interrupt running session
  bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id.toString()
    const link = db.prepare(
      'SELECT user_id FROM telegram_links WHERE chat_id = ?'
    ).get(chatId) as { user_id: string } | undefined

    if (!link) {
      bot!.sendMessage(chatId, '❌ Not linked. Send /login first.')
      return
    }

    const session = db.prepare(`
      SELECT id, pid FROM sessions
      WHERE user_id = ? AND status = 'running'
      ORDER BY created_at DESC LIMIT 1
    `).get(link.user_id) as { id: string; pid: number | null } | undefined

    if (!session) {
      bot!.sendMessage(chatId, 'No running session to stop.')
      return
    }

    if (session.pid) {
      try {
        process.kill(session.pid, 'SIGINT')
      } catch { /* already exited */ }
    }

    db.prepare("UPDATE sessions SET status = 'interrupted', updated_at = datetime('now') WHERE id = ?")
      .run(session.id)

    bot!.sendMessage(chatId, '🛑 Session interrupted.')
  })

  bot.on('error', (err) => {
    console.error('Telegram bot error:', err.message)
  })
}

/** Send a message to a user's linked Telegram chat */
export async function notifyUser(userId: string, message: string): Promise<void> {
  if (!bot) return
  const link = db.prepare(
    'SELECT chat_id FROM telegram_links WHERE user_id = ?'
  ).get(userId) as { chat_id: string } | undefined

  if (link) {
    await bot.sendMessage(link.chat_id, message, { parse_mode: 'Markdown' })
  }
}

function statusEmoji(status: string): string {
  const map: Record<string, string> = {
    pending: '⏳', running: '🔄', completed: '✅',
    failed: '❌', interrupted: '🛑', error: '⚠️'
  }
  return map[status] ?? '❓'
}
