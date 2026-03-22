import { create } from 'zustand'
import axios from 'axios'

const SERVER_URL = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3001'
export const api = axios.create({ baseURL: SERVER_URL })

interface AuthState {
  token: string | null
  email: string | null
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string) => Promise<void>
  logout: () => void
}

const savedToken = localStorage.getItem('atlas_token')
if (savedToken) api.defaults.headers.common['Authorization'] = `Bearer ${savedToken}`

api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401) useAuthStore.getState().logout()
    return Promise.reject(err)
  }
)

export const useAuthStore = create<AuthState>(() => ({
  token: savedToken,
  email: localStorage.getItem('atlas_email'),

  login: async (email, password) => {
    const res = await api.post<{ token: string; user: { email: string } }>('/api/auth/login', { email, password })
    const { token, user } = res.data
    localStorage.setItem('atlas_token', token)
    localStorage.setItem('atlas_email', user.email)
    api.defaults.headers.common['Authorization'] = `Bearer ${token}`
    useAuthStore.setState({ token, email: user.email })
  },

  register: async (email, password) => {
    const res = await api.post<{ token: string; user: { email: string } }>('/api/auth/register', { email, password })
    const { token, user } = res.data
    localStorage.setItem('atlas_token', token)
    localStorage.setItem('atlas_email', user.email)
    api.defaults.headers.common['Authorization'] = `Bearer ${token}`
    useAuthStore.setState({ token, email: user.email })
  },

  logout: () => {
    localStorage.removeItem('atlas_token')
    localStorage.removeItem('atlas_email')
    delete api.defaults.headers.common['Authorization']
    useAuthStore.setState({ token: null, email: null })
  }
}))
