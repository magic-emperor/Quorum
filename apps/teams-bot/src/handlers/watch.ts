import type { TurnContext } from 'botbuilder'

// ─── @QUORUM watch handler ──────────────────────────────────────────────────────
// Starts or stops the PM tool watcher for the current project.
// Usage in Teams:
//   @QUORUM watch               — start watching with defaults
//   @QUORUM watch jira PROJ-*   — watch specific Jira project
//   @QUORUM watch stop          — stop the watcher
//
// The bot proxies this to quorum-server which runs the atlas watch process.

const SERVER_URL = (process.env['QUORUM_SERVER_URL'] ?? 'http://localhost:3001').replace(/\/$/, '')
const BOT_SECRET = process.env['BOT_SECRET'] ?? ''

// Track active watch sessions per channel
const activeWatchers = new Map<string, { sessionId: string; tool: string; keyword: string }>()

export async function handleWatchCommand(
  ctx: TurnContext,
  channelId: string,
  quorumToken: string,
  args: string
): Promise<void> {
  const lower = args.trim().toLowerCase()

  // @QUORUM watch stop
  if (lower === 'stop' || lower === 'off') {
    await handleWatchStop(ctx, channelId, quorumToken)
    return
  }

  // @QUORUM watch [tool] [keyword]
  // e.g. "@QUORUM watch jira [QUORUM]" or "@QUORUM watch" (use defaults)
  const parts = args.trim().split(/\s+/)
  const tool = (['jira', 'linear', 'github', 'azure'].includes(parts[0]?.toLowerCase() ?? ''))
    ? parts.shift()!.toLowerCase()
    : 'jira'
  const keyword = parts.join(' ') || '[QUORUM]'

  const projectDir = process.env['DEFAULT_PROJECT_DIR'] ?? ''
  if (!projectDir) {
    await ctx.sendActivity('⚠️ `DEFAULT_PROJECT_DIR` not set. Ask your admin to configure the bot.')
    return
  }

  if (activeWatchers.has(channelId)) {
    const watcher = activeWatchers.get(channelId)!
    await ctx.sendActivity(
      `👁️ Already watching **${watcher.tool}** for \`${watcher.keyword}\`.\n\n` +
      `Type \`@QUORUM watch stop\` to stop, then start again with new settings.`
    )
    return
  }

  await ctx.sendActivity(`⚙️ Starting ${tool} watcher for \`${keyword}\`...`)

  try {
    const resp = await fetch(`${SERVER_URL}/api/watch/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${quorumToken}`,
        'x-bot-secret': BOT_SECRET
      },
      body: JSON.stringify({
        tool,
        keyword,
        project_dir: projectDir,
        channel_id: channelId,
        platform: 'teams'
      })
    })

    if (!resp.ok) {
      const err = await resp.json() as { error?: string }
      await ctx.sendActivity(`❌ Failed to start watcher: ${err.error ?? resp.statusText}`)
      return
    }

    const data = await resp.json() as { session_id: string }
    activeWatchers.set(channelId, { sessionId: data.session_id, tool, keyword })

    await ctx.sendActivity([
      `👁️ **QUORUM Watch started**`,
      ``,
      `Monitoring **${tool}** for tickets containing \`${keyword}\``,
      `Project: \`${projectDir}\``,
      ``,
      `When a matching ticket is found:`,
      `1. QUORUM reads the ticket and acceptance criteria`,
      `2. Creates a plan and posts it here for approval`,
      `3. On approval — executes automatically`,
      ``,
      `Type \`@QUORUM watch stop\` to stop watching.`
    ].join('\n'))

  } catch (err) {
    await ctx.sendActivity(`❌ Watch error: ${(err as Error).message}`)
  }
}

async function handleWatchStop(
  ctx: TurnContext,
  channelId: string,
  quorumToken: string
): Promise<void> {
  const watcher = activeWatchers.get(channelId)

  if (!watcher) {
    await ctx.sendActivity('ℹ️ No active watcher for this channel.')
    return
  }

  try {
    await fetch(`${SERVER_URL}/api/watch/stop`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${quorumToken}`,
        'x-bot-secret': BOT_SECRET
      },
      body: JSON.stringify({ session_id: watcher.sessionId })
    })
  } catch {
    // best-effort stop
  }

  activeWatchers.delete(channelId)
  await ctx.sendActivity(`⏹️ Watcher stopped. No longer monitoring **${watcher.tool}** for \`${watcher.keyword}\`.`)
}

export function getActiveWatcher(channelId: string) {
  return activeWatchers.get(channelId) ?? null
}
