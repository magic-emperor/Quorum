import { create } from 'zustand'
import * as SecureStore from 'expo-secure-store'
import { api } from '../lib/api'
import type { User } from '../types'

interface AuthState {
  token: string | null
  user: User | null
  isLoading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  loadStoredToken: () => Promise<void>
}

const TOKEN_KEY = 'atlas_jwt'

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  user: null,
  isLoading: true,

  loadStoredToken: async () => {
    try {
      const token = await SecureStore.getItemAsync(TOKEN_KEY)
      if (token) {
        api.defaults.headers.common['Authorization'] = `Bearer ${token}`
        const res = await api.get<{ user: User }>('/api/auth/me')
        set({ token, user: res.data.user, isLoading: false })
      } else {
        set({ isLoading: false })
      }
    } catch {
      await SecureStore.deleteItemAsync(TOKEN_KEY)
      set({ token: null, user: null, isLoading: false })
    }
  },

  login: async (email, password) => {
    const res = await api.post<{ token: string; user: User }>('/api/auth/login', { email, password })
    const { token, user } = res.data
    await SecureStore.setItemAsync(TOKEN_KEY, token)
    api.defaults.headers.common['Authorization'] = `Bearer ${token}`
    set({ token, user })
  },

  register: async (email, password) => {
    const res = await api.post<{ token: string; user: User }>('/api/auth/register', { email, password })
    const { token, user } = res.data
    await SecureStore.setItemAsync(TOKEN_KEY, token)
    api.defaults.headers.common['Authorization'] = `Bearer ${token}`
    set({ token, user })
  },

  logout: async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY)
    delete api.defaults.headers.common['Authorization']
    set({ token: null, user: null })
  }
}))
