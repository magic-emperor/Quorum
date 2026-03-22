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
  // Which model to use per provider per quality tier.
  // ATLAS auto-detects your keys and builds routing from this.
  // No need to touch auto_provider_selection — just set your keys.
  model_preferences?: {
    // Google Gemini — put your GOOGLE_AI_API_KEY in api_keys above
    google_smart?: string       // default: gemini-2.5-pro
    google_balanced?: string    // default: gemini-2.0-flash-001
    google_fast?: string        // default: gemini-2.0-flash-001

    // Anthropic Claude — put your ANTHROPIC_API_KEY in api_keys above
    anthropic_smart?: string    // default: claude-opus-4-6
    anthropic_balanced?: string // default: claude-sonnet-4-6
    anthropic_fast?: string     // default: claude-haiku-4-5-20251001

    // OpenAI — put your OPENAI_API_KEY in api_keys above
    openai_smart?: string       // default: gpt-4o
    openai_balanced?: string    // default: gpt-4o
    openai_fast?: string        // default: gpt-4o-mini

    // Groq — put your GROQ_API_KEY in api_keys above
    groq_fast?: string          // default: llama-3.3-70b-versatile
    groq_balanced?: string      // default: llama-3.3-70b-versatile

    // DeepSeek — put your DEEPSEEK_API_KEY in api_keys above
    deepseek_balanced?: string  // default: deepseek-chat
    deepseek_fast?: string      // default: deepseek-chat
  }
  // Optional: manual per-agent overrides. Leave empty to use dynamic routing.
  auto_provider_selection?: Record<string, {
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
    final_fallback?: string
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
  fallback_chain?: Array<{ model: string; provider: string }>
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
  command: 'new' | 'enhance' | 'status' | 'sync' | 'rollback' |
           'init' | 'fast' | 'next' | 'pause' | 'resume' |
           'doctor' | 'discuss' | 'verify' | 'ship' | 'review' |
           'map' | 'debug' | 'session-report' | 'seed' | 'backlog' |
           'note' | 'milestone' | 'plan-preview' | 'agents' | 'profile' | 'export'
  description?: string
  projectDir: string
  onCheckpoint?: (checkpoint: Checkpoint) => Promise<string>
  onProgress?: (message: string) => void
  onAgentOutput?: (agent: string, output: string) => void
  // New flags
  auto?: boolean           // skip all human checkpoints
  verbose?: boolean        // debug output
  json?: boolean           // machine-readable output
  maxCost?: number         // budget cap USD
  quality?: 'fast' | 'balanced' | 'max'
  modelOverride?: string   // one-off model override
  agentOverride?: string   // run single specific agent
  noSave?: boolean         // don't persist session
  fromPr?: string          // load context from PR number/URL
  worktree?: string        // isolate in git worktree
  subcommand?: string      // for commands with subcommands (backlog add/list)
  extra?: Record<string, string> // extra command-specific options
}

// ─── Phase 3: Command Result Types ──────────────────────────────────────────

export interface DoctorReport {
  overall: 'healthy' | 'degraded' | 'broken'
  checks: DoctorCheck[]
  repaired: string[]
  requires_manual_fix: string[]
}

export interface DoctorCheck {
  name: string
  status: 'pass' | 'fail' | 'warn' | 'skip'
  message: string
  fix?: string   // auto-fixable description
  action?: string // manual action required
}

export interface DiscussResult {
  feature: string
  questions_asked: string[]
  decisions_captured: string[]
  output_file: string
  ready_to_plan: boolean
}

export interface VerifyResult {
  deliverables: VerifyItem[]
  passed: number
  failed: number
  skipped: number
  ready_to_ship: boolean
}

export interface VerifyItem {
  id: string
  description: string
  status: 'pass' | 'fail' | 'skip' | 'pending'
  human_response?: string
  notes?: string
}

export interface SessionReport {
  session_id: string
  date: string
  duration_minutes: number
  tasks_created: string[]
  tasks_completed: string[]
  decisions_made: number
  files_changed: string[]
  agents_used: string[]
  cost_estimate: string
  summary: string
  next_recommended: string
}

export interface HandoffState {
  session_id: string
  paused_at: string
  command: string
  description: string
  current_phase: string
  current_step: string
  completed_steps: string[]
  remaining_steps: string[]
  context_snapshot: string
  resume_instruction: string
}

export interface AgentInfo {
  name: string
  description: string
  model: string
  provider: string
  tools: string[]
  phase: string
  status: 'active' | 'idle' | 'disabled'
}

export interface MapResult {
  area: string
  files_scanned: number
  modules_found: string[]
  architecture_summary: string
  key_patterns: string[]
  tech_stack_confirmed: Partial<TechStack>
  output_file: string
}

