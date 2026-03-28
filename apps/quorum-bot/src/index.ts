import 'dotenv/config'
import type { AdapterConfig } from './types.js'

// ─── QUORUM Bot — Unified entry point ──────────────────────────────────────────
// Starts whichever platform adapters are configured via environment variables.
// Each adapter is optional — only starts if its required tokens are present.
//
// Teams:    Uses apps/teams-bot/ (botbuilder) — NOT started here.
//           Teams has Azure Bot Service requirements that need separate hosting.
//
// Slack:    SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET required
//           SLACK_APP_TOKEN optional (enables Socket Mode — recommended for dev)
//
// Discord:  DISCORD_BOT_TOKEN required
//
// Telegram: TELEGRAM_BOT_TOKEN required

const config: AdapterConfig = {
  atlasServerUrl: (process.env['QUORUM_SERVER_URL'] ?? 'http://localhost:3001').replace(/\/$/, ''),
  botSecret:      process.env['BOT_SECRET'] ?? '',
  defaultProjectDir: process.env['DEFAULT_PROJECT_DIR']
}

async function start(): Promise<void> {
  let started = 0

  // ── Slack ────────────────────────────────────────────────────────────────────
  if (process.env['SLACK_BOT_TOKEN'] && process.env['SLACK_SIGNING_SECRET']) {
    const { createSlackAdapter } = await import('./adapters/slack.js')
    const app = createSlackAdapter(config)
    const port = parseInt(process.env['SLACK_PORT'] ?? '3979', 10)

    if (process.env['SLACK_APP_TOKEN']) {
      // Socket Mode — no public URL needed (great for dev)
      await app.start()
      console.log('⚡ QUORUM Slack bot started (Socket Mode)')
    } else {
      // HTTP mode — needs a public URL + Slack Event Subscriptions configured
      await app.start({ port })
      console.log(`⚡ QUORUM Slack bot started on port ${port}`)
    }
    started++
  } else {
    console.log('  Slack: SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET not set — skipping')
  }

  // ── Discord ───────────────────────────────────────────────────────────────────
  if (process.env['DISCORD_BOT_TOKEN']) {
    const { createDiscordAdapter } = await import('./adapters/discord.js')
    const client = createDiscordAdapter(config)
    await client.login(process.env['DISCORD_BOT_TOKEN'])
    console.log('🎮 QUORUM Discord bot started')
    started++
  } else {
    console.log('  Discord: DISCORD_BOT_TOKEN not set — skipping')
  }

  // ── Telegram ──────────────────────────────────────────────────────────────────
  if (process.env['TELEGRAM_BOT_TOKEN']) {
    const { createTelegramAdapter } = await import('./adapters/telegram.js')
    createTelegramAdapter(config)
    console.log('📱 QUORUM Telegram bot started')
    started++
  } else {
    console.log('  Telegram: TELEGRAM_BOT_TOKEN not set — skipping')
  }

  // ── Teams note ────────────────────────────────────────────────────────────────
  console.log('  Teams: run apps/teams-bot/ separately (requires Azure Bot Service registration)')

  if (started === 0) {
    console.error('\n❌ No platform tokens configured. Set at least one of:')
    console.error('   SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET')
    console.error('   DISCORD_BOT_TOKEN')
    console.error('   TELEGRAM_BOT_TOKEN\n')
    process.exit(1)
  }

  console.log(`\n✅ QUORUM Bot running on ${started} platform${started > 1 ? 's' : ''}`)
  console.log(`   Server: ${config.atlasServerUrl}`)
  if (config.defaultProjectDir) console.log(`   Project: ${config.defaultProjectDir}`)
}

start().catch(err => {
  console.error('QUORUM Bot startup failed:', err)
  process.exit(1)
})
