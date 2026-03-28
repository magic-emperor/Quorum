import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import rateLimit from 'express-rate-limit'
import { db } from '../db/schema.js'
import { signToken, signRefreshToken, verifyRefreshToken, verifyToken, type AuthRequest } from '../middleware/auth.js'

export const authRouter = Router()

// Rate limit auth endpoints — 10 attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later.' }
})

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
})

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string()
})

// POST /api/auth/register
authRouter.post('/register', authLimiter, async (req, res) => {
  const parsed = RegisterSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() })
    return
  }
  const { email, password } = parsed.data

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
  if (existing) {
    res.status(409).json({ error: 'Email already registered' })
    return
  }

  const id = nanoid()
  const hash = await bcrypt.hash(password, 12)
  db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(id, email, hash)

  const token = signToken(id, email)
  const refresh_token = signRefreshToken(id)
  res.status(201).json({ token, refresh_token, user: { id, email } })
})

// POST /api/auth/login
authRouter.post('/login', authLimiter, async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input' })
    return
  }
  const { email, password } = parsed.data

  const user = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email) as
    | { id: string; email: string; password_hash: string }
    | undefined

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    res.status(401).json({ error: 'Invalid email or password' })
    return
  }

  const token = signToken(user.id, user.email)
  const refresh_token = signRefreshToken(user.id)
  res.json({ token, refresh_token, user: { id: user.id, email: user.email } })
})

// POST /api/auth/refresh — exchange a refresh token for a new access token + new refresh token
authRouter.post('/refresh', (req, res) => {
  const { refresh_token } = req.body as { refresh_token?: string }
  if (!refresh_token) {
    res.status(400).json({ error: 'refresh_token required' })
    return
  }

  const payload = verifyRefreshToken(refresh_token)
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired refresh token' })
    return
  }

  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(payload.id) as
    | { id: string; email: string }
    | undefined

  if (!user) {
    res.status(401).json({ error: 'User not found' })
    return
  }

  const token = signToken(user.id, user.email)
  const new_refresh_token = signRefreshToken(user.id)
  res.json({ token, refresh_token: new_refresh_token })
})

// GET /api/auth/me
authRouter.get('/me', verifyToken, (req: AuthRequest, res) => {
  res.json({ user: req.user })
})

