import { io, Socket } from 'socket.io-client'
import { useAuthStore } from '../store/auth'

const SERVER_URL = process.env['EXPO_PUBLIC_ATLAS_SERVER'] ?? 'http://localhost:3001'

let socket: Socket | null = null

export function getSocket(): Socket {
  if (!socket) {
    // CRITICAL: read token dynamically so reconnect gets fresh JWT, not stale cached value
    socket = io(SERVER_URL, {
      auth: (cb) => {
        const token = useAuthStore.getState().token
        cb({ token })
      },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10
    })
  }
  return socket
}

export function joinSession(sessionId: string): void {
  getSocket().emit('session:join', sessionId)
}

export function leaveSession(sessionId: string): void {
  getSocket().emit('session:leave', sessionId)
}

export function disconnectSocket(): void {
  socket?.disconnect()
  socket = null
}
