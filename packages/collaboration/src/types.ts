// ─── Platform types ──────────────────────────────────────────────────────────

export type Platform = 'teams' | 'slack' | 'discord' | 'telegram'

export interface PlatformIdentity {
  platform: Platform
  platform_user_id: string
  platform_username: string
}

// ─── Chat message from any platform ─────────────────────────────────────────

export interface ChatMessage {
  id: string
  author: string            // display name
  author_id: string         // platform user ID
  content: string
  timestamp: string         // ISO 8601
  thread_id?: string        // for threaded platforms
  is_bot?: boolean
}

// ─── What the summarizer extracts ────────────────────────────────────────────

export interface ConversationSummary {
  decisions: string[]       // things the team agreed on
  open_questions: string[]  // unresolved items
  acceptance_criteria: string[]  // what "done" looks like
  assigned_to?: string      // who will do the work
  context: string           // 2-3 sentence summary of what's being built
  ticket_ref?: string       // linked PM ticket if mentioned
}

// ─── A plan request — created from a summary ─────────────────────────────────

export interface PlanRequest {
  id: string                // nanoid
  project_dir: string
  summary: ConversationSummary
  chat_messages: ChatMessage[]
  requester_id: string      // QUORUM user ID who triggered /quorum plan
  channel_id: string        // platform channel/chat ID for posting updates
  platform: Platform
  created_at: string
  status: 'pending_approval' | 'approved' | 'rejected' | 'executing' | 'done' | 'failed'
  plan_md?: string          // generated plan.md content
  task_md?: string          // generated task.md content
}

// ─── Approval state ───────────────────────────────────────────────────────────

export type ApprovalQuorum = 'all' | 'majority' | 'lead' | 'any'

export interface ApprovalRequest {
  plan_request_id: string
  required_approvers: string[]   // QUORUM user IDs
  approved_by: string[]
  rejected_by: string[]
  rejection_reason?: string
  quorum: ApprovalQuorum
  expires_at: string             // ISO 8601 — auto-cancel after this
  status: 'pending' | 'approved' | 'rejected' | 'expired'
}

// ─── Contributor — maps QUORUM user to platform identities ────────────────────

export interface Contributor {
  quorum_user_id: string
  name: string
  role: 'lead' | 'member' | 'reviewer'
  platforms: Partial<Record<Platform, string>>  // platform → platform_user_id
}

// ─── The .quorum/collaboration/ folder schema ─────────────────────────────────

export interface CollaborationConfig {
  quorum: ApprovalQuorum
  approval_timeout_hours: number
  auto_execute_on_approval: boolean
  pm_tool?: string
  trigger_keyword?: string
}
