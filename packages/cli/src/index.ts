#!/usr/bin/env node
import { program } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import inquirer from 'inquirer'
import { ATLASEngine } from '@atlas/core'
import type { Checkpoint, ATLASRunOptions } from '@atlas/core'
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

// ── atlas init ───────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Initialize ATLAS in this project — creates .atlas/ folder and goal.md')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--auto', 'Skip all prompts')
  .action(async (opts: { dir: string; auto?: boolean }) => {
    await runATLAS('init', undefined, opts)
  })

// ── atlas fast ────────────────────────────────────────────────────────────────
program
  .command('fast <description>')
  .description('Quick task — no full pipeline (< 5 file changes)')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--no-save', 'Do not save to .atlas/task.md')
  .action(async (description: string, opts: { dir: string; save?: boolean }) => {
    await runATLAS('fast', description, { ...opts, noSave: opts.save === false })
  })

// ── atlas next ────────────────────────────────────────────────────────────────
program
  .command('next')
  .description('Auto-detect what to do next based on project state')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (opts: { dir: string }) => {
    await runATLAS('next', undefined, opts)
  })

// ── atlas pause ───────────────────────────────────────────────────────────────
program
  .command('pause')
  .description('Cleanly pause mid-session — saves state for resumption')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (opts: { dir: string }) => {
    await runATLAS('pause', undefined, opts)
  })

// ── atlas resume ──────────────────────────────────────────────────────────────
program
  .command('resume')
  .description('Resume a paused session from saved state')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--auto', 'Auto-approve resume without confirmation')
  .action(async (opts: { dir: string; auto?: boolean }) => {
    await runATLAS('resume', undefined, opts)
  })

// ── atlas doctor ──────────────────────────────────────────────────────────────
program
  .command('doctor')
  .description('Check ATLAS installation health and fix issues')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--repair', 'Auto-fix repairable issues')
  .action(async (opts: { dir: string; repair?: boolean }) => {
    await runATLAS('doctor', undefined, { ...opts, extra: { repair: String(!!opts.repair) } })
  })

// ── atlas discuss ─────────────────────────────────────────────────────────────
program
  .command('discuss <feature>')
  .description('Gather context and questions before planning — prevents wrong assumptions')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (feature: string, opts: { dir: string }) => {
    await runATLAS('discuss', feature, opts)
  })

// ── atlas verify ──────────────────────────────────────────────────────────────
program
  .command('verify')
  .description('Interactive UAT — walk through each deliverable and confirm it works')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--auto', 'Auto-pass all items (for CI)')
  .action(async (opts: { dir: string; auto?: boolean }) => {
    await runATLAS('verify', undefined, opts)
  })

// ── atlas ship ────────────────────────────────────────────────────────────────
program
  .command('ship')
  .description('Create pull request from verified completed work')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--draft', 'Create as draft PR')
  .option('--auto', 'Skip confirmation')
  .action(async (opts: { dir: string; draft?: boolean; auto?: boolean }) => {
    await runATLAS('ship', undefined, { ...opts, extra: { draft: String(!!opts.draft) } })
  })

// ── atlas review ──────────────────────────────────────────────────────────────
program
  .command('review [path]')
  .description('Run code + security review on uncommitted changes')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (targetPath: string | undefined, opts: { dir: string }) => {
    await runATLAS('review', targetPath, opts)
  })

// ── atlas map ─────────────────────────────────────────────────────────────────
program
  .command('map [area]')
  .description('Let agents read and summarize your existing codebase')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (area: string | undefined, opts: { dir: string }) => {
    await runATLAS('map', area ?? 'src', opts)
  })

// ── atlas debug ───────────────────────────────────────────────────────────────
program
  .command('debug <description>')
  .description('Systematic debugging — traces root cause and proposes fix')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--auto', 'Auto-apply proposed fix without confirmation')
  .action(async (description: string, opts: { dir: string; auto?: boolean }) => {
    await runATLAS('debug', description, opts)
  })

// ── atlas session-report ──────────────────────────────────────────────────────
program
  .command('session-report')
  .description('Generate human-readable summary of this session')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (opts: { dir: string }) => {
    await runATLAS('session-report', undefined, opts)
  })

// ── atlas seed ────────────────────────────────────────────────────────────────
program
  .command('seed <idea>')
  .description('Capture a future idea to surface at the right milestone')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--trigger <condition>', 'When to surface this idea', 'next milestone')
  .action(async (idea: string, opts: { dir: string; trigger?: string }) => {
    await runATLAS('seed', idea, { ...opts, extra: { trigger: opts.trigger ?? 'next milestone' } })
  })

// ── atlas backlog ─────────────────────────────────────────────────────────────
program
  .command('backlog [subcommand] [description]')
  .description('Manage backlog: atlas backlog [add|list|promote] [text/number]')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--priority <level>', 'Priority: high | medium | low', 'medium')
  .action(async (subcommand: string = 'list', description: string = '', opts: { dir: string; priority?: string }) => {
    await runATLAS('backlog', description, { ...opts, subcommand, extra: { priority: opts.priority ?? 'medium' } })
  })

