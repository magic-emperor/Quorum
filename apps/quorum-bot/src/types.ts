// ─── Unified Bot Types ────────────────────────────────────────────────────────
// Platform-agnostic types shared across all adapters.

export type Platform = 'teams' | 'slack' | 'discord' | 'telegram'

export interface BotMessage {
  id: string
  text: string
  author: string
  authorId: string
  channelId: string
  platform: Platform
  timestamp: string
  threadId?: string
  isBot?: boolean
}

export interface BotContext {
  platform: Platform
  channelId: string
  threadId?: string
  userId: string
  userName: string

  /** Send a plain text message */
  reply(text: string): Promise<void>

  /** Send a rich card (platform-specific format built by card builders) */
  replyCard(card: PlatformCard): Promise<SentMessage>

  /** Update a previously sent card */
  updateCard(messageId: string, card: PlatformCard): Promise<void>

  /** Get recent messages from this channel (for summarization) */
  getHistory(limit?: number): BotMessage[]

  /** Record a message into in-memory history */
  recordMessage(msg: BotMessage): void

  /** Replace the entire history with a compacted set (used by /compact) */
  replaceHistory(messages: BotMessage[]): void
}

export interface SentMessage {
  id?: string
}

/** Platform-specific card payload — each adapter knows how to render this */
export interface PlatformCard {
  type: 'approval' | 'approved' | 'rejected' | 'progress' | 'story'
  data: Record<string, unknown>
}

/** Config passed to each adapter on startup */
export interface AdapterConfig {
  atlasServerUrl: string
  botSecret: string
  defaultProjectDir?: string
}
