import { Router } from 'express'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { verifyToken, type AuthRequest } from '../middleware/auth.js'
import { SessionRunner, getSocketServer } from '../services/session-runner.js'
import { db } from '../db/schema.js'

// ─── Watch Router ─────────────────────────────────────────────────────────────
// Manages long-running atlas watch sessions.
// The Teams/Slack bot calls POST /api/watch/start to begin monitoring a PM tool
// and POST /api/watch/stop to end the session.

export const watchRouter = Router()

// Validate bot-to-server secret on all watch routes
function validateBotSecret(req: AuthRequest, res: Parameters<typeof verifyToken>[1], next: Parameters<typeof verifyToken>[2]): void {
  const BOT_SECRET = process.env['BOT_SECRET'] ?? ''
  const header = req.headers['x-bot-secret']
  if (BOT_SECRET && header !== BOT_SECRET) {
    res.status(403).json({ error: 'Invalid bot secret' })
    return
  }
  next()
}

const StartWatchSchema = z.object({
  tool:        z.enum(['jira', 'linear', 'github-issues', 'azure-boards']),
  keyword:     z.string().min(1).max(100),
  project_dir: z.string().min(1),
  channel_id:  z.string().optional(),
  platform:    z.enum(['teams', 'slack', 'discord', 'telegram']).optional(),
  base_url:    z.string().optional(),
  token:       z.string().optional(),  // PM tool token — falls back to env vars
})

const StopWatchSchema = z.object({
  session_id: z.string()
})

// Active watch sessions: sessionId → { userId, tool, keyword, unsubscribe }
const activeSessions = new Map<string, {
  userId: string
  tool: string
  keyword: string
  projectDir: string
}>()

// POST /api/watch/start — begin monitoring a PM tool
watchRouter.post('/start', verifyToken, validateBotSecret, async (req: AuthRequest, res) => {
  const parsed = StartWatchSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() })
    return
  }

  const { tool, keyword, project_dir, channel_id, platform, base_url, token } = parsed.data
  const userId = req.user!.id
  const sessionId = nanoid()

  // Token resolution order: request body → environment variables
  const tokenEnvMap: Record<string, string> = {
    'jira':          'JIRA_TOKEN',
    'linear':        'LINEAR_TOKEN',
    'github-issues': 'GITHUB_TOKEN',
    'azure-boards':  'AZURE_DEVOPS_TOKEN'
  }
  const resolvedToken = token ?? process.env[tokenEnvMap[tool] ?? ''] ?? ''

  if (!resolvedToken) {
    res.status(400).json({ error: `No API token for ${tool}. Set ${tokenEnvMap[tool] ?? 'TOOL_TOKEN'} in server .env` })
    return
  }

  // Persist the watch session to DB
  db.prepare(`
    INSERT INTO sessions (id, user_id, command, description, status, project_dir)
    VALUES (?, ?, 'watch', ?, 'running', ?)
  `).run(sessionId, userId, `Watching ${tool} for "${keyword}"`, project_dir)

  activeSessions.set(sessionId, { userId, tool, keyword, projectDir: project_dir })

  // Spawn atlas watch in background
  const runner = new SessionRunner(sessionId, userId)
  runner.start(
    `watch --tool ${tool} --keyword "${keyword}"${base_url ? ` --base-url ${base_url}` : ''}`,
    `Watch ${tool} for ${keyword}`,
    project_dir,
    { auto: true }
  ).catch(err => {
    console.error(`Watch session ${sessionId} error:`, err)
    activeSessions.delete(sessionId)
    db.prepare("UPDATE sessions SET status = 'error', updated_at = datetime('now') WHERE id = ?")
      .run(sessionId)
  })

  // Emit to any connected clients that a watch session started
  const io = getSocketServer()
  if (io && channel_id) {
    io.emit('watch:started', {
      session_id: sessionId,
      tool,
      keyword,
      channel_id,
      platform: platform ?? 'teams'
    })
  }

  res.status(201).json({
    session_id: sessionId,
    tool,
    keyword,
    status: 'running',
    message: `Watching ${tool} for "${keyword}"`
  })
})

// POST /api/watch/stop — stop a watch session
watchRouter.post('/stop', verifyToken, validateBotSecret, (req: AuthRequest, res) => {
  const parsed = StopWatchSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input' })
    return
  }

  const { session_id } = parsed.data
  const session = activeSessions.get(session_id)

  if (!session) {
    // May have already stopped — check DB
    const dbSession = db.prepare('SELECT id, status FROM sessions WHERE id = ?').get(session_id) as { id: string; status: string } | undefined
    if (!dbSession) {
      res.status(404).json({ error: 'Watch session not found' })
      return
    }
    res.json({ ok: true, status: dbSession.status, message: 'Session already stopped' })
    return
  }

  // Kill the underlying atlas watch process
  const dbSession = db.prepare('SELECT pid FROM sessions WHERE id = ?').get(session_id) as { pid: number | null } | undefined
  if (dbSession?.pid) {
    try { process.kill(dbSession.pid, 'SIGINT') } catch { /* already dead */ }
  }

  activeSessions.delete(session_id)

  db.prepare("UPDATE sessions SET status = 'interrupted', pid = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(session_id)

  res.json({ ok: true, session_id, status: 'stopped', message: `Watch stopped for ${session.tool}` })
})

// GET /api/watch — list active watch sessions for the user
watchRouter.get('/', verifyToken, (req: AuthRequest, res) => {
  const sessions = db.prepare(`
    SELECT id, description, status, project_dir, created_at
    FROM sessions
    WHERE user_id = ? AND command = 'watch' AND status = 'running'
    ORDER BY created_at DESC
  `).all(req.user!.id)

  res.json({ sessions })
})
