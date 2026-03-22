import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../store/auth'

// Default well-known providers shown as quick-add buttons.
// Users can also add ANY custom provider via the custom field below.
const DEFAULT_PROVIDERS = [
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude)' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI (GPT-4)' },
  { key: 'GOOGLE_AI_API_KEY', label: 'Google (Gemini)' },
  { key: 'GROQ_API_KEY', label: 'Groq (LLaMA)' },
  { key: 'DEEPSEEK_API_KEY', label: 'DeepSeek' },
  { key: 'MISTRAL_API_KEY', label: 'Mistral' },
  { key: 'TOGETHER_API_KEY', label: 'Together AI' },
  { key: 'XAI_API_KEY', label: 'xAI (Grok)' },
  { key: 'COHERE_API_KEY', label: 'Cohere' },
]

interface StoredKey { id: string; provider: string; created_at: string }

export default function ApiKeys() {
  const [keys, setKeys] = useState<StoredKey[]>([])
  const [adding, setAdding] = useState<string | null>(null)
  const [keyValue, setKeyValue] = useState('')
  const [customProvider, setCustomProvider] = useState('')
  const [showCustom, setShowCustom] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [msgType, setMsgType] = useState<'success' | 'error'>('success')

  const reload = () => api.get<{ keys: StoredKey[] }>('/api/keys').then(r => setKeys(r.data.keys))
  useEffect(() => { reload() }, [])

  const save = async (providerName?: string) => {
    const provider = providerName ?? adding
    if (!provider || !keyValue.trim()) return
    setSaving(true)
    try {
      await api.post('/api/keys', { provider, key: keyValue.trim() })
      setMsg(`✓ ${provider} saved`)
      setMsgType('success')
      setAdding(null); setKeyValue(''); setCustomProvider(''); setShowCustom(false)
      reload()
    } catch (e: any) {
      setMsg(`❌ ${e.response?.data?.error ?? 'Failed to save'}`)
      setMsgType('error')
    }
    finally { setSaving(false) }
  }

  const saveCustom = () => {
    const trimmed = customProvider.trim().toUpperCase()
    if (!trimmed) { setMsg('❌ Enter a provider env var name'); setMsgType('error'); return }
    if (!/^[A-Z0-9_]+$/.test(trimmed)) { setMsg('❌ Must be UPPER_CASE letters, numbers, underscores only'); setMsgType('error'); return }
    save(trimmed)
  }

  const remove = async (provider: string) => {
    await api.delete(`/api/keys/${provider}`)
    setMsg(`${provider} removed`); setMsgType('success')
    reload()
  }

  const isConfigured = (k: string) => keys.some(s => s.provider === k)

  // Keys that are configured but not in the default list (custom providers)
  const customKeys = keys.filter(k => !DEFAULT_PROVIDERS.some(p => p.key === k.provider))

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <Link to="/" style={styles.back}>← Dashboard</Link>
        <span style={styles.logo}>API Keys</span>
      </header>
      <main style={styles.main}>
        <p style={styles.hint}>
          Keys are stored AES-256 encrypted in SQLite. Injected as env vars into your sessions.<br />
          <strong>Any provider with an API key env var is supported</strong> — add custom ones below.
        </p>

        {msg && (
          <div style={{ ...styles.msg, background: msgType === 'success' ? '#1a2a1a' : '#2a1a1a', color: msgType === 'success' ? '#34d399' : '#f87171' }}>
            {msg}
          </div>
        )}

        {/* Known providers */}
        {DEFAULT_PROVIDERS.map(p => (
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
                : <button style={styles.addBtn} onClick={() => { setAdding(p.key); setKeyValue(''); setShowCustom(false) }}>Add</button>
              }
            </div>
          </div>
        ))}

        {/* Custom configured providers (not in the default list) */}
        {customKeys.length > 0 && (
          <>
            <p style={{ ...styles.hint, marginTop: 20 }}>Custom providers:</p>
            {customKeys.map(k => (
              <div key={k.provider} style={styles.row}>
                <div>
                  <div style={styles.label}>{k.provider}</div>
                  <div style={styles.keyCode}>Custom</div>
                </div>
                <div style={styles.actions}>
                  <span style={styles.configured}>✓ Configured</span>
                  <button style={styles.removeBtn} onClick={() => remove(k.provider)}>Remove</button>
                </div>
              </div>
            ))}
          </>
        )}

        {/* Add custom provider */}
        <div style={styles.customSection}>
          <button
            style={styles.customToggle}
            onClick={() => { setShowCustom(s => !s); setAdding(null) }}
          >
            {showCustom ? '▲ Cancel custom' : '+ Add a different provider (Together AI, xAI, Ollama, etc.)'}
          </button>

          {showCustom && (
            <div style={styles.addPanel}>
              <p style={styles.addLabel}>Provider env var name (e.g. TOGETHER_API_KEY, OLLAMA_BASE_URL):</p>
              <input
                style={styles.input}
                placeholder="TOGETHER_API_KEY"
                value={customProvider}
                onChange={e => setCustomProvider(e.target.value.toUpperCase())}
                autoCapitalize="characters"
              />
              <p style={styles.addLabel}>API key value:</p>
              <input
                style={styles.input}
                type="password"
                placeholder="paste your key here"
                value={keyValue}
                onChange={e => setKeyValue(e.target.value)}
              />
              <div style={styles.addActions}>
                <button style={styles.cancelBtn} onClick={() => setShowCustom(false)}>Cancel</button>
                <button style={styles.saveBtn} onClick={saveCustom} disabled={saving}>
                  {saving ? 'Saving...' : 'Save Encrypted'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Inline key entry for known providers */}
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
              <button style={styles.saveBtn} onClick={() => save()} disabled={saving}>
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
  hint: { color: '#666', fontSize: 13, marginBottom: 16, lineHeight: 1.6 },
  msg: { padding: '10px 14px', borderRadius: 8, fontSize: 14, marginBottom: 16 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#12122a', borderRadius: 10, padding: 16, marginBottom: 8, border: '1px solid #2a2a4a' },
  label: { color: '#fff', fontSize: 15, fontWeight: 600 },
  keyCode: { color: '#666', fontSize: 12, marginTop: 2 },
  actions: { display: 'flex', alignItems: 'center', gap: 8 },
  configured: { color: '#34d399', fontSize: 13 },
  addBtn: { background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 700 },
  removeBtn: { background: 'none', border: '1px solid #7f1d1d', color: '#f87171', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 12 },
  customSection: { marginTop: 24 },
  customToggle: { background: 'none', border: '1px dashed #3a3a5a', color: '#7c3aed', borderRadius: 8, padding: '10px 16px', cursor: 'pointer', fontSize: 13, width: '100%' },
  addPanel: { background: '#12122a', border: '1px solid #7c3aed', borderRadius: 12, padding: 20, marginTop: 12 },
  addLabel: { color: '#a78bfa', fontSize: 13, marginBottom: 8 },
  input: { width: '100%', background: '#0a0a0a', color: '#fff', border: '1px solid #3a3a5a', borderRadius: 8, padding: '12px 14px', fontSize: 14, marginBottom: 12, boxSizing: 'border-box' },
  addActions: { display: 'flex', gap: 10 },
  cancelBtn: { background: 'none', border: '1px solid #3a3a5a', color: '#888', borderRadius: 8, padding: '10px 18px', cursor: 'pointer' },
  saveBtn: { background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', cursor: 'pointer', fontWeight: 700 }
}
