import TelegramBot from 'node-telegram-bot-api'
import { nanoid } from 'nanoid'
import { db } from '../db/schema.js'
import { SessionRunner } from './session-runner.js'

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

  // Handle polling errors gracefully — do NOT crash the server
  bot.on('polling_error', (err: Error & { code?: string }) => {
    if (err.code === 'EFATAL' || err.message?.includes('ENOTFOUND') || err.message?.includes('ECONNREFUSED')) {
      // Network is down — log once and let the library retry silently
      console.warn(`[Telegram] Network error (${err.message?.slice(0, 60)}) — will retry automatically`)
    } else {
      // Other errors (bad token, etc.) — log but don't crash
      console.error('[Telegram] Polling error:', err.message ?? err)
    }
  })

  // /start and /help — welcome message (plain text, no Markdown)
  bot.onText(/\/(start|help)/, (msg) => {
    bot!.sendMessage(msg.chat.id,
      '👋 Welcome to QUORUM Console!\n\n' +
      'Commands:\n' +
      '/run <cmd> — Run a command (e.g. /run doctor)\n' +
      '/status — Check current session status\n' +
      '/stop — Stop the running session\n' +
      '/login — Link your QUORUM account\n' +
      '/help — Show this message'
    )
  })

  // /run <command> — execute a command in the last used project directory
  bot.onText(/\/run\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id.toString()
    const link = db.prepare(
      'SELECT user_id FROM telegram_links WHERE chat_id = ?'
    ).get(chatId) as { user_id: string } | undefined

    if (!link) {
      bot!.sendMessage(chatId, '❌ Not linked. Send /login first.')
      return
    }

    const commandStr = match?.[1]?.trim()
    if (!commandStr) return

    // Find the user's most recently used project directory
    const lastSession = db.prepare(`
      SELECT project_dir FROM sessions
      WHERE user_id = ? AND project_dir IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(link.user_id) as { project_dir: string } | undefined

    const projectDir = lastSession?.project_dir
    if (!projectDir) {
      bot!.sendMessage(chatId, '❌ No previous project directory found.\nPlease run your first command from the Web UI to set a default directory.')
      return
    }

    const sessionId = nanoid()
    const description = `Triggered from Telegram: atlas ${commandStr}`

    db.prepare(`
      INSERT INTO sessions (id, user_id, command, description, status, project_dir)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(sessionId, link.user_id, commandStr, description, projectDir)

    // Run automatically with --auto since they aren't at the keyboard
    const runner = new SessionRunner(sessionId, link.user_id)
    runner.start(commandStr, description, projectDir, { auto: true }).catch(err => {
      db.prepare("UPDATE sessions SET status = 'error', updated_at = datetime('now') WHERE id = ?").run(sessionId)
      console.error(`Telegram session ${sessionId} error:`, err)
    })

    const publicUrl = process.env['PUBLIC_URL'] ?? 'http://localhost:3000'
    bot!.sendMessage(chatId, 
      `🚀 Started: atlas ${commandStr}\n` +
      `📁 Dir: ${projectDir}\n\n` +
      `Monitor live output here:\n` +
      `${publicUrl.replace(/\/$/, '')}/session/${sessionId}`
    )
  })

  // /login — generate a secure one-time link the user opens in their browser
  bot.onText(/\/login/, async (msg) => {
    const chatId = msg.chat.id.toString()

    // Check if already linked
    const existing = db.prepare(
      'SELECT user_id FROM telegram_links WHERE chat_id = ?'
    ).get(chatId) as { user_id: string } | undefined

    if (existing) {
      bot!.sendMessage(chatId,
        '✅ Your Telegram is already linked to an QUORUM account.\n' +
        'Send /status to check your session.'
      )
      return
    }

    try {
      // Call the internal generate-link endpoint to create a secure DB-backed token
      const serverUrl = `http://localhost:${process.env['PORT'] ?? '3001'}`
      const resp = await fetch(`${serverUrl}/api/auth/telegram/generate-link`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bot-secret': process.env['JWT_SECRET'] ?? ''
        },
        body: JSON.stringify({ chat_id: chatId })
      })

      const data = await resp.json() as { url?: string; error?: string }
      if (!data.url) throw new Error(data.error ?? 'No URL returned')

      // Send the link as plain text — never use parse_mode Markdown with URLs (underscores break it)
      bot!.sendMessage(chatId,
        '🔗 Link your QUORUM account\n\n' +
        '1. Make sure you are logged into QUORUM Console:\n' +
        '   http://localhost:3000   (use email + password)\n\n' +
        '2. Then open this link:\n' +
        data.url + '\n\n' +
        'Link expires in 10 minutes.'
      )
    } catch (err) {
      console.error('Telegram /login error:', err)
      bot!.sendMessage(chatId, 'Error generating link. Make sure the QUORUM server is running and try again.')
    }
  })


  // /status — show current session status
  bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id.toString()
    const link = db.prepare(
      'SELECT user_id FROM telegram_links WHERE chat_id = ?'
    ).get(chatId) as { user_id: string } | undefined

    if (!link) {
      bot!.sendMessage(chatId, '❌ Not linked yet. Send /login to connect your account.')
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
      bot!.sendMessage(chatId, 'No sessions yet. Run a command from the QUORUM Console web app.')
      return
    }

    bot!.sendMessage(chatId,
      `📊 Latest Session\n` +
      `Command: atlas ${session.command}\n` +
      `Description: ${session.description ?? '(none)'}\n` +
      `Status: ${statusEmoji(session.status)} ${session.status}\n` +
      `Started: ${new Date(session.created_at).toLocaleString()}`
    )
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
      try { process.kill(session.pid, 'SIGINT') } catch { /* already exited */ }
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
    await bot.sendMessage(link.chat_id, message)
  }
}

function statusEmoji(status: string): string {
  const map: Record<string, string> = {
    pending: '⏳', running: '🔄', completed: '✅',
    failed: '❌', interrupted: '🛑', error: '⚠️'
  }
  return map[status] ?? '❓'
}
