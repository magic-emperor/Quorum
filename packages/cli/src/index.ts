#!/usr/bin/env node
import { program } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import inquirer from 'inquirer'
import { ATLASEngine } from '@atlas/core'
import type { Checkpoint } from '@atlas/core'
import { discoverProviderModels, envVarToProvider, providerToEnvVar } from '@atlas/core'
import { readFileSync, existsSync, writeFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const pkg = JSON.parse(
  readFileSync(path.join(__dirname, '../package.json'), 'utf-8')
) as { version: string }

program
  .name('atlas')
  .description('ATLAS — autonomous multi-agent development framework')
  .version(pkg.version)

// ── atlas new ─────────────────────────────────────────────────────────────────
program
  .command('new <description>')
  .description('Build a new feature or application from scratch')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--config <path>', 'Path to atlas.config.json')
  .option('--no-checkpoints', 'Skip human checkpoints (autonomous mode)')
  .action(async (description: string, opts: { dir: string; config?: string; checkpoints: boolean }) => {
    await runATLAS('new', description, opts)
  })

// ── atlas enhance ─────────────────────────────────────────────────────────────
program
  .command('enhance <description>')
  .description('Modify or extend an existing feature')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--config <path>', 'Path to atlas.config.json')
  .action(async (description: string, opts: { dir: string; config?: string }) => {
    await runATLAS('enhance', description, opts)
  })

// ── atlas status ──────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show current execution state and model routing')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (opts: { dir: string }) => {
    await runATLAS('status', undefined, opts)
  })

// ── atlas sync ────────────────────────────────────────────────────────────────
program
  .command('sync')
  .description('Re-index project after manual changes')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (opts: { dir: string }) => {
    await runATLAS('sync', undefined, opts)
  })

// ── atlas rollback ────────────────────────────────────────────────────────────
program
  .command('rollback [point]')
  .description('Return to a previous rollback point')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--list', 'List available rollback points')
  .action(async (point: string | undefined, opts: { dir: string }) => {
    await runATLAS('rollback', point, opts)
  })

// ── atlas key ─────────────────────────────────────────────────────────────────
const keyCmd = program.command('key').description('Manage API keys — ATLAS auto-discovers models when you add a key')

// atlas key add PROVIDER_KEY=value  OR  atlas key add PROVIDER_KEY value
keyCmd
  .command('add <keyspec> [value]')
  .description('Add or update an API key, auto-discover available models')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (keyspec: string, value: string | undefined, opts: { dir: string }) => {
    printBanner()
    const spinner = ora({ color: 'cyan' }).start('Validating key...')

    // Parse: "GROQ_API_KEY=xxx" or "GROQ_API_KEY" + value=xxx
    let envVar: string
    let keyValue: string

    if (keyspec.includes('=')) {
      const eq = keyspec.indexOf('=')
      envVar = keyspec.slice(0, eq).trim().toUpperCase()
      keyValue = keyspec.slice(eq + 1).trim()
    } else if (value) {
      envVar = keyspec.trim().toUpperCase()
      keyValue = value.trim()
    } else {
      spinner.fail('Usage: atlas key add PROVIDER_KEY=your-key-value')
      process.exit(1)
    }

    const provider = envVarToProvider(envVar)
    if (!provider) {
      spinner.fail(`Unknown key: ${envVar}. Known keys: ANTHROPIC_API_KEY, GOOGLE_AI_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, DEEPSEEK_API_KEY`)
      process.exit(1)
    }

    spinner.text = `Discovering ${provider} models...`

    // Discover models
    const result = await discoverProviderModels(provider, keyValue)

    if (!result.success) {
      spinner.warn(chalk.yellow(`  ⚠ ${result.message}`))
      const { proceed } = await inquirer.prompt<{ proceed: boolean }>([{
        type: 'confirm',
        name: 'proceed',
        message: 'Save the key anyway? (you can fix issues later)',
        default: false
      }])
      if (!proceed) {
        console.log(chalk.dim('  Key not saved.'))
        return
      }
    } else {
      spinner.succeed(chalk.green(`  ✓ ${result.message}`))
    }

    // Load config file
    const configPath = path.resolve(opts.dir, 'atlas.config.json')
    if (!existsSync(configPath)) {
      console.error(chalk.red(`  ✗ atlas.config.json not found at ${configPath}`))
      process.exit(1)
    }

    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    const apiKeys = (config['api_keys'] ?? {}) as Record<string, string>
    const modelPrefs = (config['model_preferences'] ?? {}) as Record<string, string>

    // Write the key
    apiKeys[envVar] = keyValue
    config['api_keys'] = apiKeys

    // Write discovered model preferences
    if (result.success && result.tiers) {
      const { smart, balanced, fast } = result.tiers
      modelPrefs[`${provider}_smart`]    = smart
      modelPrefs[`${provider}_balanced`] = balanced
      modelPrefs[`${provider}_fast`]     = fast
      config['model_preferences'] = modelPrefs

      console.log(chalk.cyan(`\n  Models configured automatically:`))
      console.log(chalk.white(`    smart    → ${provider}/${smart}`))
      console.log(chalk.white(`    balanced → ${provider}/${balanced}`))
      console.log(chalk.white(`    fast     → ${provider}/${fast}`))
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    console.log(chalk.green(`\n  ✓ atlas.config.json updated — ${envVar} saved`))

    if (result.success) {
      console.log(chalk.dim(`\n  Run atlas status to see your active providers and routing.\n`))
    }
  })

