import type { TurnContext } from 'botbuilder'

// ─── @QUORUM stop handler ───────────────────────────────────────────────────────
// Interrupts a running quorum session for the current project.
// The running session is executing in quorum-server — this sends a stop signal.
//
// Usage:
//   @QUORUM stop        — stop the current execution session
//   @QUORUM stop <id>   — stop a specific session by ID

const SERVER_URL = (process.env['QUORUM_SERVER_URL'] ?? 'http://localhost:3001').replace(/\/$/, '')
const BOT_SECRET = process.env['BOT_SECRET'] ?? ''

export async function handleStopCommand(
  ctx: TurnContext,
  quorumToken: string,
  args?: string
): Promise<void> {
  const projectDir = process.env['DEFAULT_PROJECT_DIR'] ?? ''

  if (!projectDir && !args) {
    await ctx.sendActivity('⚠️ `DEFAULT_PROJECT_DIR` not set. Use `@QUORUM stop <session_id>` instead.')
    return
  }

  await ctx.sendActivity('⏹️ Sending stop signal to QUORUM...')

  try {
    // If a specific session ID was provided, stop that session
    // Otherwise stop the latest running session for this project
    const body = args
      ? { session_id: args.trim() }
      : { project_dir: projectDir, stop_latest: true }

    const resp = await fetch(`${SERVER_URL}/api/sessions/stop`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${quorumToken}`,
        'x-bot-secret': BOT_SECRET
      },
      body: JSON.stringify(body)
    })

    if (!resp.ok) {
      const err = await resp.json() as { error?: string }
      await ctx.sendActivity(`❌ Failed to stop session: ${err.error ?? resp.statusText}`)
      return
    }

    const data = await resp.json() as { session_id?: string; status?: string; message?: string }

    await ctx.sendActivity([
      `⏹️ **Session stopped**`,
      ``,
      data.session_id ? `Session ID: \`${data.session_id}\`` : '',
      data.message ? data.message : 'QUORUM execution was interrupted.',
      ``,
      `The work done so far has been saved to \`.quorum/\`.`,
      `Run \`quorum resume\` in your terminal to continue where it left off.`
    ].filter(Boolean).join('\n'))

  } catch (err) {
    await ctx.sendActivity(`❌ Stop failed: ${(err as Error).message}`)
  }
}
