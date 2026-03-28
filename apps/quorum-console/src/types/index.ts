// ─── Core domain types ──────────────────────────────────────────────────────

export type UIMode = 'terminal' | 'chat'

export interface TerminalLine {
  id: string
  type: 'output' | 'input' | 'error' | 'system' | 'checkpoint'
  content: string
  timestamp: number
  thinking?: ThinkingBlock[]
  isThinkingExpanded?: boolean
}

export interface ThinkingBlock {
  id: string
  content: string
  isExpanded: boolean
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  thinking?: ThinkingBlock[]
  isThinkingExpanded?: boolean
  checkpoint?: CheckpointData
}

export interface CheckpointData {
  session_id: string
  message: string
  options?: string[]
  type: 'approval' | 'choice' | 'input'
}

export interface PipelineEvent {
  session_id: string
  event_type:
    | 'progress'
    | 'agent_output'
    | 'checkpoint'
    | 'session:end'
    | 'stderr'
  payload: {
    message?: string
    agent?: string
    output?: string
    checkpoint?: CheckpointData
    status?: string
    exit_code?: number
    error?: string
  }
}

export interface Session {
  id: string
  command: string
  description?: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'error'
  project_dir?: string
  created_at: string
  updated_at: string
}

export interface User {
  id: string
  email: string
}
