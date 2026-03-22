import { create } from 'zustand'
import { nanoid } from 'nanoid/non-secure'
import { getSocket, joinSession, leaveSession } from '../lib/socket'
import { api } from '../lib/api'
import type { TerminalLine, ChatMessage, PipelineEvent, Session, UIMode } from '../types'

interface SessionState {
  // State
  mode: UIMode
  activeSessionId: string | null
  sessions: Session[]
  terminalLines: TerminalLine[]
  chatMessages: ChatMessage[]
  pendingCheckpoint: { session_id: string; message: string; options?: string[] } | null
  isRunning: boolean

  // Actions
  setMode: (mode: UIMode) => void
  startSession: (command: string, description: string, projectDir: string, auto?: boolean) => Promise<void>
  executeTerminalCommand: (input: string) => void
  sendInterrupt: () => Promise<void>
  respondToCheckpoint: (response: string) => void
  handleEvent: (event: PipelineEvent) => void
  subscribeToSession: (sessionId: string) => void
  unsubscribeFromSession: (sessionId: string) => void
  loadSessions: () => Promise<void>
  clearTerminal: () => void
}

export const useSessionStore = create<SessionState>((set, get) => ({
  mode: 'terminal',
  activeSessionId: null,
  sessions: [],
  terminalLines: [],
  chatMessages: [],
  pendingCheckpoint: null,
  isRunning: false,

  setMode: (mode) => set({ mode }),

  loadSessions: async () => {
    try {
      const res = await api.get<{ sessions: Session[] }>('/api/sessions')
      set({ sessions: res.data.sessions })
    } catch { /* silent */ }
  },

  startSession: async (command, description, projectDir, auto = false) => {
    const res = await api.post<{ session_id: string }>('/api/sessions/execute', {
      command, description, project_dir: projectDir, auto
    })
    const sessionId = res.data.session_id
    set({
      activeSessionId: sessionId,
      isRunning: true,
      terminalLines: [],
      chatMessages: [],
      pendingCheckpoint: null
    })
    get().subscribeToSession(sessionId)

    // Add system line to terminal
    set(state => ({
      terminalLines: [...state.terminalLines, {
        id: nanoid(),
        type: 'system',
        content: `► atlas ${command} ${description}`,
        timestamp: Date.now()
      }]
    }))
  },

  executeTerminalCommand: (input: string) => {
    // Add to terminal history
    set(state => ({
      terminalLines: [...state.terminalLines, {
        id: nanoid(),
        type: 'input',
        content: `$ ${input}`,
        timestamp: Date.now()
      }]
    }))

    // If a checkpoint is pending, treat this as the response
    const { pendingCheckpoint } = get()
    if (pendingCheckpoint) {
      get().respondToCheckpoint(input)
    }
  },

  sendInterrupt: async () => {
    const { activeSessionId } = get()
    if (!activeSessionId) return
    await api.post(`/api/sessions/${activeSessionId}/interrupt`)
    set({ isRunning: false })
    set(state => ({
      terminalLines: [...state.terminalLines, {
        id: nanoid(),
        type: 'system',
        content: '⚠️ Session interrupted',
        timestamp: Date.now()
      }]
    }))
  },

  respondToCheckpoint: (response: string) => {
    // Send response back via socket
    const { activeSessionId } = get()
    if (activeSessionId) {
      getSocket().emit('checkpoint:response', { session_id: activeSessionId, response })
    }
    set({ pendingCheckpoint: null })
  },

  handleEvent: (event: PipelineEvent) => {
    const id = nanoid()
    const timestamp = Date.now()

    switch (event.event_type) {
      case 'progress':
        set(state => ({
          terminalLines: [...state.terminalLines, {
            id, type: 'output', content: event.payload.message ?? '', timestamp
          }],
          chatMessages: [...state.chatMessages, {
            id, role: 'assistant', content: event.payload.message ?? '', timestamp
          }]
        }))
        break

      case 'agent_output':
        set(state => ({
          terminalLines: [...state.terminalLines, {
            id, type: 'output',
            content: `[${event.payload.agent}] ${event.payload.output}`,
            timestamp
          }],
          chatMessages: [...state.chatMessages, {
            id, role: 'assistant',
            content: event.payload.output ?? '',
            timestamp
          }]
        }))
        break

      case 'checkpoint':
        set(state => ({
          pendingCheckpoint: event.payload.checkpoint ?? null,
          terminalLines: [...state.terminalLines, {
            id, type: 'checkpoint',
            content: event.payload.checkpoint?.message ?? '',
            timestamp
          }],
          chatMessages: [...state.chatMessages, {
            id, role: 'assistant',
            content: event.payload.checkpoint?.message ?? '',
            checkpoint: event.payload.checkpoint,
            timestamp
          }]
        }))
        break

      case 'session:end':
        set({ isRunning: false })
        set(state => ({
          terminalLines: [...state.terminalLines, {
            id, type: 'system',
            content: `● Session ${event.payload.status} (exit: ${event.payload.exit_code ?? '?'})`,
            timestamp
          }]
        }))
        break
    }
  },

  subscribeToSession: (sessionId: string) => {
    joinSession(sessionId)
    getSocket().on('session:event', (event: PipelineEvent) => {
      if (event.session_id === sessionId) {
        get().handleEvent(event)
      }
    })
  },

  unsubscribeFromSession: (sessionId: string) => {
    leaveSession(sessionId)
    getSocket().off('session:event')
  },

  clearTerminal: () => set({ terminalLines: [] })
}))