export interface Seed {
  id: string
  idea: string
  trigger: string
  created_date: string
  created_session: string
  status: 'pending' | 'surfaced' | 'acted_on' | 'dismissed'
}

export interface BacklogItem {
  id: string
  description: string
  added_date: string
  added_session: string
  priority?: 'high' | 'medium' | 'low'
  status: 'backlog' | 'promoted' | 'dismissed'
  promoted_to?: string
}

export interface MilestoneState {
  name: string
  status: 'active' | 'complete' | 'archived'
  started_date: string
  completed_date?: string
  task_ids: string[]
  success_criteria: string[]
  criteria_met: boolean[]
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
  // Pattern matching fields (used by debug and review agents)
  pattern?: string
  category?: string
  prevention_check?: string
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
  last_modified_session?: string
  deleted: boolean
  tags: string[]
  design_note?: string
}

export type ProjectComplexity = 'SIMPLE' | 'COMPLEX'

export interface ClassificationResult {
  classification: ProjectComplexity
  reasoning: string
  inferred_stack: Partial<TechStack>
  unknown_critical: string[]
  suggested_questions: string[]
}

// ─── Phase 2: Task System ────────────────────────────────────────────────────

export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'COMPLETE' | 'BLOCKED' | 'ROLLED_BACK'

export interface TaskUpdate {
  session: string
  date: string
  type: 'status_change' | 'note' | 'completion'
  note: string
  affected_files?: string[]
}

export interface Task {
  id: string
  title: string
  status: TaskStatus
  phase: string
  folder_scope: string
  description: string
  keywords: string[]
  depends_on: string[]
  affects_files: string[]
  milestone: string
  created_in_session: string
  created_date: string
  blocked_reason?: string
  session_completed?: string
  updates: TaskUpdate[]
}

export interface TaskIndexEntry {
  id: string
  title: string
  status: TaskStatus
  phase: string
  folder: string
  keywords: string[]
  depends_on: string[]
  affects_files: string[]
  milestone: string
  session_completed?: string
}

export interface TaskIndex {
  total: number
  last_updated: string
  last_updated_date: string
  current_milestone?: string
  summary: {
    complete: number
    in_progress: number
    blocked: number
    todo: number
    rolled_back: number
  }
  tasks: TaskIndexEntry[]
  keywords_index: Record<string, string[]>
  files_index: Record<string, string[]>
  next_task_number: number
}

export interface ImpactAnalysis {
  new_task_description: string
  related_tasks: Array<{
    task_id: string
    title: string
    relationship: 'depends_on' | 'modifies' | 'extends' | 'conflicts'
    reason: string
    requires_update: boolean
    update_description?: string
  }>
  affected_files: string[]
  recommended_phase: string
  creates_new_task: boolean
  new_task_draft: {
    title: string
    keywords: string[]
    folder_scope: string
    depends_on: string[]
    status: TaskStatus
    milestone: string
  }
}

// ─── Phase 2: Goal / Scope ──────────────────────────────────────────────────

export interface ProjectGoal {
  what: string
  why: string
  success_criteria: string[]
  out_of_scope: Array<{ item: string; reason: string }>
  constraints: {
    tech_stack?: string[]
    timeline?: string
    team_size?: number
  }
  milestones: Array<{ name: string; description: string }>
  created_date: string
  last_updated_date?: string
  version: number
}

export interface ScopeCheckResult {
  in_scope: boolean
  confidence: 'high' | 'medium' | 'low'
  reasoning: string
  recommendation: 'PROCEED' | 'CLARIFY' | 'BLOCK'
  conflicting_oos?: string
  matching_criteria?: string
}

// ─── Phase 2: Plan ──────────────────────────────────────────────────────────

export type PhaseStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETE' | 'SKIPPED'

export interface PlanPhase {
  id: string
  number: number
  name: string
  goal: string
  approach: string
  key_decisions: Array<{ decision: string; why: string }>
  success_criteria: string[]
  milestone: string
  status: PhaseStatus
  task_ids: string[]
  started_date?: string
  completed_date?: string
}

export interface PlanVersion {
  version: number
  created_date: string
  created_in_session: string
  status: 'ACTIVE' | 'SUPERSEDED' | 'ABANDONED'
  approved_by_human: boolean
  approved_date?: string
  phases: PlanPhase[]
}

export interface PlanIndex {
  current_version: number
  last_updated: string
  current_phase: string
  current_milestone: string
  phases: Array<{
    id: string
    name: string
    status: PhaseStatus
    task_count: number
    tasks_complete: number
    summary: string
    milestone: string
  }>
}

// ─── Phase 2: Session Brief ─────────────────────────────────────────────────

export interface SessionBrief {
  session_id: string
  generated_at: string
  providers: string[]
  goal_summary: string
  plan_summary: string
  task_summary: string
  open_questions: number
}
