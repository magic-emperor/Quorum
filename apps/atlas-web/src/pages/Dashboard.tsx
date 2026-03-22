import React, { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { io, Socket } from 'socket.io-client'
import { useAuthStore, api } from '../store/auth'

interface Session {
  id: string; command: string; description: string
  status: string; created_at: string
}
interface TerminalLine { id: number; text: string; type: 'output' | 'system' | 'error' }

const SERVER_URL = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3001'
const statusColor: Record<string, string> = {
  pending: '#f59e0b', running: '#3b82f6', completed: '#10b981',
  failed: '#ef4444', interrupted: '#6b7280', error: '#ef4444'
}
const statusEmoji: Record<string, string> = {
  pending: '⏳', running: '🔄', completed: '✅', failed: '❌', interrupted: '⬛', error: '⚠️'
}

export default function Dashboard() {
  const { email, token, logout } = useAuthStore()
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)

  // Run Command panel state
  const [showRunner, setShowRunner] = useState(false)
  const [command, setCommand] = useState('new')
  const [description, setDescription] = useState('')
  const [projectDir, setProjectDir] = useState('')
  const [autoMode, setAutoMode] = useState(true)
  const [running, setRunning] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([])
  const socketRef = useRef<Socket | null>(null)
  const terminalRef = useRef<HTMLDivElement>(null)

  const loadSessions = () => {
    api.get<{ sessions: Session[] }>('/api/sessions')
      .then(r => setSessions(r.data.sessions))
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadSessions() }, [])

  // Auto-scroll terminal
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight
    }
  }, [terminalLines])

  const addLine = (text: string, type: TerminalLine['type'] = 'output') => {
    setTerminalLines(ls => [...ls, { id: Date.now() + Math.random(), text, type }])
  }

  const runCommand = async () => {
    if (!description.trim() || !projectDir.trim()) return
    setRunning(true)
    setTerminalLines([])
    addLine(`► atlas ${command} "${description}" --dir "${projectDir}"${autoMode ? ' --auto' : ''}`, 'system')

    try {
      const res = await api.post<{ session_id: string }>('/api/sessions/execute', {
        command, description, project_dir: projectDir, auto: autoMode
      })
      const sessionId = res.data.session_id
      setActiveSessionId(sessionId)
      addLine(`Session started: ${sessionId}`, 'system')

      // Connect socket and stream events
      const socket = io(SERVER_URL, { auth: { token } })
      socketRef.current = socket

      socket.on('connect', () => {
        socket.emit('session:join', sessionId)
        addLine('Connected to session stream ✓', 'system')
      })

      socket.on('session:event', (event: { event_type: string; payload: { message?: string; status?: string; exit_code?: number } }) => {
        if (event.event_type === 'progress' && event.payload.message) {
          addLine(event.payload.message)
        } else if (event.event_type === 'session:end') {
          addLine(`● Session ${event.payload.status} (exit: ${event.payload.exit_code ?? '?'})`, 'system')
          setRunning(false)
          socket.disconnect()
          loadSessions()
        } else if (event.event_type === 'stderr' && event.payload.message) {
          addLine(event.payload.message, 'error')
        }
      })

      socket.on('disconnect', () => addLine('Disconnected', 'system'))
    } catch (err: any) {
      addLine(`Error: ${err.response?.data?.error ?? err.message}`, 'error')
      setRunning(false)
    }
  }

  const interrupt = async () => {
    if (activeSessionId) {
      await api.post(`/api/sessions/${activeSessionId}/interrupt`)
      socketRef.current?.disconnect()
      addLine('⬛ Interrupted', 'system')
      setRunning(false)
    }
  }

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <span style={styles.logo}>⚡ ATLAS Console</span>
        <nav style={styles.nav}>
          <button style={styles.runBtn} onClick={() => setShowRunner(r => !r)}>
            {showRunner ? '✕ Close' : '▶ Run Command'}
          </button>
          <Link to="/keys" style={styles.navLink}>API Keys</Link>
          <span style={styles.emailText}>{email}</span>
          <button style={styles.logoutBtn} onClick={logout}>Logout</button>
        </nav>
      </header>

      {/* Run Command panel */}
      {showRunner && (
        <div style={styles.runnerPanel}>
          <div style={styles.runnerForm}>
            <select value={command} onChange={e => setCommand(e.target.value)} style={styles.select}>
              <option value="new">atlas new</option>
              <option value="enhance">atlas enhance</option>
              <option value="fast">atlas fast</option>
              <option value="discuss">atlas discuss</option>
              <option value="map">atlas map</option>
              <option value="verify">atlas verify</option>
              <option value="doctor">atlas doctor</option>
              <option value="export">atlas export</option>
            </select>
            <input
              style={styles.input}
              placeholder='Description e.g. "Add user authentication"'
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
            <input
              style={styles.input}
              placeholder="Project directory e.g. C:\\Users\\Faiza\\myproject"
              value={projectDir}
              onChange={e => setProjectDir(e.target.value)}
            />
            <div style={styles.runnerActions}>
              <label style={styles.checkLabel}>
                <input type="checkbox" checked={autoMode} onChange={e => setAutoMode(e.target.checked)} />
                &nbsp;--auto (CI/CD mode, skip checkpoints)
              </label>
              {running
                ? <button style={styles.stopBtn} onClick={interrupt}>⬛ Stop</button>
                : <button style={styles.goBtn} onClick={runCommand} disabled={!description || !projectDir}>
                    ▶ Run
                  </button>
              }
            </div>
          </div>

          {/* Terminal output */}
          {terminalLines.length > 0 && (
            <div ref={terminalRef} style={styles.terminal}>
              {terminalLines.map(line => (
                <div key={line.id} style={{
                  color: line.type === 'error' ? '#f87171' : line.type === 'system' ? '#f59e0b' : '#d1d5db',
                  fontFamily: 'Menlo, Consolas, monospace',
                  fontSize: 13,
                  lineHeight: '1.6',
                  padding: '1px 0'
                }}>{line.text}</div>
              ))}
              {running && <div style={{ color: '#7c3aed', animation: 'pulse 1s infinite' }}>▋</div>}
            </div>
          )}
        </div>
      )}

      <main style={styles.main}>
        <h1 style={styles.title}>Sessions</h1>
        {loading
          ? <p style={styles.hint}>Loading...</p>
          : sessions.length === 0
          ? <div style={styles.empty}>
              <p>No sessions yet.</p>
              <p style={styles.hint}>Click <strong>▶ Run Command</strong> above or run <code>atlas new "..."</code> in your terminal.</p>
            </div>
          : <div style={styles.sessionList}>
              {sessions.map(s => (
                <div key={s.id} style={styles.sessionCard}>
                  <div style={styles.sessionHeader}>
                    <code style={styles.command}>atlas {s.command}</code>
                    <span style={{ color: statusColor[s.status] ?? '#888' }}>
                      {statusEmoji[s.status] ?? '?'} {s.status}
                    </span>
                  </div>
                  {s.description && <p style={styles.description}>{s.description}</p>}
                  <p style={styles.date}>{new Date(s.created_at).toLocaleString()}</p>
                </div>
              ))}
            </div>
        }
      </main>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { minHeight: '100vh', background: '#0a0a1a' },
  header: { background: '#12122a', borderBottom: '1px solid #2a2a4a', padding: '16px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  logo: { color: '#7c3aed', fontWeight: 900, fontSize: 20 },
  nav: { display: 'flex', alignItems: 'center', gap: 12 },
  runBtn: { background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 700 },
  navLink: { color: '#7c3aed', textDecoration: 'none', fontSize: 14 },
  emailText: { color: '#888', fontSize: 14 },
  logoutBtn: { background: 'none', border: '1px solid #3a3a5a', color: '#888', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13 },
  runnerPanel: { background: '#0e0e24', borderBottom: '1px solid #2a2a4a', padding: '20px 24px' },
  runnerForm: { maxWidth: 800, margin: '0 auto', display: 'flex', flexDirection: 'column' as const, gap: 10 },
  select: { background: '#1a1a2e', color: '#fff', border: '1px solid #3a3a5a', borderRadius: 8, padding: '10px 12px', fontSize: 14 },
  input: { background: '#1a1a2e', color: '#fff', border: '1px solid #3a3a5a', borderRadius: 8, padding: '10px 12px', fontSize: 14 },
  runnerActions: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  checkLabel: { color: '#888', fontSize: 13, display: 'flex', alignItems: 'center' },
  goBtn: { background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: 'pointer', fontWeight: 700, fontSize: 14 },
  stopBtn: { background: '#7f1d1d', color: '#fca5a5', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: 'pointer', fontWeight: 700, fontSize: 14 },
  terminal: { maxWidth: 800, margin: '16px auto 0', background: '#040408', borderRadius: 8, padding: 16, maxHeight: 400, overflowY: 'auto' as const, border: '1px solid #2a2a4a' },
  main: { maxWidth: 800, margin: '0 auto', padding: '32px 24px' },
  title: { color: '#fff', fontSize: 24, fontWeight: 800, marginBottom: 24 },
  hint: { color: '#666', fontSize: 14 },
  empty: { textAlign: 'center' as const, color: '#888', padding: '48px 0' },
  sessionList: { display: 'flex', flexDirection: 'column' as const, gap: 12 },
  sessionCard: { background: '#12122a', borderRadius: 12, padding: 20, border: '1px solid #2a2a4a' },
  sessionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  command: { color: '#a78bfa', fontSize: 14, background: '#1e1040', padding: '4px 8px', borderRadius: 4 },
  description: { color: '#d1d5db', fontSize: 14, marginBottom: 8 },
  date: { color: '#555', fontSize: 12 }
}
