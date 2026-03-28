import 'dotenv/config'
import express from 'express'
import { BotFrameworkAdapter } from 'botbuilder'
import { ATLASTeamsBot } from './bot.js'

const PORT = parseInt(process.env['PORT'] ?? '3978', 10)

// ─── Bot Framework Adapter ────────────────────────────────────────────────────

const adapter = new BotFrameworkAdapter({
  appId: process.env['MICROSOFT_APP_ID'] ?? '',
  appPassword: process.env['MICROSOFT_APP_PASSWORD'] ?? ''
})

adapter.onTurnError = async (ctx, error) => {
  console.error('[TeamsBot] Error:', error)
  await ctx.sendActivity('⚠️ Something went wrong. Please try again.')
}

// ─── Bot ──────────────────────────────────────────────────────────────────────

const bot = new ATLASTeamsBot()

// ─── Express server ───────────────────────────────────────────────────────────

const app = express()
app.use(express.json())

// Teams sends POST to /api/messages
app.post('/api/messages', (req, res) => {
  adapter.processActivity(req, res, async (ctx) => {
    await bot.run(ctx)
  })
})

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', bot: 'QUORUM Teams Bot' })
})

app.listen(PORT, () => {
  console.log(`QUORUM Teams Bot running on port ${PORT}`)
  console.log(`Messaging endpoint: POST http://localhost:${PORT}/api/messages`)

  if (!process.env['MICROSOFT_APP_ID']) {
    console.log('\n⚠️  MICROSOFT_APP_ID not set — running in local test mode')
    console.log('   Use Bot Framework Emulator to test locally')
    console.log('   Download: https://github.com/microsoft/BotFramework-Emulator/releases')
  }
})