// atlas key list
keyCmd
  .command('list')
  .description('List configured providers and which models ATLAS uses for each tier')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (opts: { dir: string }) => {
    printBanner()

    const configPath = path.resolve(opts.dir, 'atlas.config.json')
    if (!existsSync(configPath)) {
      console.error(chalk.red(`  ✗ atlas.config.json not found at ${configPath}`))
      process.exit(1)
    }

    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      api_keys: Record<string, string>
      model_preferences?: Record<string, string>
    }
    const apiKeys = config['api_keys'] ?? {}
    const prefs   = config['model_preferences'] ?? {}

    // Known providers + their env var names
    const providers = [
      { envVar: 'ANTHROPIC_API_KEY',    slug: 'anthropic', label: 'Anthropic (Claude)' },
      { envVar: 'GOOGLE_AI_API_KEY',    slug: 'google',    label: 'Google AI (Gemini)' },
      { envVar: 'OPENAI_API_KEY',       slug: 'openai',    label: 'OpenAI (GPT)' },
      { envVar: 'GROQ_API_KEY',         slug: 'groq',      label: 'Groq (Llama)' },
      { envVar: 'DEEPSEEK_API_KEY',     slug: 'deepseek',  label: 'DeepSeek' },
      { envVar: 'MISTRAL_API_KEY',      slug: 'mistral',   label: 'Mistral' },
      { envVar: 'V0_API_KEY',           slug: 'v0',        label: 'v0 (Vercel UI)' },
      { envVar: 'LOVABLE_API_KEY',      slug: 'lovable',   label: 'Lovable' },
    ]

    console.log(chalk.bold('\n  Configured providers:\n'))

    let anyConfigured = false
    for (const { envVar, slug, label } of providers) {
      const configVal = apiKeys[envVar]
      const envVal    = process.env[envVar]
      const hasKey    = configVal && configVal.length > 0
      const hasEnvKey = envVal && envVal.length > 0

      if (hasKey) {
        anyConfigured = true
        const masked = configVal.slice(0, 8) + '...'
        const smart    = prefs[`${slug}_smart`]    ?? chalk.dim('default')
        const balanced = prefs[`${slug}_balanced`] ?? chalk.dim('default')
        const fast     = prefs[`${slug}_fast`]     ?? chalk.dim('default')

        console.log(chalk.green(`  ✓ ${label} (${masked})`))
        console.log(chalk.dim(`      smart: ${smart}  balanced: ${balanced}  fast: ${fast}`))
      } else if (configVal === '' && hasEnvKey) {
        // Explicitly disabled in config but present in env
        console.log(chalk.yellow(`  ⊘ ${label} — disabled in config (key is in system env but excluded)`))
        console.log(chalk.dim('      To enable: run  atlas key add ' + envVar + '=your-key'))
      } else if (!configVal && hasEnvKey) {
        // In env but not in config — treat as active
        anyConfigured = true
        console.log(chalk.cyan(`  ~ ${label} — from environment variable`))
      }
    }

    if (!anyConfigured) {
      console.log(chalk.yellow('  No providers configured.\n'))
      console.log(chalk.white('  Get started:'))
      console.log(chalk.dim('    atlas key add GOOGLE_AI_API_KEY=your-key   (free tier available)'))
      console.log(chalk.dim('    atlas key add GROQ_API_KEY=your-key         (free)'))
    }

    console.log('')
  })

// atlas key remove
keyCmd
  .command('remove <provider>')
  .description('Remove an API key for a provider (disables it)')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (provider: string, opts: { dir: string }) => {
    printBanner()

    const configPath = path.resolve(opts.dir, 'atlas.config.json')
    if (!existsSync(configPath)) {
      console.error(chalk.red(`  ✗ atlas.config.json not found`))
      process.exit(1)
    }

    const envVar = providerToEnvVar(provider.toLowerCase())
    if (!envVar) {
      console.error(chalk.red(`  ✗ Unknown provider: ${provider}. Use: anthropic, google, openai, groq, deepseek`))
      process.exit(1)
    }

    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    const apiKeys = (config['api_keys'] ?? {}) as Record<string, string>
    apiKeys[envVar] = ''   // empty = explicitly disabled
    config['api_keys'] = apiKeys

    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    console.log(chalk.yellow(`  ⊘ ${provider} disabled in atlas.config.json`))
    console.log(chalk.dim(`  (Set to empty string — will be excluded even if ${envVar} is in your system environment)\n`))
  })

