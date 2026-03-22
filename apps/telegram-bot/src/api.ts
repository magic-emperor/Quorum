import axios from 'axios'

const SERVER_URL = process.env['ATLAS_SERVER_URL'] ?? 'http://localhost:3001'

export const api = axios.create({
  baseURL: SERVER_URL,
  timeout: 10000
})

export interface SessionSummary {
  id: string
  command: string
  description: string
  status: string
  created_at: string
}

export async function getStatus(userId: string, botToken: string): Promise<SessionSummary | null> {
  try {
    const res = await api.get<{ sessions: SessionSummary[] }>('/api/sessions', {
      headers: { Authorization: `Bearer ${botToken}` }
    })
    return res.data.sessions[0] ?? null
  } catch {
    return null
  }
}

export async function interruptSession(sessionId: string, botToken: string): Promise<boolean> {
  try {
    await api.post(`/api/sessions/${sessionId}/interrupt`, {}, {
      headers: { Authorization: `Bearer ${botToken}` }
    })
    return true
  } catch {
    return false
  }
}

export async function generateLinkToken(chatId: string, botToken: string): Promise<string | null> {
  try {
    const res = await api.get<{ url: string }>('/api/auth/telegram/link-token', {
      params: { chat_id: chatId },
      headers: { Authorization: `Bearer ${botToken}` }
    })
    return res.data.url
  } catch {
    return null
  }
}
