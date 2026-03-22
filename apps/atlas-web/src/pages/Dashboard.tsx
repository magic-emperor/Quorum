import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuthStore, api } from '../store/auth'

interface Session {
  id: string; command: string; description: string
  status: string; created_at: string
}

const statusColor: Record<string, string> = {
  pending: '#f59e0b', running: '#3b82f6', completed: '#10b981',
  failed: '#ef4444', interrupted: '#6b7280', error: '#ef4444'
}

const statusEmoji: Record<string, string> = {
  pending: '⏳', running: '🔄', completed: '✅', failed: '❌', interrupted: '⬛', error: '⚠️'
}

export default function Dashboard() {
  const { email, logout } = useAuthStore()
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get<{ sessions: Session[] }>('/api/sessions')
      .then(r => setSessions(r.data.sessions))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <span style={styles.logo}>⚡ ATLAS Console</span>
        <nav style={styles.nav}>
          <Link to="/keys" style={styles.navLink}>API Keys</Link>
          <span style={styles.email}>{email}</span>
          <button style={styles.logoutBtn} onClick={logout}>Logout</button>
        </nav>
      </header>

      <main style={styles.main}>
        <h1 style={styles.title}>Sessions</h1>
        {loading
          ? <p style={styles.hint}>Loading...</p>
          : sessions.length === 0
          ? <div style={styles.empty}>
              <p>No sessions yet.</p>
              <p style={styles.hint}>Run <code>atlas new "your feature"</code> in your terminal.</p>
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
  nav: { display: 'flex', alignItems: 'center', gap: 16 },
  navLink: { color: '#7c3aed', textDecoration: 'none', fontSize: 14 },
  email: { color: '#888', fontSize: 14 },
  logoutBtn: { background: 'none', border: '1px solid #3a3a5a', color: '#888', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13 },
  main: { maxWidth: 800, margin: '0 auto', padding: '32px 24px' },
  title: { color: '#fff', fontSize: 24, fontWeight: 800, marginBottom: 24 },
  hint: { color: '#666', fontSize: 14, marginTop: 8 },
  empty: { textAlign: 'center', color: '#888', padding: '48px 0' },
  sessionList: { display: 'flex', flexDirection: 'column', gap: 12 },
  sessionCard: { background: '#12122a', borderRadius: 12, padding: 20, border: '1px solid #2a2a4a' },
  sessionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  command: { color: '#a78bfa', fontSize: 14, background: '#1e1040', padding: '4px 8px', borderRadius: 4 },
  description: { color: '#d1d5db', fontSize: 14, marginBottom: 8 },
  date: { color: '#555', fontSize: 12 }
}
