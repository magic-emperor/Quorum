import type { ChatMessage, Platform } from './types.js'

// ─── Chat Ingester ────────────────────────────────────────────────────────────
// Fetches conversation history from platform APIs.
// Each platform adapter implements PlatformIngester.
// The bot can also pass messages directly via ingestDirect() if it already
// has them in memory (e.g. Teams bot accumulates channelHistory in-process).

export interface PlatformIngesterConfig {
  platform: Platform
  channelId: string
  threadId?: string
  limit?: number        // max messages to fetch (default: 50)
  accessToken?: string  // platform OAuth token
  botToken?: string     // bot API token (Telegram, Slack)
}

export interface IngestResult {
  messages: ChatMessage[]
  platform: Platform
  channelId: string
  fetchedAt: string
}

// ─── Direct ingestion (bot already has messages in memory) ───────────────────

export function ingestDirect(
  messages: Array<{ id: string; author: string; author_id: string; content: string; timestamp: string; is_bot?: boolean }>,
  platform: Platform,
  channelId: string
): IngestResult {
  const cleaned = messages
    .filter(m => m.content.trim().length > 0)
    .filter(m => !m.is_bot)
    .map(m => ({
      id: m.id,
      author: m.author,
      author_id: m.author_id,
      content: m.content.trim(),
      timestamp: m.timestamp,
      is_bot: m.is_bot ?? false
    }))

  return {
    messages: cleaned,
    platform,
    channelId,
    fetchedAt: new Date().toISOString()
  }
}

// ─── Strip noise from any message list ───────────────────────────────────────
// Removes bot commands, reactions, file-share-only messages, and very short
// messages that add no signal to the summary.

export function stripNoise(messages: ChatMessage[]): ChatMessage[] {
  const COMMAND_PREFIXES = ['@quorum', '/quorum', '/start', '/help', '/stop']
  const MIN_CONTENT_LENGTH = 8

  return messages.filter(m => {
    const lower = m.content.toLowerCase().trim()
    if (COMMAND_PREFIXES.some(p => lower.startsWith(p))) return false
    if (m.content.trim().length < MIN_CONTENT_LENGTH) return false
    if (m.is_bot) return false
    return true
  })
}

// ─── Teams ingester ───────────────────────────────────────────────────────────
// Uses the Microsoft Graph API to fetch channel messages.
// Requires an app access token with ChannelMessage.Read.All permission.

export async function ingestFromTeams(config: PlatformIngesterConfig): Promise<IngestResult> {
  if (!config.accessToken) {
    throw new Error('Teams ingestion requires an accessToken (Microsoft Graph)')
  }

  const limit = config.limit ?? 50
  // Graph API: GET /teams/{team-id}/channels/{channel-id}/messages
  // For a simple channel, channelId encodes both teamId and channelId as "teamId:channelId"
  const [teamId, channelId] = config.channelId.includes(':')
    ? config.channelId.split(':')
    : [null, config.channelId]

  let url: string
  if (teamId) {
    url = `https://graph.microsoft.com/v1.0/teams/${teamId}/channels/${channelId}/messages?$top=${limit}&$orderby=createdDateTime desc`
  } else {
    // Group chat (meeting chat) — use chats endpoint
    url = `https://graph.microsoft.com/v1.0/chats/${channelId}/messages?$top=${limit}`
  }

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${config.accessToken}` }
  })

  if (!resp.ok) {
    throw new Error(`Teams Graph API error: ${resp.status} ${resp.statusText}`)
  }

  const data = await resp.json() as {
    value: Array<{
      id: string
      from?: { user?: { displayName?: string; id?: string }; application?: { displayName?: string } }
      body: { content: string; contentType: string }
      createdDateTime: string
    }>
  }

  const messages: ChatMessage[] = data.value
    .reverse() // API returns newest first
    .map(m => {
      const isBot = !!m.from?.application
      const text = m.body.contentType === 'html'
        ? m.body.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        : m.body.content

      return {
        id: m.id,
        author: m.from?.user?.displayName ?? m.from?.application?.displayName ?? 'Unknown',
        author_id: m.from?.user?.id ?? '',
        content: text,
        timestamp: m.createdDateTime,
        is_bot: isBot
      }
    })
    .filter(m => m.content.length > 0)

  return {
    messages: stripNoise(messages),
    platform: 'teams',
    channelId: config.channelId,
    fetchedAt: new Date().toISOString()
  }
}

// ─── Slack ingester ───────────────────────────────────────────────────────────
// Uses conversations.history API.
// Requires bot token with channels:history or groups:history scope.

export async function ingestFromSlack(config: PlatformIngesterConfig): Promise<IngestResult> {
  if (!config.botToken) {
    throw new Error('Slack ingestion requires a botToken')
  }

  const limit = config.limit ?? 50
  const params = new URLSearchParams({
    channel: config.channelId,
    limit: String(limit)
  })
  if (config.threadId) params.set('thread_ts', config.threadId)

  const endpoint = config.threadId
    ? 'https://slack.com/api/conversations.replies'
    : 'https://slack.com/api/conversations.history'

  const resp = await fetch(`${endpoint}?${params}`, {
    headers: { Authorization: `Bearer ${config.botToken}` }
  })

  const data = await resp.json() as {
    ok: boolean
    error?: string
    messages?: Array<{
      ts: string
      user?: string
      username?: string
      bot_id?: string
      text: string
    }>
  }

  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error ?? 'unknown'}`)
  }

  const messages: ChatMessage[] = (data.messages ?? [])
    .reverse()
    .map(m => ({
      id: m.ts,
      author: m.username ?? m.user ?? 'Unknown',
      author_id: m.user ?? '',
      content: m.text,
      timestamp: new Date(parseFloat(m.ts) * 1000).toISOString(),
      thread_id: config.threadId,
      is_bot: !!m.bot_id
    }))

  return {
    messages: stripNoise(messages),
    platform: 'slack',
    channelId: config.channelId,
    fetchedAt: new Date().toISOString()
  }
}