// GET /api/auth/telegram/link-token
// Called when the user requests a link from the web dashboard (user must be logged in)
authRouter.get('/telegram/link-token', verifyToken, (req: AuthRequest, res) => {
  const chatId = req.query['chat_id'] as string
  if (!chatId) {
    res.status(400).json({ error: 'chat_id required' })
    return
  }

  const token = nanoid(32)
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

  db.prepare(`
    INSERT OR REPLACE INTO telegram_link_tokens (token, user_id, chat_id, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(token, req.user!.id, chatId, expiresAt)

  const publicUrl = process.env['PUBLIC_URL'] ?? 'https://atlasconsole.app'
  res.json({
    url: `${publicUrl}/telegram-auth?token=${token}`,
    expires_at: expiresAt
  })
})

// POST /api/auth/telegram/generate-link  (internal — called by the bot only)
// Secured by x-bot-secret header so only the bot process can call it
authRouter.post('/telegram/generate-link', (req, res) => {
  const secret = req.headers['x-bot-secret']
  if (secret !== process.env['BOT_SECRET']) {
    res.status(401).json({ error: 'Unauthorized' }); return
  }
  const { chat_id } = req.body as { chat_id: string }
  if (!chat_id) { res.status(400).json({ error: 'chat_id required' }); return }

  const token = nanoid(32)
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

  db.prepare(`
    INSERT OR REPLACE INTO telegram_link_tokens (token, user_id, chat_id, expires_at)
    VALUES (?, NULL, ?, ?)
  `).run(token, chat_id, expiresAt)

  const publicUrl = (process.env['PUBLIC_URL'] ?? 'http://localhost:3001').replace(/\/$/, '')
  res.json({
    url: `${publicUrl}/telegram-auth?token=${token}`,
    expires_at: expiresAt
  })
})

// GET /api/auth/telegram/bot-status — internal endpoint for standalone bot
// Returns latest session for the chat_id's linked user (bot-secret auth, no user JWT needed)
authRouter.get('/telegram/bot-status', (req, res) => {
  const secret = req.headers['x-bot-secret']
  if (secret !== process.env['BOT_SECRET']) {
    res.status(401).json({ error: 'Unauthorized' }); return
  }
  const chatId = (req.headers['x-telegram-user-id'] ?? req.headers['x-chat-id']) as string
  if (!chatId) { res.status(400).json({ error: 'x-telegram-user-id header required' }); return }

  const link = db.prepare(
    'SELECT user_id FROM telegram_links WHERE chat_id = ?'
  ).get(chatId) as { user_id: string } | undefined

  if (!link) {
    res.status(404).json({ error: 'Not linked' }); return
  }

  const token = signToken(link.user_id, '')

  const session = db.prepare(`
    SELECT id, command, description, status, created_at
    FROM sessions WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(link.user_id) as {
    id: string; command: string; description: string; status: string; created_at: string
  } | undefined

  if (!session) {
    res.json({ token, linked: true, session: null }); return
  }

  res.json({ token, ...session })
})

// GET /api/auth/telegram/link — direct link endpoint (same pattern as Discord/Teams)
// User opens this URL in browser while logged in via curl Authorization header
authRouter.get('/telegram/link', verifyToken, (req: AuthRequest, res) => {
  const { chat_id } = req.query as { chat_id?: string }
  if (!chat_id) { res.status(400).send('chat_id required'); return }

  db.prepare(`
    INSERT OR REPLACE INTO telegram_links (chat_id, user_id)
    VALUES (?, ?)
  `).run(chat_id, req.user!.id)

  res.send(`
    <html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;text-align:center">
      <h2>✅ Telegram account linked!</h2>
      <p>Your QUORUM account is now connected to Telegram.</p>
      <p>Go back to Telegram and try <code>/plan</code>.</p>
    </body></html>
  `)
})

// POST /api/auth/telegram/link
// Called from the TelegramAuth web page after user opens the deep-link
authRouter.post('/telegram/link', verifyToken, (req: AuthRequest, res) => {
  const { token } = req.body as { token: string }
  if (!token) {
    res.status(400).json({ error: 'token required' })
    return
  }

  const record = db.prepare(
    'SELECT chat_id, user_id, expires_at FROM telegram_link_tokens WHERE token = ?'
  ).get(token) as { chat_id: string; user_id: string; expires_at: string } | undefined

  if (!record) {
    res.status(404).json({ error: 'Token not found or already used' })
    return
  }

  if (new Date(record.expires_at) < new Date()) {
    res.status(410).json({ error: 'Token expired — send /login again on Telegram' })
    return
  }

  db.prepare(`
    INSERT OR REPLACE INTO telegram_links (chat_id, user_id)
    VALUES (?, ?)
  `).run(record.chat_id, req.user!.id)

  db.prepare('DELETE FROM telegram_link_tokens WHERE token = ?').run(token)

  res.json({ ok: true, message: 'Telegram account linked successfully' })
})

// ── Teams auth ─────────────────────────────────────────────────────────────────

// GET /api/auth/slack/bot-status — called by Slack bot to look up QUORUM token
authRouter.get('/slack/bot-status', (req, res) => {
  const secret = req.headers['x-bot-secret']
  if (secret !== process.env['BOT_SECRET']) {
    res.status(401).json({ error: 'Unauthorized' }); return
  }

  const slackUserId = req.headers['x-slack-user-id'] as string
  if (!slackUserId) { res.status(400).json({ error: 'x-slack-user-id required' }); return }

  const link = db.prepare(
    'SELECT user_id FROM slack_links WHERE slack_user_id = ?'
  ).get(slackUserId) as { user_id: string } | undefined

  if (!link) { res.status(404).json({ error: 'Not linked' }); return }

  const token = signToken(link.user_id, '')
  res.json({ token })
})

// GET /api/auth/slack/link — links Slack account to QUORUM account
authRouter.get('/slack/link', verifyToken, (req: AuthRequest, res) => {
  const { slack_user_id } = req.query as { slack_user_id?: string }
  if (!slack_user_id) { res.status(400).send('slack_user_id required'); return }

  db.prepare(`
    INSERT OR REPLACE INTO slack_links (slack_user_id, user_id)
    VALUES (?, ?)
  `).run(slack_user_id, req.user!.id)

  res.send(`
    <html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;text-align:center">
      <h2>✅ Slack account linked!</h2>
      <p>Your QUORUM account is now connected to Slack.</p>
      <p>Go back to Slack and try <code>@QUORUM plan</code>.</p>
    </body></html>
  `)
})

// GET /api/auth/discord/bot-status — called by Discord bot to look up QUORUM token
authRouter.get('/discord/bot-status', (req, res) => {
  const secret = req.headers['x-bot-secret']
  if (secret !== process.env['BOT_SECRET']) {
    res.status(401).json({ error: 'Unauthorized' }); return
  }

  const discordUserId = req.headers['x-discord-user-id'] as string
  if (!discordUserId) { res.status(400).json({ error: 'x-discord-user-id required' }); return }

  const link = db.prepare(
    'SELECT user_id FROM discord_links WHERE discord_user_id = ?'
  ).get(discordUserId) as { user_id: string } | undefined

  if (!link) { res.status(404).json({ error: 'Not linked' }); return }

  const token = signToken(link.user_id, '')
  res.json({ token })
})

// GET /api/auth/discord/link — links Discord account to QUORUM account
authRouter.get('/discord/link', verifyToken, (req: AuthRequest, res) => {
  const { discord_user_id } = req.query as { discord_user_id?: string }
  if (!discord_user_id) { res.status(400).send('discord_user_id required'); return }

  db.prepare(`
    INSERT OR REPLACE INTO discord_links (discord_user_id, user_id)
    VALUES (?, ?)
  `).run(discord_user_id, req.user!.id)

  res.send(`
    <html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;text-align:center">
      <h2>✅ Discord account linked!</h2>
      <p>Your QUORUM account is now connected to Discord.</p>
      <p>Go back to Discord and try <code>!atlas plan</code>.</p>
    </body></html>
  `)
})

// GET /api/auth/teams/bot-status — called by Teams bot to look up QUORUM token
authRouter.get('/teams/bot-status', (req, res) => {
  const secret = req.headers['x-bot-secret']
  if (secret !== process.env['BOT_SECRET']) {
    res.status(401).json({ error: 'Unauthorized' }); return
  }

  const teamsUserId = req.headers['x-teams-user-id'] as string
  if (!teamsUserId) { res.status(400).json({ error: 'x-teams-user-id required' }); return }

  const link = db.prepare(
    'SELECT user_id FROM teams_links WHERE teams_user_id = ?'
  ).get(teamsUserId) as { user_id: string } | undefined

  if (!link) { res.status(404).json({ error: 'Not linked' }); return }

  // Return a fresh short-lived token for the bot to use
  const token = signToken(link.user_id, '')
  res.json({ token })
})

// GET /api/auth/teams/link — deep-link landing page for Teams account linking
// Teams bot sends user here; user must be logged into QUORUM Console in the browser
authRouter.get('/teams/link', verifyToken, (req: AuthRequest, res) => {
  const { teams_user_id } = req.query as { teams_user_id?: string }
  if (!teams_user_id) { res.status(400).send('teams_user_id required'); return }

  const token = nanoid(32)
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

  db.prepare(`
    INSERT OR REPLACE INTO teams_link_tokens (token, teams_user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(token, teams_user_id, expiresAt)

  // Auto-complete the link since user is already authenticated via verifyToken
  db.prepare(`
    INSERT OR REPLACE INTO teams_links (teams_user_id, user_id)
    VALUES (?, ?)
  `).run(teams_user_id, req.user!.id)

  db.prepare('DELETE FROM teams_link_tokens WHERE token = ?').run(token)

  res.send(`
    <html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;text-align:center">
      <h2>✅ Teams account linked!</h2>
      <p>Your QUORUM account is now connected to Microsoft Teams.</p>
      <p>Go back to Teams and try <code>@QUORUM plan</code>.</p>
    </body></html>
  `)
})

// ── Logout (unlink) endpoints — called by bots via x-bot-secret ───────────────

// DELETE /api/auth/telegram/unlink
authRouter.delete('/telegram/unlink', (req, res) => {
  const secret = req.headers['x-bot-secret']
  if (secret !== process.env['BOT_SECRET']) { res.status(401).json({ error: 'Unauthorized' }); return }
  const chatId = req.headers['x-telegram-user-id'] as string
  if (!chatId) { res.status(400).json({ error: 'x-telegram-user-id required' }); return }
  db.prepare('DELETE FROM telegram_links WHERE chat_id = ?').run(chatId)
  res.json({ ok: true })
})

// DELETE /api/auth/discord/unlink
authRouter.delete('/discord/unlink', (req, res) => {
  const secret = req.headers['x-bot-secret']
  if (secret !== process.env['BOT_SECRET']) { res.status(401).json({ error: 'Unauthorized' }); return }
  const discordUserId = req.headers['x-discord-user-id'] as string
  if (!discordUserId) { res.status(400).json({ error: 'x-discord-user-id required' }); return }
  db.prepare('DELETE FROM discord_links WHERE discord_user_id = ?').run(discordUserId)
  res.json({ ok: true })
})

// DELETE /api/auth/slack/unlink
authRouter.delete('/slack/unlink', (req, res) => {
  const secret = req.headers['x-bot-secret']
  if (secret !== process.env['BOT_SECRET']) { res.status(401).json({ error: 'Unauthorized' }); return }
  const slackUserId = req.headers['x-slack-user-id'] as string
  if (!slackUserId) { res.status(400).json({ error: 'x-slack-user-id required' }); return }
  db.prepare('DELETE FROM slack_links WHERE slack_user_id = ?').run(slackUserId)
  res.json({ ok: true })
})

// DELETE /api/auth/teams/unlink
authRouter.delete('/teams/unlink', (req, res) => {
  const secret = req.headers['x-bot-secret']
  if (secret !== process.env['BOT_SECRET']) { res.status(401).json({ error: 'Unauthorized' }); return }
  const teamsUserId = req.headers['x-teams-user-id'] as string
  if (!teamsUserId) { res.status(400).json({ error: 'x-teams-user-id required' }); return }
  db.prepare('DELETE FROM teams_links WHERE teams_user_id = ?').run(teamsUserId)
  res.json({ ok: true })
})
