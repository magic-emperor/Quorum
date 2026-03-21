import { writeFile, mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import type { ATLASRunOptions, ProjectGoal } from '../types.js'
import { NervousSystem } from '../memory/nervous-system.js'
import { TaskManager } from '../memory/task-manager.js'
import { PlanManager } from '../memory/plan-manager.js'
import { GoalGuardian } from '../memory/goal-guardian.js'

export async function runInit(
  projectDir: string,
  options: ATLASRunOptions
): Promise<void> {
  const { onProgress, onCheckpoint, auto } = options

  onProgress?.('Initializing ATLAS project memory...')

  const atlasDir = path.join(projectDir, '.atlas')
  if (existsSync(path.join(atlasDir, 'nervous-system', 'decisions.json'))) {
    onProgress?.('.atlas/ already exists in this project.')
    onProgress?.('To re-initialize: delete .atlas/ first.')
    onProgress?.('To update: use atlas sync')
    return
  }

  const nervousSystem = new NervousSystem(projectDir)
  const taskManager = new TaskManager(projectDir)
  const planManager = new PlanManager(projectDir)
  const goalGuardian = new GoalGuardian(projectDir)

  await nervousSystem.initialize()
  await taskManager.initialize()
  await planManager.initialize()

  onProgress?.('.atlas/ folder structure created.')

  let goalText = options.description ?? ''

  if (!goalText && !auto && onCheckpoint) {
    const checkpoint = {
      type: 'BLOCKER' as const,
      title: 'Define Your Project Goal',
      completed: ['.atlas/ folder created', 'Memory systems initialized'],
      question: 'What are you building? Describe it in 2-3 sentences. This becomes goal.md — the anchor that prevents AI from going off-track.',
      options: [
        { label: 'Type your description', tradeoff: 'Creates goal.md immediately' },
        { label: 'Skip for now', tradeoff: 'You can create goal.md manually later' }
      ]
    }
    goalText = await onCheckpoint(checkpoint)
  }

  if (goalText && goalText.toLowerCase() !== 'skip') {
    const goal: ProjectGoal = {
      what: goalText,
      why: 'Defined at project initialization',
      success_criteria: [
        'Core functionality works end-to-end',
        'All user-facing flows tested',
        'Deployed and accessible'
      ],
      out_of_scope: [],
      constraints: {},
      milestones: [
        { name: 'MVP', description: 'Minimum working version' },
        { name: 'v1.0', description: 'Production-ready release' }
      ],
      created_date: new Date().toISOString().split('T')[0]!,
      last_updated_date: new Date().toISOString().split('T')[0]!,
      version: 1
    }

    await goalGuardian.create(goal)
    onProgress?.('goal.md created — edit it to add success criteria and out-of-scope items.')
  }

  await detectAndSeedStack(projectDir, nervousSystem, onProgress)
  await ensureGitignore(projectDir, onProgress)

  onProgress?.('')
  onProgress?.('ATLAS initialized. Next steps:')
  onProgress?.('  1. Edit .atlas/goal.md — define what is and is NOT in scope')
  onProgress?.('  2. Run: atlas new "describe your first feature"')
  onProgress?.('  3. Or: atlas map — let agents understand your existing codebase first')
}

async function detectAndSeedStack(
  projectDir: string,
  nervousSystem: NervousSystem,
  onProgress?: (msg: string) => void
): Promise<void> {
  const pkgPath = path.join(projectDir, 'package.json')
  if (!existsSync(pkgPath)) return

  try {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    const stack: Record<string, string> = {}

    if (deps['next']) stack['frontend_framework'] = 'nextjs'
    else if (deps['vite']) stack['frontend_framework'] = 'vite'
    else if (deps['react']) stack['frontend_framework'] = 'react'
    else if (deps['vue']) stack['frontend_framework'] = 'vue'

    if (deps['express']) stack['backend_framework'] = 'express'
    else if (deps['fastify']) stack['backend_framework'] = 'fastify'
    else if (deps['hono']) stack['backend_framework'] = 'hono'

    if (deps['pg'] || deps['postgres']) stack['database'] = 'postgresql'
    else if (deps['mysql2']) stack['database'] = 'mysql'
    else if (deps['mongoose'] || deps['mongodb']) stack['database'] = 'mongodb'
    else if (deps['better-sqlite3']) stack['database'] = 'sqlite'

    if (deps['typescript']) stack['language'] = 'typescript'
    else stack['language'] = 'javascript'

    if (pkg.packageManager?.includes('pnpm')) stack['package_manager'] = 'pnpm'
    else if (pkg.packageManager?.includes('yarn')) stack['package_manager'] = 'yarn'
    else stack['package_manager'] = 'npm'

    if (Object.keys(stack).length > 0) {
      await nervousSystem.writeStack(stack as any)
      onProgress?.(`Tech stack detected: ${Object.entries(stack).map(([k, v]) => `${k}=${v}`).join(', ')}`)
    }
  } catch {
    // Non-fatal — stack will be set during foundation mode
  }
}

async function ensureGitignore(
  projectDir: string,
  onProgress?: (msg: string) => void
): Promise<void> {
  const gitignorePath = path.join(projectDir, '.gitignore')
  const atlasIgnoreLines = [
    '',
    '# ATLAS — do not commit screenshots (large files)',
    '.atlas/context/screenshots/',
    '.atlas/context/budget-log.json',
    '.atlas/rollback_points/',
  ]

  try {
    const existing = existsSync(gitignorePath)
      ? await readFile(gitignorePath, 'utf-8')
      : ''

    if (!existing.includes('.atlas/context/screenshots')) {
      await writeFile(gitignorePath, existing + atlasIgnoreLines.join('\n') + '\n', 'utf-8')
      onProgress?.('.gitignore updated — screenshots excluded from git.')
    }
  } catch {
    // Non-fatal
  }
}
