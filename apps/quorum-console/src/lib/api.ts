import axios from 'axios'
import { useAuthStore } from '../store/auth'

const SERVER_URL = process.env['EXPO_PUBLIC_QUORUM_SERVER'] ?? 'http://localhost:3001'

export const api = axios.create({
  baseURL: SERVER_URL,
  timeout: 15000
})

// Auto-logout on 401
api.interceptors.response.use(
  (res) => res,
  async (error) => {
    if (error.response?.status === 401) {
      await useAuthStore.getState().logout()
    }
    return Promise.reject(error)
  }
)
