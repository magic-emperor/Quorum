
// #!/usr/bin / env node
import { program } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import inquirer from 'inquirer'
import { QUORUMEngine } from '@quorum/core'
import type { Checkpoint, QUORUMRunOptions } from '@quorum/core'
import { discoverProviderModels, envVarToProvider, providerToEnvVar } from '@quorum/core'
import { readFileSync, existsSync, writeFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
// import { env } from 'process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const pkg = JSON.parse(
  readFileSync(path.join(__dirname, '../package.json'), 'utf-8')
) as { version: string }

program
  .name('quorum')
  .description('QUORUM — autonomous multi-agent development framework')
  .version(pkg.version)

// ── quorum new ─────────────────────────────────────────────────────────────────
program
  .command('new <description>')
  .description('Build a new feature or application from scratch')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--config <path>', 'Path to quorum.config.json')
  .option('--no-checkpoints', 'Skip human checkpoints (autonomous mode)')
  .action(async (description: string, opts: { dir: string; config?: string; checkpoints: boolean }) => {
    await runQUORUM('new', description, opts)
  })

// ── quorum enhance ─────────────────────────────────────────────────────────────
program
  .command('enhance <description>')
  .description('Modify or extend an existing feature')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--config <path>', 'Path to quorum.config.json')
  .action(async (description: string, opts: { dir: string; config?: string }) => {
    await runQUORUM('enhance', description, opts)
  })

// ── quorum status ──────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show current execution state and model routing')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (opts: { dir: string }) => {
    await runQUORUM('status', undefined, opts)
  })

