import { Router } from 'express'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { db } from '../db/schema.js'
import { verifyToken, type AuthRequest } from '../middleware/auth.js'
import { SessionRunner } from '../services/session-runner.js'

export const sessionsRouter = Router()

const ExecuteSchema = z.object({
  command: z.string(),
  description: z.string().optional(),
  project_dir: z.string(),
  auto: z.boolean().optional()
})

// POST /api/sessions/execute — spawn a new pipeline session
sessionsRouter.post('/execute', verifyToken, async (req: AuthRequest, res) => {
  const parsed = ExecuteSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() })
    return
  }

  const { command, description, project_dir, auto } = parsed.data
  const sessionId = nanoid()

  db.prepare(`
    INSERT INTO sessions (id, user_id, command, description, status, project_dir)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(sessionId, req.user!.id, command, description ?? null, project_dir)

  // Spawn the session asynchronously
  const runner = new SessionRunner(sessionId, req.user!.id)
  runner.start(command, description ?? '', project_dir, { auto: auto ?? false })
    .catch(err => {
      db.prepare("UPDATE sessions SET status = 'error', updated_at = datetime('now') WHERE id = ?")
        .run(sessionId)
      console.error(`Session ${sessionId} error:`, err)
    })

  res.status(201).json({ session_id: sessionId, status: 'pending' })
})

// POST /api/sessions/:id/interrupt
sessionsRouter.post('/:id/interrupt', verifyToken, (req: AuthRequest, res) => {
  const session = db.prepare(
    'SELECT id, user_id, pid FROM sessions WHERE id = ? AND user_id = ?'
  ).get(req.params['id'], req.user!.id) as { id: string; user_id: string; pid: number | null } | undefined

  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  if (session.pid) {
    try {
      process.kill(session.pid, 'SIGINT')
    } catch {
      // Process may have already exited
    }
  }

  db.prepare("UPDATE sessions SET status = 'interrupted', updated_at = datetime('now') WHERE id = ?")
    .run(session.id)

  res.json({ ok: true })
})

// POST /api/sessions/stop — stop the latest running session for a project
sessionsRouter.post('/stop', verifyToken, (req: AuthRequest, res) => {
  const { session_id, project_dir, stop_latest } = req.body as {
    session_id?: string
    project_dir?: string
    stop_latest?: boolean
  }

  let session: { id: string; pid: number | null } | undefined

  if (session_id) {
    session = db.prepare(
      'SELECT id, pid FROM sessions WHERE id = ? AND user_id = ?'
    ).get(session_id, req.user!.id) as typeof session
  } else if (project_dir && stop_latest) {
    session = db.prepare(`
      SELECT id, pid FROM sessions
      WHERE user_id = ? AND project_dir = ? AND status IN ('running','pending','started')
      ORDER BY created_at DESC LIMIT 1
    `).get(req.user!.id, project_dir) as typeof session
  }

  if (!session) {
    res.status(404).json({ error: 'No running session found' })
    return
  }

  if (session.pid) {
    try { process.kill(session.pid, 'SIGINT') } catch { /* already gone */ }
  }

  db.prepare("UPDATE sessions SET status = 'interrupted', pid = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(session.id)

  res.json({
    ok: true,
    session_id: session.id,
    status: 'interrupted',
    message: 'Session interrupted. Run atlas resume to continue.'
  })
})

// GET /api/sessions — list user's sessions
sessionsRouter.get('/', verifyToken, (req: AuthRequest, res) => {
  const sessions = db.prepare(`
    SELECT id, command, description, status, project_dir, created_at, updated_at
    FROM sessions
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(req.user!.id)

  res.json({ sessions })
})

// GET /api/sessions/:id — session details + recent events
sessionsRouter.get('/:id', verifyToken, (req: AuthRequest, res) => {
  const session = db.prepare(`
    SELECT id, command, description, status, project_dir, created_at, updated_at
    FROM sessions WHERE id = ? AND user_id = ?
  `).get(req.params['id'], req.user!.id)

  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  const events = db.prepare(`
    SELECT id, event_type, payload, created_at
    FROM session_events
    WHERE session_id = ?
    ORDER BY id ASC
    LIMIT 500
  `).all(req.params['id'])

  res.json({ session, events })
})
