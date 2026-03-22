import React, { useEffect, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useAuthStore, api } from '../store/auth'

/**
 * TelegramAuth page — the critical Telegram linking flow:
 * 1. User on Telegram sends /login
 * 2. Bot sends: https://atlasconsole.app/telegram-auth?token=xxx
 * 3. User opens URL in browser (already logged in from previous session)
 * 4. This page reads ?token, calls POST /api/auth/telegram/link with the token + JWT
 * 5. Server links chat_id → user_id
 * 6. Page shows success, user returns to Telegram
 */
export default function TelegramAuth() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { token } = useAuthStore()
  const [status, setStatus] = useState<'idle' | 'linking' | 'success' | 'error'>('idle')
  const [message, setMessage] = useState('')

  useEffect(() => {
    const linkToken = params.get('token')
    if (!linkToken) {
      setStatus('error')
      setMessage('No token provided in URL.')
      return
    }

    if (!token) {
      // Not logged in — redirect to login and come back
      navigate(`/login?next=/telegram-auth?token=${linkToken}`)
      return
    }

    setStatus('linking')
    api.post('/api/auth/telegram/link', { token: linkToken })
      .then(() => {
        setStatus('success')
        setMessage('✅ Telegram linked! Return to Telegram and start using ATLAS.')
      })
      .catch((err) => {
        setStatus('error')
        setMessage(err.response?.data?.error ?? 'Linking failed. Try /login again on Telegram.')
      })
  }, [])

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.logo}>⚡ ATLAS</div>
        <h1 style={styles.title}>Telegram Linking</h1>

        {status === 'idle' || status === 'linking'
          ? <div style={styles.spinner}>🔄 Linking your Telegram account...</div>
          : status === 'success'
          ? <>
              <div style={styles.success}>{message}</div>
              <button style={styles.btn} onClick={() => window.close()}>Close Tab</button>
            </>
          : <>
              <div style={styles.error}>{message}</div>
              <button style={styles.btn} onClick={() => navigate('/login')}>Go to Login</button>
            </>
        }
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a1a', padding: 24 },
  card: { background: '#12122a', borderRadius: 16, padding: 40, maxWidth: 480, width: '100%', border: '1px solid #2a2a4a', textAlign: 'center' },
  logo: { fontSize: 32, color: '#7c3aed', fontWeight: 900, marginBottom: 8 },
  title: { color: '#fff', fontSize: 20, marginBottom: 24 },
  spinner: { color: '#888', fontSize: 16 },
  success: { color: '#34d399', fontSize: 18, marginBottom: 24, lineHeight: 1.6 },
  error: { color: '#f87171', fontSize: 16, marginBottom: 24, lineHeight: 1.6 },
  btn: { background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 8, padding: '12px 24px', fontSize: 15, cursor: 'pointer', fontWeight: 700 }
}
