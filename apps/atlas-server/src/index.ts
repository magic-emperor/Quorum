import 'dotenv/config'   // Load .env before anything else
import express from 'express'
import { createServer } from 'http'
import { Server as SocketServer } from 'socket.io'
import cors from 'cors'
import jwt from 'jsonwebtoken'
import { initDb } from './db/schema.js'
import { authRouter } from './routes/auth.js'
import { sessionsRouter } from './routes/sessions.js'
import { apiKeysRouter } from './routes/apikeys.js'
import { setSocketServer } from './services/session-runner.js'
import { startTelegramBot } from './services/telegram.js'

const PORT = parseInt(process.env['PORT'] ?? '3001', 10)
const ALLOWED_ORIGINS = (process.env['ALLOWED_ORIGINS'] ?? 'http://localhost:3000').split(',')
const JWT_SECRET = process.env['JWT_SECRET'] ?? 'atlas-dev-secret-change-in-production'

// ─── App ────────────────────────────────────────────────────────────────────
const app = express()
const httpServer = createServer(app)

// ─── Socket.IO ──────────────────────────────────────────────────────────────
const io = new SocketServer(httpServer, {
  cors: {
    origin: ALLOWED_ORIGINS,
    credentials: true
  }
})

// JWT auth for Socket.IO connections
io.use((socket, next) => {
  const token = socket.handshake.auth['token'] as string | undefined
  if (!token) {
    next(new Error('No token'))
    return
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { id: string; email: string }
    socket.data['user'] = payload
    next()
  } catch {
    next(new Error('Invalid token'))
  }
})

io.on('connection', (socket) => {
  const user = socket.data['user'] as { id: string; email: string }
  console.log(`Socket connected: ${user.email}`)

  // Client joins a session room to receive its events
  socket.on('session:join', (sessionId: string) => {
    socket.join(`session:${sessionId}`)
  })

  socket.on('session:leave', (sessionId: string) => {
    socket.leave(`session:${sessionId}`)
  })

  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${user.email}`)
  })
})

// Share io with runner
setSocketServer(io)

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }))
app.use(express.json())

// ─── Routes ─────────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter)
app.use('/api/sessions', sessionsRouter)
app.use('/api/keys', apiKeysRouter)

// Health check
app.get('/health', (_, res) => {
  res.json({ ok: true, version: '1.0.0' })
})

// ─── Startup ─────────────────────────────────────────────────────────────────
initDb()
startTelegramBot()

httpServer.listen(PORT, () => {
  console.log(`ATLAS Server running on port ${PORT}`)
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`)
})

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use.`)
    console.error(`   Kill the existing process with:`)
    console.error(`   PowerShell: Get-NetTCPConnection -LocalPort ${PORT} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`)
    console.error(`   Then run npm run dev again.\n`)
  } else {
    console.error('Server error:', err)
  }
  process.exit(1)
})
