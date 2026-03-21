#!/usr/bin/env node
import { program } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import inquirer from 'inquirer'
import { ATLASEngine } from '@atlas/core'
import type { Checkpoint } from '@atlas/core'
import { readFileSync, existsSync } from 'fs'
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