// ── quorum chat ────────────────────────────────────────────────────────────────
program
  .command('chat')
  .description('Start an interactive QUORUM chat session (like Claude Code)')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--config <path>', 'Path to quorum.config.json')
  .action(async (opts: { dir: string; config?: string }) => {
    const { createInterface } = await import('readline')
    const chalk = (await import('chalk')).default
    const { QUORUMEngine } = await import('@quorum/core')

    printBanner()

    const projectDir = path.resolve(opts.dir)
    const engine = new QUORUMEngine({ projectDir, configPath: opts.config })

    // Initialise once (loads config, routing table, API keys)
    const spinner = ora({ color: 'cyan', text: 'Connecting to QUORUM...' }).start()
    try {
      await engine.initialize()
      spinner.succeed(chalk.green('QUORUM Chat ready'))
    } catch (err: unknown) {
      spinner.fail(chalk.red(`Init failed: ${err instanceof Error ? err.message : String(err)}`))
      process.exit(1)
    }

    console.log(chalk.dim(`  Project: ${projectDir}`))
    console.log(chalk.dim('  Type your message. Commands: !clear !exit  |  Ctrl+C to quit\n'))

    // Conversation history — persists for the whole session
    let history: import('@quorum/core').AgentMessage[] = []

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.bold.cyan('You › '),
      historySize: 50,
      terminal: true
    })

    rl.prompt()

    rl.on('line', async (line: string) => {
      const input = line.trim()
      if (!input) { rl.prompt(); return }

      // Special commands
      if (input === '!exit' || input === '.exit') { rl.close(); return }
      if (input === '!clear') {
        history = []
        console.log(chalk.dim('  ✦ History cleared\n'))
        rl.prompt()
        return
      }

      rl.pause()
      console.log() // blank line before response

      try {
        const result = await engine.runChatTurn(input, history, {
          onProgress: (msg: string) => {
            // Skip internal routing/tool lines — only show meaningful output
            if (msg.startsWith('[quorum-chat]') || msg.startsWith('  tool:')) return
            process.stdout.write(chalk.gray('  ' + msg + '\n'))
          }
        })

        history = result.updatedHistory

        // Print the clean response (strip internal JSON tool call blocks)
        const clean = result.response
          .replace(/```json\n\{[^`]*\}\n```/g, '')  // remove JSON tool call blocks
          .trim()

        console.log('\n' + chalk.white(clean) + '\n')
      } catch (err: unknown) {
        console.log(chalk.red(`  ✗ ${err instanceof Error ? err.message : String(err)}\n`))
      }

      rl.resume()
      rl.prompt()
    })

    rl.on('close', () => {
      console.log(chalk.dim('\n  QUORUM session ended. Goodbye!\n'))
      process.exit(0)
    })
  })

// ── quorum sync ────────────────────────────────────────────────────────────────
program
  .command('sync')
  .description('Re-index project after manual changes')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (opts: { dir: string }) => {
    await runQUORUM('sync', undefined, opts)
  })

// ── quorum rollback ────────────────────────────────────────────────────────────
program
  .command('rollback [point]')
  .description('Return to a previous rollback point')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--list', 'List available rollback points')
  .action(async (point: string | undefined, opts: { dir: string }) => {
    await runQUORUM('rollback', point, opts)
  })

// ── quorum key ─────────────────────────────────────────────────────────────────
const keyCmd = program.command('key').description('Manage API keys — QUORUM auto-discovers models when you add a key')

// quorum key add PROVIDER_KEY=value  OR  quorum key add PROVIDER_KEY value
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
      spinner.fail('Usage: quorum key add PROVIDER_KEY=your-key-value')
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

    // Auto-create quorum.config.json if it doesn't exist yet
    const configPath = path.resolve(opts.dir, 'quorum.config.json')
    if (!existsSync(configPath)) {
      const minimal = {
        version: '2.0',
        api_keys: {},
        auto_provider_selection: {},
        model_preferences: {},
        fallback_strategy: {
          on_provider_unavailable: 'try_next_in_priority_list',
          final_fallback: ''
        },
        checkpoints: {
          require_human_phase_1: true,
          require_human_phase_2: true,
          require_human_phase_5: true,
          prompt_scaling_phase_6: false,
          auto_proceed_simple_projects: true
        },
        token_budgets: {},
        loop_limits: {},
        project: { name: path.basename(opts.dir), description: '', team_size: 1, project_hash: '' }
      }
      writeFileSync(configPath, JSON.stringify(minimal, null, 2), 'utf-8')
      console.log(chalk.dim(`  ✦ Created quorum.config.json in ${opts.dir}`))
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
      modelPrefs[`${provider}_smart`] = smart
      modelPrefs[`${provider}_balanced`] = balanced
      modelPrefs[`${provider}_fast`] = fast
      config['model_preferences'] = modelPrefs

      console.log(chalk.cyan(`\n  Models configured automatically:`))
      console.log(chalk.white(`    smart    → ${provider}/${smart}`))
      console.log(chalk.white(`    balanced → ${provider}/${balanced}`))
      console.log(chalk.white(`    fast     → ${provider}/${fast}`))
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    console.log(chalk.green(`\n  ✓ quorum.config.json updated — ${envVar} saved`))

    if (result.success) {
      console.log(chalk.dim(`\n  Run quorum status to see your active providers and routing.\n`))
    }
  })

// quorum key list
keyCmd
  .command('list')
  .description('List configured providers and which models QUORUM uses for each tier')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (opts: { dir: string }) => {
    printBanner()

    const configPath = path.resolve(opts.dir, 'quorum.config.json')
    if (!existsSync(configPath)) {
      console.error(chalk.red(`  ✗ quorum.config.json not found at ${configPath}`))
      process.exit(1)
    }

    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      api_keys: Record<string, string>
      model_preferences?: Record<string, string>
    }
    const apiKeys = config['api_keys'] ?? {}
    const prefs = config['model_preferences'] ?? {}

    // Known providers + their env var names
    const providers = [
      { envVar: 'ANTHROPIC_API_KEY', slug: 'anthropic', label: 'Anthropic (Claude)' },
      { envVar: 'GOOGLE_AI_API_KEY', slug: 'google', label: 'Google AI (Gemini)' },
      { envVar: 'OPENAI_API_KEY', slug: 'openai', label: 'OpenAI (GPT)' },
      { envVar: 'GROQ_API_KEY', slug: 'groq', label: 'Groq (Llama)' },
      { envVar: 'DEEPSEEK_API_KEY', slug: 'deepseek', label: 'DeepSeek' },
      { envVar: 'MISTRAL_API_KEY', slug: 'mistral', label: 'Mistral' },
      { envVar: 'V0_API_KEY', slug: 'v0', label: 'v0 (Vercel UI)' },
      { envVar: 'LOVABLE_API_KEY', slug: 'lovable', label: 'Lovable' },
    ]

    console.log(chalk.bold('\n  Configured providers:\n'))

    let anyConfigured = false
    for (const { envVar, slug, label } of providers) {
      const configVal = apiKeys[envVar]
      const envVal = process.env[envVar]
      const hasKey = configVal && configVal.length > 0
      const hasEnvKey = envVal && envVal.length > 0

      if (hasKey) {
        anyConfigured = true
        const masked = configVal.slice(0, 8) + '...'
        const smart = prefs[`${slug}_smart`] ?? chalk.dim('default')
        const balanced = prefs[`${slug}_balanced`] ?? chalk.dim('default')
        const fast = prefs[`${slug}_fast`] ?? chalk.dim('default')

        console.log(chalk.green(`  ✓ ${label} (${masked})`))
        console.log(chalk.dim(`      smart: ${smart}  balanced: ${balanced}  fast: ${fast}`))
      } else if (configVal === '' && hasEnvKey) {
        // Explicitly disabled in config but present in env
        console.log(chalk.yellow(`  ⊘ ${label} — disabled in config (key is in system env but excluded)`))
        console.log(chalk.dim('      To enable: run  quorum key add ' + envVar + '=your-key'))
      } else if (!configVal && hasEnvKey) {
        // In env but not in config — treat as active
        anyConfigured = true
        console.log(chalk.cyan(`  ~ ${label} — from environment variable`))
      }
    }

    if (!anyConfigured) {
      console.log(chalk.yellow('  No providers configured.\n'))
      console.log(chalk.white('  Get started:'))
      console.log(chalk.dim('    quorum key add GOOGLE_AI_API_KEY=your-key   (free tier available)'))
      console.log(chalk.dim('    quorum key add GROQ_API_KEY=your-key         (free)'))
    }

    console.log('')
  })

// quorum key remove
keyCmd
  .command('remove <provider>')
  .description('Remove an API key for a provider (disables it)')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (provider: string, opts: { dir: string }) => {
    printBanner()

    const configPath = path.resolve(opts.dir, 'quorum.config.json')
    if (!existsSync(configPath)) {
      console.error(chalk.red(`  ✗ quorum.config.json not found`))
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
    console.log(chalk.yellow(`  ⊘ ${provider} disabled in quorum.config.json`))
    console.log(chalk.dim(`  (Set to empty string — will be excluded even if ${envVar} is in your system environment)\n`))
  })

// ── quorum init ───────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Initialize QUORUM in this project — creates .quorum/ folder and goal.md')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--auto', 'Skip all prompts')
  .action(async (opts: { dir: string; auto?: boolean }) => {
    await runQUORUM('init', undefined, opts)
  })

// ── quorum fast ────────────────────────────────────────────────────────────────
program
  .command('fast <description>')
  .description('Quick task — no full pipeline (< 5 file changes)')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--no-save', 'Do not save to .quorum/task.md')
  .action(async (description: string, opts: { dir: string; save?: boolean }) => {
    await runQUORUM('fast', description, { ...opts, noSave: opts.save === false })
  })

// ── quorum next ────────────────────────────────────────────────────────────────
program
  .command('next')
  .description('Auto-detect what to do next based on project state')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (opts: { dir: string }) => {
    await runQUORUM('next', undefined, opts)
  })

// ── quorum pause ───────────────────────────────────────────────────────────────
program
  .command('pause')
  .description('Cleanly pause mid-session — saves state for resumption')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (opts: { dir: string }) => {
    await runQUORUM('pause', undefined, opts)
  })

// ── quorum resume ──────────────────────────────────────────────────────────────
program
  .command('resume')
  .description('Resume a paused session from saved state')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--auto', 'Auto-approve resume without confirmation')
  .action(async (opts: { dir: string; auto?: boolean }) => {
    await runQUORUM('resume', undefined, opts)
  })

// ── quorum doctor ──────────────────────────────────────────────────────────────
program
  .command('doctor')
  .description('Check QUORUM installation health and fix issues')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--repair', 'Auto-fix repairable issues')
  .action(async (opts: { dir: string; repair?: boolean }) => {
    await runQUORUM('doctor', undefined, { ...opts, extra: { repair: String(!!opts.repair) } })
  })

// ── quorum discuss ─────────────────────────────────────────────────────────────
program
  .command('discuss <feature>')
  .description('Gather context and questions before planning — prevents wrong assumptions')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (feature: string, opts: { dir: string }) => {
    await runQUORUM('discuss', feature, opts)
  })

// ── quorum verify ──────────────────────────────────────────────────────────────
program
  .command('verify')
  .description('Interactive UAT — walk through each deliverable and confirm it works')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--auto', 'Auto-pass all items (for CI)')
  .action(async (opts: { dir: string; auto?: boolean }) => {
    await runQUORUM('verify', undefined, opts)
  })

// ── quorum ship ────────────────────────────────────────────────────────────────
program
  .command('ship')
  .description('Create pull request from verified completed work')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--draft', 'Create as draft PR')
  .option('--auto', 'Skip confirmation')
  .action(async (opts: { dir: string; draft?: boolean; auto?: boolean }) => {
    await runQUORUM('ship', undefined, { ...opts, extra: { draft: String(!!opts.draft) } })
  })

// ── quorum review ──────────────────────────────────────────────────────────────
program
  .command('review [path]')
  .description('Run code + security review on uncommitted changes')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (targetPath: string | undefined, opts: { dir: string }) => {
    await runQUORUM('review', targetPath, opts)
  })

// ── quorum map ─────────────────────────────────────────────────────────────────
program
  .command('map [area]')
  .description('Let agents read and summarize your existing codebase')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (area: string | undefined, opts: { dir: string }) => {
    await runQUORUM('map', area ?? 'src', opts)
  })

// ── quorum debug ───────────────────────────────────────────────────────────────
program
  .command('debug <description>')
  .description('Systematic debugging — traces root cause and proposes fix')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--auto', 'Auto-apply proposed fix without confirmation')
  .action(async (description: string, opts: { dir: string; auto?: boolean }) => {
    await runQUORUM('debug', description, opts)
  })

// ── quorum session-report ──────────────────────────────────────────────────────
program
  .command('session-report')
  .description('Generate human-readable summary of this session')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (opts: { dir: string }) => {
    await runQUORUM('session-report', undefined, opts)
  })

// ── quorum seed ────────────────────────────────────────────────────────────────
program
  .command('seed <idea>')
  .description('Capture a future idea to surface at the right milestone')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--trigger <condition>', 'When to surface this idea', 'next milestone')
  .action(async (idea: string, opts: { dir: string; trigger?: string }) => {
    await runQUORUM('seed', idea, { ...opts, extra: { trigger: opts.trigger ?? 'next milestone' } })
  })

// ── quorum backlog ─────────────────────────────────────────────────────────────
program
  .command('backlog [subcommand] [description]')
  .description('Manage backlog: quorum backlog [add|list|promote] [text/number]')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--priority <level>', 'Priority: high | medium | low', 'medium')
  .action(async (subcommand: string = 'list', description: string = '', opts: { dir: string; priority?: string }) => {
    await runQUORUM('backlog', description, { ...opts, subcommand, extra: { priority: opts.priority ?? 'medium' } })
  })

// ── quorum note ────────────────────────────────────────────────────────────────
program
  .command('note <text>')
  .description('Capture a quick note to .quorum/NOTES.md')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (text: string, opts: { dir: string }) => {
    await runQUORUM('note', text, opts)
  })

// ── quorum agents ──────────────────────────────────────────────────────────────
program
  .command('agents')
  .description('List all agents with their current model assignments')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (opts: { dir: string }) => {
    await runQUORUM('agents', undefined, opts)
  })

// ── quorum profile ─────────────────────────────────────────────────────────────
program
  .command('profile <name>')
  .description('Switch model profile: fast | balanced | quality')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (name: string, opts: { dir: string }) => {
    await runQUORUM('profile', name, opts)
  })

// ── quorum export ──────────────────────────────────────────────────────────────
program
  .command('export')
  .description('Export .quorum/ artifacts as a shareable markdown document (team handoffs, docs)')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--output <path>', 'Output file path (default: .quorum/export-YYYY-MM-DD.md)')
  .action(async (opts: { dir: string; output?: string }) => {
    await runQUORUM('export', undefined, {
      ...opts,
      extra: opts.output ? { output: opts.output } : undefined
    })
  })

// ── quorum watch ───────────────────────────────────────────────────────────────
program
  .command('watch')
  .description('Monitor PM tool for tickets with keyword — auto-create plan + approval')
  .option('--tool <tool>', 'PM tool: jira | linear | github-issues | azure-boards', 'jira')
  .option('--project <key>', 'Project key (e.g. MYAPP for Jira, owner/repo for GitHub)')
  .option('--keyword <kw>', 'Trigger keyword in ticket title/description', '[QUORUM]')
  .option('--channel <channel>', 'Platform channel to post approval card: teams | slack | discord')
  .option('--token <token>', 'PM tool API token (or set via env: JIRA_TOKEN, LINEAR_TOKEN, GITHUB_TOKEN)')
  .option('--base-url <url>', 'PM tool base URL (e.g. https://company.atlassian.net)')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (opts: {
    tool: string; project?: string; keyword: string
    channel?: string; token?: string; baseUrl?: string; dir: string
  }) => {
    printBanner()

    const tokenEnvMap: Record<string, string> = {
      'jira': 'JIRA_TOKEN',
      'linear': 'LINEAR_TOKEN',
      'github-issues': 'GITHUB_TOKEN',
      'azure-boards': 'AZURE_DEVOPS_TOKEN'
    }
    const token = opts.token ?? process.env[tokenEnvMap[opts.tool] ?? '']

    if (!token) {
      console.error(chalk.red(`\n  ✗ No API token for ${opts.tool}.`))
      console.error(chalk.yellow(`  Set it with --token or via ${tokenEnvMap[opts.tool] ?? 'TOOL_TOKEN'} env var\n`))
      process.exit(1)
    }

    console.log(chalk.cyan(`\n  Watching ${opts.tool} for "${opts.keyword}" tickets...`))
    console.log(chalk.dim(`  Project: ${opts.project ?? 'all'} | Channel: ${opts.channel ?? 'none'} | Quorum: any`))
    console.log(chalk.dim(`  Ctrl+C to stop\n`))

    await runQUORUM('watch', opts.keyword, {
      dir: opts.dir,
      extra: {
        tool: opts.tool,
        project: opts.project ?? '',
        channel: opts.channel ?? '',
        token,
        base_url: opts.baseUrl ?? ''
      }
    })
  })

// ── quorum cost-plan ────────────────────────────────────────────────────────────
program
  .command('cost-plan')
  .description('Stack selection by budget — get the right tech for your cost constraints')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--auto', 'Skip interactive prompts (use defaults for solo/free/mvp)')
  .action(async (opts: { dir: string; auto?: boolean }) => {
    await runQUORUM('cost-plan', undefined, { ...opts })
  })

// ── quorum scale-plan ──────────────────────────────────────────────────────────
program
  .command('scale-plan')
  .description('Scaling & architecture analysis — cost tiers, K8s threshold, DB migration path')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--users <n>', 'Current MAU (monthly active users)')
  .option('--rps <n>', 'Current peak requests/second')
  .action(async (opts: { dir: string; users?: string; rps?: string }) => {
    await runQUORUM('scale-plan', undefined, {
      dir: opts.dir,
      extra: {
        current_users: opts.users ?? '',
        current_rps: opts.rps ?? ''
      }
    })
  })

// ── quorum env ─────────────────────────────────────────────────────────────────
program
  .command('env [subcommand]')
  .description('Manage .env files: quorum env check | generate | sync')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .action(async (subcommand: string = 'check', opts: { dir: string }) => {
    printBanner()
    const sub = subcommand ?? 'check'

    if (!['check', 'generate', 'sync'].includes(sub)) {
      console.error(chalk.red(`  ✗ Unknown subcommand "${sub}". Use: check | generate | sync`))
      process.exit(1)
    }

    console.log(chalk.cyan(`\n  quorum env ${sub}\n`))
    await runQUORUM('env', undefined, { dir: opts.dir, subcommand: sub })
  })

// ── quorum security ─────────────────────────────────────────────────────────────
program
  .command('security')
  .description('Security scan: OWASP Top 10, npm audit, secrets, .gitignore check')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--fix', 'Auto-apply safe fixes (npm audit fix, add .env to .gitignore)')
  .option('--report <path>', 'Save report to file (default: .quorum/security-report.md)')
  .action(async (opts: { dir: string; fix?: boolean; report?: string }) => {
    await runQUORUM('security', undefined, {
      dir: opts.dir,
      extra: {
        auto_fix: String(!!opts.fix),
        report_path: opts.report ?? '.quorum/security-report.md'
      }
    })
  })

// ── quorum monitor ─────────────────────────────────────────────────────────────
program
  .command('monitor [source]')
  .description('Read Sentry/Datadog logs and create .quorum/bugs/ tasks for each unique error')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--sentry <dsn>', 'Sentry DSN or export file path')
  .option('--log <file>', 'Path to a plain text log file')
  .option('--since <hours>', 'Look back N hours (default: 24)', '24')
  .action(async (source: string | undefined, opts: { dir: string; sentry?: string; log?: string; since: string }) => {
    await runQUORUM('monitor', source, {
      dir: opts.dir,
      extra: {
        sentry: opts.sentry ?? '',
        log_file: opts.log ?? '',
        since_hours: opts.since
      }
    })
  })

// ── quorum deps ─────────────────────────────────────────────────────────────────
program
  .command('deps')
  .description('Dependency health: outdated packages, CVEs, license issues, unused deps')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--fix', 'Auto-apply safe patch/minor updates')
  .option('--audit-only', 'Only check for security vulnerabilities')
  .action(async (opts: { dir: string; fix?: boolean; auditOnly?: boolean }) => {
    await runQUORUM('deps', undefined, {
      dir: opts.dir,
      extra: {
        auto_fix: String(!!opts.fix),
        audit_only: String(!!opts.auditOnly)
      }
    })
  })

// ── quorum changelog ────────────────────────────────────────────────────────────
program
  .command('changelog [since]')
  .description('Generate CHANGELOG.md from git history and .quorum/actions.json')
  .option('-d, --dir <directory>', 'Project directory', process.cwd())
  .option('--from <tag>', 'Start from this git tag (default: last tag)')
  .option('--output <path>', 'Output path (default: CHANGELOG.md)')
  .action(async (since: string | undefined, opts: { dir: string; from?: string; output?: string }) => {
    await runQUORUM('changelog', since, {
      dir: opts.dir,
      extra: {
        from_tag: opts.from ?? '',
        output: opts.output ?? 'CHANGELOG.md'
      }
    })
  })

// ── quorum help ────────────────────────────────────────────────────────────────
program
  .command('help')
  .description('Show all commands with descriptions')
  .action(() => {
    printBanner()
    console.log(chalk.bold('\nCOMMANDS\n'))
    const commands = [
      ['init', 'Initialize QUORUM in this project'],
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
      ['note <text>', 'Quick note to .quorum/NOTES.md'],
      ['agents', 'List all agents and their model assignments'],
      ['profile <fast|balanced|quality>', 'Switch model quality tier'],
      ['key add/list/remove', 'Manage API keys and auto-discover models'],
      ['status', 'Current state, routing, costs'],
      ['rollback [point]', 'Return to previous rollback point'],
      ['sync', 'Re-index project after manual changes'],
      ['watch [--tool] [--keyword]', 'Monitor PM tool for [QUORUM] tickets → auto-plan'],
      ['cost-plan', 'Stack selection by budget — right tech for your constraints'],
      ['scale-plan [--users] [--rps]', 'Scaling analysis — K8s threshold, cost tiers, DB path'],
      ['env [check|generate|sync]', 'Manage .env files, detect secrets, generate .env.example'],
      ['security [--fix]', 'OWASP scan, npm audit, secrets check, .gitignore validation'],
      ['monitor [--sentry] [--log]', 'Read error logs → create .quorum/bugs/ tasks'],
      ['deps [--fix]', 'Outdated packages, CVEs, license issues, unused deps'],
      ['changelog [--from <tag>]', 'Generate CHANGELOG.md from git history'],
    ]
    commands.forEach(([cmd, desc]) => {
      console.log(`  ${chalk.cyan(('quorum ' + cmd!).padEnd(38))} ${chalk.white(desc!)}`)
    })
    console.log(chalk.dim('\n  quorum <command> --help for command-specific options\n'))
  })

// ── Runner ────────────────────────────────────────────────────────────────────
async function runQUORUM(
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
    const cfgPath = opts.config ?? path.join(projectDir, 'quorum.config.json')
    const hasCfgKey = existsSync(cfgPath)
    if (!hasEnvKey && !hasCfgKey) {
      console.error(chalk.red('\n  ✗ No API keys detected.\n'))
      console.error(chalk.yellow('  Add a key:'))
      console.error(chalk.white('    quorum key add GOOGLE_AI_API_KEY=your-key  (free tier)'))
      console.error(chalk.white('    quorum key add GROQ_API_KEY=your-key        (free)'))
      console.error(chalk.gray('    https://aistudio.google.com  (Google AI Studio)\n'))
      process.exit(1)
    }
  }

  const engine = new QUORUMEngine({
    projectDir,
    configPath: opts.config
  })

  try {
    await engine.run({
      command: command as QUORUMRunOptions['command'],
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
        } else if (message.startsWith('QUORUM') || message.startsWith('\nATLAS')) {
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
    console.log(chalk.bold.green('\n  ✓ QUORUM complete.\n'))

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
  ║  QUORUM — Autonomous Development Framework ║
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