// ── atlas note ────────────────────────────────────────────────────────────────
program
  .command('note <text>')
  .description('Capture a quick note to .atlas/NOTES.md')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (text: string, opts: { dir: string }) => {
    await runATLAS('note', text, opts)
  })

// ── atlas agents ──────────────────────────────────────────────────────────────
program
  .command('agents')
  .description('List all agents with their current model assignments')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (opts: { dir: string }) => {
    await runATLAS('agents', undefined, opts)
  })

// ── atlas profile ─────────────────────────────────────────────────────────────
program
  .command('profile <name>')
  .description('Switch model profile: fast | balanced | quality')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (name: string, opts: { dir: string }) => {
    await runATLAS('profile', name, opts)
  })

// ── atlas help ────────────────────────────────────────────────────────────────
program
  .command('help')
  .description('Show all commands with descriptions')
  .action(() => {
    printBanner()
    console.log(chalk.bold('\nCOMMANDS\n'))
    const commands = [
      ['init', 'Initialize ATLAS in this project'],
      ['new <description>', 'Build new feature from scratch (full pipeline)'],
      ['enhance <description>', 'Modify existing feature (targeted)'],
      ['fast <description>', 'Quick task — no full pipeline (< 5 files)'],
      ['next', 'Auto-detect what to do next'],
      ['pause / resume', 'Save and restore mid-session state'],
      ['doctor [--repair]', 'Health check and auto-fix issues'],
      ['discuss <feature>', 'Gather context before planning (prevents mistakes)'],
      ['verify', 'Interactive UAT — confirm each deliverable works'],
      ['ship [--draft]', 'Create pull request from completed work'],
      ['review [path]', 'Code + security review of uncommitted changes'],
      ['map [area]', 'Agents read and summarize your codebase'],
      ['debug <description>', 'Systematic debugging — find and fix root cause'],
      ['session-report', 'Summary of what happened this session'],
      ['seed <idea>', 'Capture future idea for later (non-disruptive)'],
      ['backlog [add|list|promote]', 'Manage items outside active tasks'],
      ['note <text>', 'Quick note to .atlas/NOTES.md'],
      ['agents', 'List all agents and their model assignments'],
      ['profile <fast|balanced|quality>', 'Switch model quality tier'],
      ['key add/list/remove', 'Manage API keys and auto-discover models'],
      ['status', 'Current state, routing, costs'],
      ['rollback [point]', 'Return to previous rollback point'],
      ['sync', 'Re-index project after manual changes'],
    ]
    commands.forEach(([cmd, desc]) => {
      console.log(`  ${chalk.cyan(('atlas ' + cmd!).padEnd(38))} ${chalk.white(desc!)}`)
    })
    console.log(chalk.dim('\n  atlas <command> --help for command-specific options\n'))
  })

// ── Runner ────────────────────────────────────────────────────────────────────
async function runATLAS(
  command: string,
  description: string | undefined,
  opts: { dir?: string; config?: string; checkpoints?: boolean; auto?: boolean; noSave?: boolean; subcommand?: string; extra?: Record<string, string> }
): Promise<void> {
  const projectDir = path.resolve(opts.dir ?? process.cwd())
  const spinner = ora({ color: 'cyan' })

  printBanner()

  // Commands that don't need API keys
  const noKeyCommands = ['init', 'next', 'pause', 'resume', 'doctor', 'verify',
    'session-report', 'seed', 'backlog', 'note', 'agents', 'profile']
  const needsKey = !noKeyCommands.includes(command)

  // Fail fast if no API key at all (and command needs one)
  if (needsKey) {
    const knownKeyEnvVars = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_AI_API_KEY',
      'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY']
    const hasEnvKey = knownKeyEnvVars.some(k => process.env[k])
    const cfgPath = opts.config ?? path.join(projectDir, 'atlas.config.json')
    const hasCfgKey = existsSync(cfgPath)
    if (!hasEnvKey && !hasCfgKey) {
      console.error(chalk.red('\n  ✗ No API keys detected.\n'))
      console.error(chalk.yellow('  Add a key:'))
      console.error(chalk.white('    atlas key add GOOGLE_AI_API_KEY=your-key  (free tier)'))
      console.error(chalk.white('    atlas key add GROQ_API_KEY=your-key        (free)'))
      console.error(chalk.gray('    https://aistudio.google.com  (Google AI Studio)\n'))
      process.exit(1)
    }
  }

  const engine = new ATLASEngine({
    projectDir,
    configPath: opts.config
  })

  try {
    await engine.run({
      command: command as ATLASRunOptions['command'],
      description,
      projectDir,
      auto: opts.auto,
      noSave: opts.noSave,
      subcommand: opts.subcommand,
      extra: opts.extra,

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
