import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import type { Server as SocketServer } from 'socket.io'
import { db } from '../db/schema.js'
import { getUserApiKeys } from '../routes/apikeys.js'

// Shared Socket.IO server reference — set on startup
let io: SocketServer | null = null

export function setSocketServer(server: SocketServer): void {
  io = server
}

export function getSocketServer(): SocketServer | null {
  return io
}

interface RunnerOptions {
  auto: boolean
}

/**
 * Sanitize and validate `projectDir`.
 * Must be an absolute path — prevents path-traversal attacks like ../../etc.
 */
function sanitizeProjectDir(raw: string): string {
  const resolved = path.resolve(raw)
  if (!path.isAbsolute(resolved)) {
    throw new Error(`project_dir must be an absolute path. Got: ${raw}`)
  }
  return resolved
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

  async start(command: string, description: string, projectDirRaw: string, opts: RunnerOptions): Promise<void> {
    // Sanitize project directory — prevents path traversal attacks
    let projectDir: string
    try {
      projectDir = sanitizeProjectDir(projectDirRaw)
    } catch (e) {
      const msg = (e as Error).message
      db.prepare("UPDATE sessions SET status = 'error', updated_at = datetime('now') WHERE id = ?")
        .run(this.sessionId)
      io?.to(`session:${this.sessionId}`).emit('session:event', {
        session_id: this.sessionId,
        event_type: 'session:end',
        payload: { status: 'error', error: msg }
      })
      return
    }

    // Inject user's decrypted API keys + auto flag into child process env
    const userKeys = getUserApiKeys(this.userId)

    let atlasArgs: string[] = []
    if (typeof command === 'string') {
      const parts = command.trim().split(' ')
      const cmdStart = parts[0]
      // Commands that take <description> as a required positional argument
      const descriptionCommands = ['new', 'enhance', 'fast', 'debug']
      if (descriptionCommands.includes(cmdStart ?? '')) {
        if (parts.length > 1) {
          atlasArgs = [cmdStart!, parts.slice(1).join(' ')]
        } else if (description && !description.startsWith('Triggered from Telegram')) {
          atlasArgs = [cmdStart!, description]
        } else {
          atlasArgs = [cmdStart!]
        }
      } else {
        atlasArgs = parts
      }
    } else if (Array.isArray(command)) {
      atlasArgs = command
    }
    atlasArgs.push('--dir', projectDir)
    // Only pass --no-checkpoints for commands that accept it
    const cmdStart = atlasArgs[0]
    if (opts.auto && cmdStart === 'new') {
      atlasArgs.push('--no-checkpoints')
    }

    // Clear stale nervous-system + context from previous runs before atlas new.
    // Without this, old tech decisions (e.g. React/Node from a failed run) bleed
    // into new unrelated tasks and corrupt the critic's evaluation.
    if (cmdStart === 'new') {
      for (const staleDir of ['nervous-system', 'context']) {
        const dir = path.join(projectDir, '.atlas', staleDir)
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true })
        }
      }
    }

    // QUORUM_SHOW_TERMINAL=1 → launch in a visible terminal window
    const showTerminal = process.env['QUORUM_SHOW_TERMINAL'] === '1'

    // On Windows, shell metacharacters in args break cmd.exe even when passed as an array.
    // Quote any arg that contains spaces or shell-special characters.
    const escapeArg = (arg: string) => {
      if (/[ \t|&<>^"!;]/.test(arg)) {
        return `"${arg.replace(/"/g, '\\"')}"`
      }
      return arg
    }
    const escapedAtlasArgs = atlasArgs.map(escapeArg)
    const escapedArgString = escapedAtlasArgs.join(' ')

    const childEnv = {
      ...process.env,
      ...userKeys,
      QUORUM_SESSION_ID: this.sessionId,
      QUORUM_SERVER_MODE: '1'
    }

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

    // ── showTerminal mode: fire-and-forget ─────────────────────────────────────
    // The spawned process here is just a shell launcher — its stdout is never piped back.
    // We mark the session as 'started' and return immediately.
    if (showTerminal) {
      let child: ReturnType<typeof spawn>
      if (process.platform === 'win32') {
        // Use ComSpec (the system's actual cmd.exe) — avoids ENOENT on Node.js v20+
        const cmdExe = process.env['ComSpec'] ?? 'C:\\Windows\\System32\\cmd.exe'
        child = spawn(cmdExe, ['/c', `start "QUORUM" "${cmdExe}" /k "atlas ${escapedArgString}"`], {
          cwd: projectDir, env: childEnv, shell: false, detached: true
        })
      } else if (process.platform === 'darwin') {
        child = spawn('osascript', [
          '-e', `tell app "Terminal" to do script "cd '${projectDir}' && atlas ${escapedArgString}"`
        ], { cwd: projectDir, env: childEnv, shell: false, detached: true })
      } else {
        child = spawn('x-terminal-emulator', ['-e', `bash -c "atlas ${escapedArgString}; exec bash"`], {
          cwd: projectDir, env: childEnv, shell: false, detached: true
        })
      }

      // CRITICAL: add error handler BEFORE unref() — a spawn failure (ENOENT, permissions)
      // emits 'error'. Without a handler this crashes Node.js with unhandled exception.
      child.on('error', (err) => {
        console.error(`[SessionRunner] showTerminal spawn failed: ${err.message}`)
        db.prepare("UPDATE sessions SET status = 'error', updated_at = datetime('now') WHERE id = ?")
          .run(this.sessionId)
        emit('session:end', { status: 'error', error: `Terminal launch failed: ${err.message}` })
      })

      // Detach cleanly — do NOT await or capture stdout from the launcher shell
      child.unref()

      db.prepare("UPDATE sessions SET pid = ?, status = 'started', updated_at = datetime('now') WHERE id = ?")
        .run(child.pid ?? null, this.sessionId)

      emit('progress', { message: `Session launched in external terminal. PID: ${child.pid ?? 'unknown'}` })
      emit('session:started', { pid: child.pid ?? null, external_terminal: true })
      return
    }

    // ── Normal mode: piped output ──────────────────────────────────────────────
    const child = spawn('atlas', escapedAtlasArgs, {
      cwd: projectDir,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true
    })

    // Record PID in DB
    db.prepare("UPDATE sessions SET pid = ?, status = 'running', updated_at = datetime('now') WHERE id = ?")
      .run(child.pid ?? null, this.sessionId)

    // Stream stdout as progress events — skip pure decorator lines
    const isDecorator = (line: string) => /^[\s─═╔╗╚╝║\-=*#]+$/.test(line)
    child.stdout?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(l => l.trim() && !isDecorator(l))
      for (const line of lines) {
        emit('progress', { message: line })
      }
    })

    // Collect stderr to detect NEEDS_FULL_PIPELINE signal from atlas fast
    let stderrBuffer = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderrBuffer += text
      emit('stderr', { message: text })
    })

    // Handle process exit
    await new Promise<void>((resolve) => {
      child.on('close', async (code) => {
        // atlas fast exits with code 1 + NEEDS_FULL_PIPELINE when the task is too large.
        // Fall back to atlas new with the same description rather than marking as failed.
        if (code !== 0 && atlasArgs[0] === 'fast' && stderrBuffer.includes('NEEDS_FULL_PIPELINE')) {
          emit('progress', { message: '⚠️ Task too large for fast mode — escalating to atlas new...' })

          // Clear stale context before escalating to atlas new
          for (const staleDir of ['nervous-system', 'context']) {
            const dir = path.join(projectDir, '.atlas', staleDir)
            if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
          }

          const newArgs = ['new', ...escapedAtlasArgs.slice(1)] // swap 'fast' → 'new'
          const newChild = spawn('atlas', newArgs, {
            cwd: projectDir,
            env: childEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true
          })

          db.prepare("UPDATE sessions SET pid = ?, status = 'running', updated_at = datetime('now') WHERE id = ?")
            .run(newChild.pid ?? null, this.sessionId)

          newChild.stdout?.on('data', (chunk: Buffer) => {
            const lines = chunk.toString().split('\n').filter(l => l.trim() && !isDecorator(l))
            for (const line of lines) emit('progress', { message: line })
          })
          newChild.stderr?.on('data', (chunk: Buffer) => {
            emit('stderr', { message: chunk.toString() })
          })
          newChild.on('close', (newCode) => {
            const status = newCode === 0 ? 'completed' : 'failed'
            db.prepare("UPDATE sessions SET status = ?, pid = NULL, updated_at = datetime('now') WHERE id = ?")
              .run(status, this.sessionId)
            emit('session:end', { status, exit_code: newCode })
            resolve()
          })
          newChild.on('error', (err) => {
            db.prepare("UPDATE sessions SET status = 'error', updated_at = datetime('now') WHERE id = ?")
              .run(this.sessionId)
            emit('session:end', { status: 'error', error: err.message })
            resolve()
          })
          return
        }

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
