import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/auth'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isRegistering, setIsRegistering] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { login, register } = useAuthStore()
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (isRegistering) await register(email, password)
      else await login(email, password)
      navigate('/')
    } catch (err: any) {
      setError(err.response?.data?.error ?? 'Authentication failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={styles.container}>
      <form style={styles.card} onSubmit={handleSubmit}>
        <div style={styles.logo}>⚡ ATLAS</div>
        <p style={styles.subtitle}>Console</p>
        {error && <div style={styles.error}>{error}</div>}
        <input id="email" style={styles.input} type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" required />
        <input id="password" style={styles.input} type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
        <button id="submit-btn" style={styles.btn} type="submit" disabled={loading}>
          {loading ? '...' : isRegistering ? 'Create Account' : 'Sign In'}
        </button>
        <button type="button" style={styles.switchBtn} onClick={() => setIsRegistering(r => !r)}>
          {isRegistering ? 'Already have an account? Sign in' : "Don't have an account? Register"}
        </button>
      </form>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a1a' },
  card: { background: '#12122a', borderRadius: 16, padding: 40, width: 400, display: 'flex', flexDirection: 'column', gap: 12, border: '1px solid #2a2a4a' },
  logo: { fontSize: 36, textAlign: 'center', color: '#7c3aed', fontWeight: 900 },
  subtitle: { textAlign: 'center', color: '#888', marginBottom: 12 },
  error: { background: '#7f1d1d', color: '#fca5a5', padding: '10px 14px', borderRadius: 8, fontSize: 14 },
  input: { background: '#0a0a0a', color: '#fff', border: '1px solid #2a2a4a', borderRadius: 8, padding: '12px 14px', fontSize: 15 },
  btn: { background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 8, padding: '13px', fontSize: 16, fontWeight: 700, cursor: 'pointer' },
  switchBtn: { background: 'none', border: 'none', color: '#7c3aed', fontSize: 14, cursor: 'pointer' }
}
