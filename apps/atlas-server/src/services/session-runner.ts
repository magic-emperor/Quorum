import { spawn } from 'child_process'
import type { Server as SocketServer } from 'socket.io'
import { db } from '../db/schema.js'
import { getUserApiKeys } from '../routes/apikeys.js'

// Shared Socket.IO server reference — set on startup
let io: SocketServer | null = null

export function setSocketServer(server: SocketServer): void {
  io = server
}

interface RunnerOptions {
  auto: boolean
}

/**
 * SessionRunner — spawns `atlas <command>` as a child process.
 * Captures stdout/stderr, emits Socket.IO events to subscribed clients,
 * and persists events to DB for history replay.
 */
export class SessionRunner {
  constructor(
    private sessionId: string,
    private userId: string
  ) {}

  async start(command: string, description: string, projectDir: string, opts: RunnerOptions): Promise<void> {
    // Inject user's decrypted API keys + auto flag into child process env
    const userKeys = getUserApiKeys(this.userId)

    const atlasArgs = [command]
    if (description) atlasArgs.push(description)
    atlasArgs.push('--dir', projectDir)
    // Only pass --auto for commands that accept it (new, enhance, fast)
    const autoSupportedCommands = ['new', 'enhance', 'fast']
    if (opts.auto && autoSupportedCommands.includes(command)) atlasArgs.push('--auto')


    const child = spawn('atlas', atlasArgs, {
      cwd: projectDir,
      env: {
        ...process.env,
        ...userKeys,
        ATLAS_SESSION_ID: this.sessionId,
        ATLAS_SERVER_MODE: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true
    })

    // Record PID in DB
    db.prepare("UPDATE sessions SET pid = ?, status = 'running', updated_at = datetime('now') WHERE id = ?")
      .run(child.pid ?? null, this.sessionId)

    const emit = (eventType: string, payload: unknown) => {
      const payloadStr = JSON.stringify(payload)

      // Persist to DB for replay
      db.prepare(`
        INSERT INTO session_events (session_id, event_type, payload)
        VALUES (?, ?, ?)
      `).run(this.sessionId, eventType, payloadStr)

      // Broadcast to all connected clients watching this session
      io?.to(`session:${this.sessionId}`).emit('session:event', {
        session_id: this.sessionId,
        event_type: eventType,
        payload
      })
    }

    // Stream stdout as progress events
    child.stdout?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(l => l.trim())
      for (const line of lines) {
        emit('progress', { message: line })
      }
    })

    // Stream stderr as error events (not fatal — ATLAS uses stderr for debug)
    child.stderr?.on('data', (chunk: Buffer) => {
      emit('stderr', { message: chunk.toString() })
    })

    // Handle process exit
    await new Promise<void>((resolve) => {
      child.on('close', (code) => {
        const status = code === 0 ? 'completed' : 'failed'
        db.prepare("UPDATE sessions SET status = ?, pid = NULL, updated_at = datetime('now') WHERE id = ?")
          .run(status, this.sessionId)
        emit('session:end', { status, exit_code: code })
        resolve()
      })

      child.on('error', (err) => {
        db.prepare("UPDATE sessions SET status = 'error', updated_at = datetime('now') WHERE id = ?")
          .run(this.sessionId)
        emit('session:end', { status: 'error', error: err.message })
        resolve()
      })
    })
  }
}