// ── Runner ────────────────────────────────────────────────────────────────────
async function runATLAS(
  command: string,
  description: string | undefined,
  opts: { dir?: string; config?: string; checkpoints?: boolean }
): Promise<void> {
  const projectDir = path.resolve(opts.dir ?? process.cwd())
  const spinner = ora({ color: 'cyan' })

  printBanner()

  // Fail fast if no API key at all
  if (!process.env['ANTHROPIC_API_KEY'] && !process.env['OPENAI_API_KEY']) {
    const cfgPath = opts.config ?? path.join(projectDir, 'atlas.config.json')
    if (!existsSync(cfgPath)) {
      console.error(chalk.red('\n  ✗ No API keys detected.\n'))
      console.error(chalk.yellow('  Set at minimum:'))
      console.error(chalk.white('    export ANTHROPIC_API_KEY=your-key'))
      console.error(chalk.gray('    https://console.anthropic.com\n'))
      process.exit(1)
    }
  }

  const engine = new ATLASEngine({
    projectDir,
    configPath: opts.config
  })

  try {
    await engine.run({
      command: command as 'new' | 'enhance' | 'status' | 'rollback' | 'sync',
      description,
      projectDir,

      onProgress: (message: string) => {
        if (message.startsWith('\n──')) {
          spinner.stop()
          console.log(chalk.cyan(message))
          spinner.start()
        } else if (message.startsWith('ATLAS') || message.startsWith('\nATLAS')) {
          spinner.stop()
          console.log(chalk.bold.green(message))
        } else if (message.startsWith('  tool:') || message.startsWith('  ')) {
          // Sub-details — keep as spinner text or dim line
          spinner.text = chalk.dim(message)
        } else {
          spinner.stop()
          spinner.text = message
          spinner.start()
        }
      },

      onAgentOutput: (agent: string, output: string) => {
        spinner.stop()
        console.log(chalk.dim(`\n─── ${agent} `))
        const preview = output.length > 600 ? output.slice(0, 600) + '…' : output
        console.log(chalk.dim(preview))
      },

      onCheckpoint: async (checkpoint: Checkpoint): Promise<string> => {
        spinner.stop()
        printCheckpoint(checkpoint)

        if (opts.checkpoints === false) {
          console.log(chalk.yellow('  Auto-approving (--no-checkpoints)'))
          return 'APPROVE'
        }

        const { response } = await inquirer.prompt<{ response: string }>([{
          type: 'input',
          name: 'response',
          message: chalk.bold('Your response:'),
          default: 'APPROVE'
        }])
        return response
      }
    })

    spinner.stop()
    console.log(chalk.bold.green('\n  ✓ ATLAS complete.\n'))

  } catch (err) {
    spinner.stop()
    const msg = err instanceof Error ? err.message : String(err)
    console.error(chalk.red(`\n  ✗ ${msg}\n`))
    process.exit(1)
  }
}

// ── UI Helpers ────────────────────────────────────────────────────────────────
function printBanner(): void {
  console.log(chalk.bold.cyan(`
  ╔═══════════════════════════════════════════╗
  ║  ATLAS — Autonomous Development Framework ║
  ║  Autonomous Team for Large-scale Apps     ║
  ╚═══════════════════════════════════════════╝`))
}

function printCheckpoint(cp: Checkpoint): void {
  const bar = '━'.repeat(50)
  console.log(chalk.bold.yellow(`\n  ╔ CHECKPOINT ${cp.type} — ${cp.title}`))
  console.log(chalk.yellow(`  ╠${bar}`))

  if (cp.completed.length > 0) {
    console.log(chalk.green('\n  ✓ Completed:'))
    cp.completed.forEach((c: string) => console.log(chalk.green(`    · ${c}`)))
  }

  console.log(chalk.bold(`\n  ${cp.question}`))

  if (cp.options.length > 0) {
    console.log(chalk.dim('\n  Options:'))
    cp.options.forEach((opt: { label: string; tradeoff: string }, i: number) => {
      const letter = String.fromCharCode(65 + i)
      const tradeoff = opt.tradeoff ? chalk.gray(` — ${opt.tradeoff}`) : ''
      console.log(chalk.white(`    ${letter}) ${opt.label}`) + tradeoff)
    })
  }

  if (cp.supportingDoc) {
    console.log(chalk.dim(`\n  📄 See: ${cp.supportingDoc}`))
  }

  console.log(chalk.yellow(`  ╠${bar}\n`))
}

program.parse(process.argv)