// ─── Discord ingester ─────────────────────────────────────────────────────────
// Uses Discord REST API — GET /channels/{id}/messages

export async function ingestFromDiscord(config: PlatformIngesterConfig): Promise<IngestResult> {
  if (!config.botToken) {
    throw new Error('Discord ingestion requires a botToken')
  }

  const limit = Math.min(config.limit ?? 50, 100) // Discord max is 100
  const url = `https://discord.com/api/v10/channels/${config.channelId}/messages?limit=${limit}`

  const resp = await fetch(url, {
    headers: { Authorization: `Bot ${config.botToken}` }
  })

  if (!resp.ok) {
    throw new Error(`Discord API error: ${resp.status} ${resp.statusText}`)
  }

  const data = await resp.json() as Array<{
    id: string
    author: { id: string; username: string; bot?: boolean }
    content: string
    timestamp: string
  }>

  const messages: ChatMessage[] = data
    .reverse()
    .map(m => ({
      id: m.id,
      author: m.author.username,
      author_id: m.author.id,
      content: m.content,
      timestamp: m.timestamp,
      is_bot: m.author.bot ?? false
    }))

  return {
    messages: stripNoise(messages),
    platform: 'discord',
    channelId: config.channelId,
    fetchedAt: new Date().toISOString()
  }
}

// ─── Telegram ingester ────────────────────────────────────────────────────────
// Telegram doesn't support reading history via bot API.
// Messages must be accumulated in real-time by the bot (ingestDirect pattern).

export function ingestFromTelegram(
  accumulated: ChatMessage[],
  chatId: string
): IngestResult {
  return {
    messages: stripNoise(accumulated),
    platform: 'telegram',
    channelId: chatId,
    fetchedAt: new Date().toISOString()
  }
}

// ─── Unified ingester ─────────────────────────────────────────────────────────

export async function ingest(config: PlatformIngesterConfig, accumulated?: ChatMessage[]): Promise<IngestResult> {
  switch (config.platform) {
    case 'teams':
      // If the bot has accumulated messages in memory, use those (no Graph token needed)
      if (accumulated && accumulated.length > 0) {
        return ingestDirect(accumulated, 'teams', config.channelId)
      }
      return ingestFromTeams(config)

    case 'slack':
      if (accumulated && accumulated.length > 0) {
        return ingestDirect(accumulated, 'slack', config.channelId)
      }
      return ingestFromSlack(config)

    case 'discord':
      if (accumulated && accumulated.length > 0) {
        return ingestDirect(accumulated, 'discord', config.channelId)
      }
      return ingestFromDiscord(config)

    case 'telegram':
      return ingestFromTelegram(accumulated ?? [], config.channelId)
  }
}
