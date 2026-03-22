import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { db } from '../db/schema.js'
import { signToken, verifyToken, type AuthRequest } from '../middleware/auth.js'

export const authRouter = Router()

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
})

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string()
})

// POST /api/auth/register
authRouter.post('/register', async (req, res) => {
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
  res.status(201).json({ token, user: { id, email } })
})

// POST /api/auth/login
authRouter.post('/login', async (req, res) => {
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
  res.json({ token, user: { id: user.id, email: user.email } })
})

// GET /api/auth/me
authRouter.get('/me', verifyToken, (req: AuthRequest, res) => {
  res.json({ user: req.user })
})

// GET /api/auth/telegram/link-token
// Called by the bot when user sends /login — generates a one-time link token
authRouter.get('/telegram/link-token', verifyToken, (req: AuthRequest, res) => {
  const chatId = req.query['chat_id'] as string
  if (!chatId) {
    res.status(400).json({ error: 'chat_id required' })
    return
  }

  const token = nanoid(32)
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 minutes

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
// Secured by JWT_SECRET header so only the bot process can call it
authRouter.post('/telegram/generate-link', (req, res) => {
  const secret = req.headers['x-bot-secret']
  if (secret !== process.env['JWT_SECRET']) {
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

// POST /api/auth/telegram/link
// Called from the TelegramAuth web page after user opens the link
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

  // Link the Telegram chat to the authenticated user
  db.prepare(`
    INSERT OR REPLACE INTO telegram_links (chat_id, user_id)
    VALUES (?, ?)
  `).run(record.chat_id, req.user!.id)

  // Clean up the token
  db.prepare('DELETE FROM telegram_link_tokens WHERE token = ?').run(token)

  res.json({ ok: true, message: 'Telegram account linked successfully' })
})
