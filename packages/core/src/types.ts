// All shared TypeScript types for ATLAS core engine

export interface ATLASConfig {
  version: string
  simplicity_mode: boolean
  api_keys: {
    ANTHROPIC_API_KEY?: string
    OPENAI_API_KEY?: string
    GOOGLE_AI_API_KEY?: string
    GROQ_API_KEY?: string
    DEEPSEEK_API_KEY?: string
    MISTRAL_API_KEY?: string
    V0_API_KEY?: string
    LOVABLE_API_KEY?: string
    LOCAL_OLLAMA_ENDPOINT?: string
  }
  auto_provider_selection: Record<string, {
    priority: string[]
    _why?: string
  }>
  advanced_config?: {
    enabled: boolean
    providers?: Record<string, ProviderConfig>
    models?: Record<string, ModelAssignment>
  }
  fallback_strategy: {
    on_provider_unavailable: string
    final_fallback: string
    on_hard_stop_message: string
  }
  token_budgets: Record<string, number>
  loop_limits: {
    architect_validator_max_rounds: number
    design_loop_max_rounds: number
    bug_fix_max_attempts: number
    integration_max_rounds: number
    progress_threshold_percent: number
    semantic_similarity_threshold: number
  }
  checkpoints: {
    require_human_phase_1: boolean
    require_human_phase_2: boolean
    require_human_phase_5: boolean
    prompt_scaling_phase_6: boolean
    auto_proceed_simple_projects: boolean
  }
  project: {
    name: string
    description: string
    team_size: number
    project_hash: string
  }
}

export interface ProviderConfig {
  enabled: boolean
  api_key_env: string
  base_url: string
  _status?: string
}

export interface ModelAssignment {
  model: string
  provider: string
}

export interface RoutingTable {
  session_routing_table: Record<string, ResolvedModel>
  providers_active: string[]
  providers_unavailable: string[]
  fallbacks_triggered: FallbackEvent[]
  session_notes: string[]
}

export interface ResolvedModel {
  model: string
  provider: string
  reason: string
}

export interface FallbackEvent {
  agent: string
  wanted: string
  using: string
  reason: string
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface AgentResponse {
  content: string
  usage?: {
    input_tokens: number
    output_tokens: number
  }
  model: string
  provider: string
}

export interface ToolCall {
  tool: 'file_read' | 'file_write' | 'bash_exec' | 'glob_search' | 'grep_search'
  path?: string
  content?: string
  mode?: 'create' | 'append' | 'replace'
  command?: string
  pattern?: string
  scope?: string
  max_results?: number
  lines?: string
}

export interface ToolResult {
  success: boolean
  output: string
  error?: string
}

export interface ATLASRunOptions {
  command: 'new' | 'enhance' | 'status' | 'rollback' | 'sync'
  description?: string
  projectDir: string
  onCheckpoint?: (checkpoint: Checkpoint) => Promise<string>
  onProgress?: (message: string) => void
  onAgentOutput?: (agent: string, output: string) => void
}

export interface Checkpoint {
  type: 'A' | 'B' | 'C' | 'BLOCKER'
  title: string
  completed: string[]
  question: string
  options: Array<{ label: string; tradeoff: string }>
  supportingDoc?: string
}

export interface ProjectMemory {
  decisions: Decision[]
  actions: Action[]
  openQuestions: OpenQuestion[]
  stack: TechStack
  bugs: Bug[]
}

export interface Decision {
  id: string
  type: 'decision'
  what: string
  why: string
  alternatives_rejected: Array<{ option: string; reason: string }>
  made_by: string
  confirmed_by: string
  session: string
  timestamp: string
  confidence: 'proposed' | 'confirmed' | 'final'
  affects: string[]
}

export interface Action {
  id: string
  type: 'action'
  what: string
  file_affected?: string
  agent: string
  status: 'completed' | 'partial' | 'failed'
  output: string
  session: string
  timestamp: string
}

export interface OpenQuestion {
  id: string
  question: string
  context: string
  raised_by: string
  session: string
  blocking: boolean
  status: 'open' | 'resolved'
}

export interface TechStack {
  language: string
  frontend_framework: string
  backend_framework: string
  database: string
  auth: string
  deployment: string
  package_manager: string
}

export interface Bug {
  id: string
  description: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  status: 'FIXED' | 'ESCALATED' | 'KNOWN'
  root_cause: string
  fix_applied?: string
  session: string
  found_by: string
}

export interface FunctionEntry {
  id: string
  type: 'function' | 'class' | 'method' | 'hook' | 'middleware'
  name: string
  file: string
  line_start: number
  line_end: number
  purpose: string
  parameters: Array<{
    name: string
    type: string
    required: boolean
    description: string
  }>
  returns: { type: string; description: string }
  called_from: Array<{ file: string; line: number; function: string; reason: string }>
  calls: Array<{ function: string; file: string; reason: string }>
  agent_that_created: string
  session: string
  deleted: boolean
  tags: string[]
}

export type ProjectComplexity = 'SIMPLE' | 'COMPLEX'

export interface ClassificationResult {
  classification: ProjectComplexity
  reasoning: string
  inferred_stack: Partial<TechStack>
  unknown_critical: string[]
  suggested_questions: string[]
}
