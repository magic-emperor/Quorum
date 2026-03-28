#!/usr/bin/env node
/**
 * QUORUM Setup Wizard
 * Run once after cloning: npx tsx scripts/setup.ts
 * Auto-detects paths, prompts only for tokens/keys, writes all .env files.
 */

import * as readline from 'readline'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { execSync } from 'child_process'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const DRY_RUN = process.argv.includes('--dry-run') || process.argv.includes('--check')

function banner(text: string) {
  const line = '─'.repeat(60)
  console.log(`\n${line}\n  ${text}\n${line}`)
}

function ok(msg: string) { console.log(`  ✅  ${msg}`) }
function info(msg: string) { console.log(`  ℹ️   ${msg}`) }
function warn(msg: string) { console.log(`  ⚠️   ${msg}`) }
function skip(msg: string) { console.log(`  ⏭️   ${msg}`) }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

function ask(question: string, defaultVal = ''): Promise<string> {
  const hint = defaultVal ? ` [${defaultVal}]` : ''
  return new Promise(resolve =>
    rl.question(`  ${question}${hint}: `, (ans: string) => resolve(ans.trim() || defaultVal))
  )
}

function askSecret(question: string, autoGenerate = true): Promise<string> {
  const hint = autoGenerate ? ' [auto-generate]' : ''
  return new Promise(resolve =>
    rl.question(`  ${question}${hint}: `, (ans: string) => {
      const val = ans.trim()
      if (!val && autoGenerate) {
        const generated = crypto.randomBytes(32).toString('hex')
        console.log(`  → Generated: ${generated}`)
        resolve(generated)
      } else {
        resolve(val)
      }
    })
  )
}

function writeEnvFile(filePath: string, vars: Record<string, string>, comment?: string) {
  const lines: string[] = []
  if (comment) lines.push(`# ${comment}`, '')
  for (const [key, val] of Object.entries(vars)) {
    if (key.startsWith('__comment__')) {
      lines.push('', `# ${val}`)
    } else {
      lines.push(`${key}=${val}`)
    }
  }
  const content = lines.join('\n') + '\n'
  const rel = path.relative(ROOT, filePath)
  if (DRY_RUN) {
    console.log(`\n  [dry-run] Would write ${rel}:\n`)
    console.log(content.split('\n').map(l => `    ${l}`).join('\n'))
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content, 'utf-8')
    ok(`Wrote ${rel}`)
  }
}



