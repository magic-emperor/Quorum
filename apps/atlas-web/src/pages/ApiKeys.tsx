import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../store/auth'

const PROVIDERS = [
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude)' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI (GPT-4)' },
  { key: 'GOOGLE_AI_API_KEY', label: 'Google (Gemini)' },
  { key: 'GROQ_API_KEY', label: 'Groq (LLaMA)' },
  { key: 'DEEPSEEK_API_KEY', label: 'DeepSeek' },
  { key: 'MISTRAL_API_KEY', label: 'Mistral' },
]

interface StoredKey { id: string; provider: string; created_at: string }

export default function ApiKeys() {
  const [keys, setKeys] = useState<StoredKey[]>([])
  const [adding, setAdding] = useState<string | null>(null)
  const [keyValue, setKeyValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const reload = () => api.get<{ keys: StoredKey[] }>('/api/keys').then(r => setKeys(r.data.keys))
  useEffect(() => { reload() }, [])

  const save = async () => {
    if (!adding || !keyValue.trim()) return
    setSaving(true)
    try {
      await api.post('/api/keys', { provider: adding, key: keyValue.trim() })
      setMsg(`✓ ${adding} saved`)
      setAdding(null); setKeyValue('')
      reload()
    } catch { setMsg('❌ Failed to save') }
    finally { setSaving(false) }
  }

  const remove = async (provider: string) => {
    await api.delete(`/api/keys/${provider}`)
    setMsg(`${provider} removed`)
    reload()
  }

  const isConfigured = (k: string) => keys.some(s => s.provider === k)

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <Link to="/" style={styles.back}>← Dashboard</Link>
        <span style={styles.logo}>API Keys</span>
      </header>
      <main style={styles.main}>
        <p style={styles.hint}>Keys are stored AES-256 encrypted. Only injected into your sessions.</p>
        {msg && <div style={styles.msg}>{msg}</div>}
        {PROVIDERS.map(p => (
          <div key={p.key} style={styles.row}>
            <div>
              <div style={styles.label}>{p.label}</div>
              <div style={styles.keyCode}>{p.key}</div>
            </div>
            <div style={styles.actions}>
              {isConfigured(p.key)
                ? <>
                    <span style={styles.configured}>✓ Configured</span>
                    <button style={styles.removeBtn} onClick={() => remove(p.key)}>Remove</button>
                  </>
                : <button style={styles.addBtn} onClick={() => { setAdding(p.key); setKeyValue('') }}>Add</button>
              }
            </div>
          </div>
        ))}
        {adding && (
          <div style={styles.addPanel}>
            <p style={styles.addLabel}>Enter key for {adding}:</p>
            <input
              id="key-input"
              style={styles.input}
              type="password"
              placeholder="sk-..."
              value={keyValue}
              onChange={e => setKeyValue(e.target.value)}
              autoFocus
            />
            <div style={styles.addActions}>
              <button style={styles.cancelBtn} onClick={() => setAdding(null)}>Cancel</button>
              <button style={styles.saveBtn} onClick={save} disabled={saving}>
                {saving ? 'Saving...' : 'Save Encrypted'}
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { minHeight: '100vh', background: '#0a0a1a' },
  header: { background: '#12122a', borderBottom: '1px solid #2a2a4a', padding: '16px 24px', display: 'flex', alignItems: 'center', gap: 20 },
  back: { color: '#7c3aed', textDecoration: 'none', fontSize: 14 },
  logo: { color: '#fff', fontWeight: 800, fontSize: 18 },
  main: { maxWidth: 680, margin: '0 auto', padding: '32px 24px' },
  hint: { color: '#666', fontSize: 13, marginBottom: 24 },
  msg: { background: '#1a2a1a', color: '#34d399', padding: '10px 14px', borderRadius: 8, fontSize: 14, marginBottom: 16 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#12122a', borderRadius: 10, padding: 16, marginBottom: 8, border: '1px solid #2a2a4a' },
  label: { color: '#fff', fontSize: 15, fontWeight: 600 },
  keyCode: { color: '#666', fontSize: 12, marginTop: 2 },
  actions: { display: 'flex', alignItems: 'center', gap: 8 },
  configured: { color: '#34d399', fontSize: 13 },
  addBtn: { background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 700 },
  removeBtn: { background: 'none', border: '1px solid #7f1d1d', color: '#f87171', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 12 },
  addPanel: { background: '#12122a', border: '1px solid #7c3aed', borderRadius: 12, padding: 20, marginTop: 16 },
  addLabel: { color: '#a78bfa', fontSize: 14, marginBottom: 10 },
  input: { width: '100%', background: '#0a0a0a', color: '#fff', border: '1px solid #3a3a5a', borderRadius: 8, padding: '12px 14px', fontSize: 14, marginBottom: 12 },
  addActions: { display: 'flex', gap: 10 },
  cancelBtn: { background: 'none', border: '1px solid #3a3a5a', color: '#888', borderRadius: 8, padding: '10px 18px', cursor: 'pointer' },
  saveBtn: { background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', cursor: 'pointer', fontWeight: 700 }
}