function runCmd(cmd: string, cwd = ROOT) {
  if (DRY_RUN) {
    console.log(`  [dry-run] Would run: ${cmd}  (in ${path.relative(ROOT, cwd) || '.'})`)
    return
  }
  console.log(`  $ ${cmd}`)
  execSync(cmd, { cwd, stdio: 'inherit' })
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.clear()
  console.log(`
  ⚡ QUORUM Setup Wizard${DRY_RUN ? '  [DRY RUN — no files will be written]' : ''}
  ────────────────────────────────────────────────────
  This wizard configures QUORUM for your local machine.
  Press Enter to accept defaults shown in [brackets].
  ────────────────────────────────────────────────────
  `)

  // ── Step 1: Project directory ────────────────────────────────────────────────
  banner('Step 1 of 5 — Project Directory')
  info('This is the directory where QUORUM will build your projects.')
  info(`Detected: ${ROOT}`)

  const projectDir = await ask('DEFAULT_PROJECT_DIR (where your code lives)', ROOT)

  // ── Step 2: Server secrets ───────────────────────────────────────────────────
  banner('Step 2 of 5 — Server Secrets')
  info('JWT_SECRET signs auth tokens. BOT_SECRET authenticates bot→server calls.')
  info('Leave blank to auto-generate secure random values.')

  const jwtSecret  = await askSecret('JWT_SECRET')
  const botSecret  = await askSecret('BOT_SECRET')

  const serverPort     = await ask('Server port',     '3001')
  const publicUrl      = await ask('PUBLIC_URL (your deployed web app URL, or http://localhost:3000 for local)',
                                   'http://localhost:3000')
  const allowedOrigins = await ask('ALLOWED_ORIGINS',
                                   `http://localhost:3000,http://localhost:5173,${publicUrl}`)

  // ── Step 3: LLM API keys ─────────────────────────────────────────────────────
  banner('Step 3 of 5 — LLM API Keys')
  info('QUORUM needs at least ONE key. Free options: Groq (groq.com) or Google AI Studio.')
  info('Press Enter to skip any provider.')

  const groqKey    = await ask('GROQ_API_KEY     (free at groq.com)', '')
  const googleKey  = await ask('GOOGLE_AI_API_KEY (free at aistudio.google.com)', '')
  const openaiKey  = await ask('OPENAI_API_KEY', '')
  const anthropicKey = await ask('ANTHROPIC_API_KEY', '')

  if (!groqKey && !googleKey && !openaiKey && !anthropicKey) {
    warn('No LLM key provided — QUORUM will not be able to run agents.')
    warn('Add a key to quorum.config.json or run setup again.')
  }

  // ── Step 4: Bot tokens ───────────────────────────────────────────────────────
  banner('Step 4 of 5 — Bot Tokens (all optional)')
  info('Only configure the platforms you want to use. Others can be added later.')

  const telegramToken = await ask('TELEGRAM_BOT_TOKEN  (from @BotFather on Telegram)', '')
  const discordToken  = await ask('DISCORD_BOT_TOKEN   (from discord.com/developers)', '')
  const slackBotToken = await ask('SLACK_BOT_TOKEN     (from api.slack.com/apps)', '')
  const slackSignSecret = slackBotToken
    ? await ask('SLACK_SIGNING_SECRET (from api.slack.com/apps → Basic Info)', '')
    : ''
  const slackAppToken = slackBotToken
    ? await ask('SLACK_APP_TOKEN      (xapp-... from api.slack.com/apps → App-Level Tokens)', '')
    : ''

  // ── Step 5: Write files ──────────────────────────────────────────────────────
  banner('Step 5 of 5 — Writing Configuration Files')

  // quorum-server .env
  const serverEnvPath = path.join(ROOT, 'apps', 'quorum-server', '.env')
  writeEnvFile(serverEnvPath, {
    JWT_SECRET: jwtSecret,
    BOT_SECRET: botSecret,
    DB_PATH: './quorum.db',
    PORT: serverPort,
    PUBLIC_URL: publicUrl,
    ALLOWED_ORIGINS: allowedOrigins,
    __comment__1: 'LLM fallback keys (optional — users can add their own via the web UI)',
    GROQ_API_KEY: groqKey,
    GOOGLE_AI_API_KEY: googleKey,
    OPENAI_API_KEY: openaiKey,
    ANTHROPIC_API_KEY: anthropicKey,
    __comment__2: 'Frontend',
    VITE_API_URL: `http://localhost:${serverPort}`,
    QUORUM_SERVER_URL: `http://localhost:${serverPort}`,
  }, 'QUORUM Server — auto-generated by setup wizard')

  // quorum-bot .env
  const botEnvPath = path.join(ROOT, 'apps', 'quorum-bot', '.env')
  writeEnvFile(botEnvPath, {
    QUORUM_SERVER_URL: `http://localhost:${serverPort}`,
    BOT_SECRET: botSecret,
    DEFAULT_PROJECT_DIR: projectDir,
    __comment__1: 'Telegram',
    TELEGRAM_BOT_TOKEN: telegramToken,
    __comment__2: 'Discord',
    DISCORD_BOT_TOKEN: discordToken,
    __comment__3: 'Slack',
    SLACK_BOT_TOKEN: slackBotToken,
    SLACK_SIGNING_SECRET: slackSignSecret,
    SLACK_APP_TOKEN: slackAppToken,
    SLACK_PORT: '3979',
  }, 'QUORUM Bot — auto-generated by setup wizard')

  // quorum.config.json — LLM keys
  const configPath = path.join(ROOT, 'quorum.config.json')
  if (fs.existsSync(configPath)) {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    const keyUpdates: Record<string, string> = {}
    if (groqKey)      keyUpdates['GROQ_API_KEY']     = groqKey
    if (googleKey)    keyUpdates['GOOGLE_AI_API_KEY'] = googleKey
    if (openaiKey)    keyUpdates['OPENAI_API_KEY']    = openaiKey
    if (anthropicKey) keyUpdates['ANTHROPIC_API_KEY'] = anthropicKey
    if (DRY_RUN) {
      console.log(`\n  [dry-run] Would update quorum.config.json api_keys:`, keyUpdates)
    } else {
      Object.assign(cfg.api_keys, keyUpdates)
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf-8')
      ok('Updated quorum.config.json with API keys')
    }
  } else {
    warn('quorum.config.json not found — skipping LLM key update')
  }

  // ── Install dependencies ─────────────────────────────────────────────────────
  console.log()
  const doInstall = await ask('Install npm dependencies now? (recommended)', 'yes')

  if (doInstall.toLowerCase().startsWith('y')) {
    banner('Installing Dependencies')
    try {
      info('Installing root workspace packages...')
      runCmd('npm install')

      for (const app of ['quorum-server', 'quorum-bot', 'quorum-web']) {
        const appDir = path.join(ROOT, 'apps', app)
        if (fs.existsSync(appDir)) {
          info(`Installing ${app}...`)
          runCmd('npm install', appDir)
        }
      }

      info('Building shared packages...')
      runCmd('npm run build')

      ok('All dependencies installed and packages built')
    } catch (err) {
      warn(`Install failed: ${(err as Error).message}`)
      warn('Run npm install manually in the root and each app directory.')
    }
  } else {
    skip('Skipped npm install — run it manually before starting')
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  banner('✅  Setup Complete!')

  console.log(`
  Files written:
    apps/quorum-server/.env
    apps/quorum-bot/.env
    quorum.config.json (API keys updated)

  To start QUORUM, open two terminals:

  ┌─ Terminal 1 — Server ─────────────────────────────────┐
  │  cd apps/quorum-server                                  │
  │  npm run dev                                           │
  └────────────────────────────────────────────────────────┘

  ┌─ Terminal 2 — Bot ────────────────────────────────────┐
  │  cd apps/quorum-bot                                     │
  │  npm run dev                                           │
  └────────────────────────────────────────────────────────┘

  ┌─ Terminal 3 (optional) — Web UI ──────────────────────┐
  │  cd apps/quorum-web                                     │
  │  npm run dev                                           │
  └────────────────────────────────────────────────────────┘

  ┌─ First-time login ────────────────────────────────────┐
  │  Open: http://localhost:${serverPort}                            │
  │  Or use the web UI at: http://localhost:5173           │
  │                                                        │
  │  Register an account, then use /login in your bot     │
  │  to link your chat account.                            │
  └────────────────────────────────────────────────────────┘
`)

  if (!telegramToken && !discordToken && !slackBotToken) {
    warn('No bot tokens configured. Add at least one to apps/quorum-bot/.env')
    warn('and restart the bot.')
    console.log()
  }

  rl.close()
}

main().catch(err => {
  console.error('\n❌ Setup failed:', err.message)
  process.exit(1)
})
