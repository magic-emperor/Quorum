import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import type { DoctorReport, DoctorCheck, ATLASRunOptions } from '../types.js'

const execAsync = promisify(exec)

export async function runDoctor(
  projectDir: string,
  options: ATLASRunOptions
): Promise<DoctorReport> {
  const { onProgress } = options
  const repair = options.extra?.repair === 'true'

  onProgress?.('Running ATLAS health check...')
  onProgress?.('')

  const checks: DoctorCheck[] = []
  const repaired: string[] = []
  const requiresManual: string[] = []

  // ─── Check 1: API Keys (dynamic — any provider key counts) ───────────────────

  const knownProviders = [
    { env: 'ANTHROPIC_API_KEY', name: 'Anthropic (Claude)' },
    { env: 'GOOGLE_AI_API_KEY', name: 'Google AI (Gemini)' },
    { env: 'OPENAI_API_KEY', name: 'OpenAI (GPT)' },
    { env: 'GROQ_API_KEY', name: 'Groq (fast, free)' },
    { env: 'DEEPSEEK_API_KEY', name: 'DeepSeek' },
  ]

  const activeKeys = knownProviders.filter(p => process.env[p.env])
  if (activeKeys.length > 0) {
    checks.push({
      name: 'API keys',
      status: 'pass',
      message: `Active: ${activeKeys.map(p => p.name).join(', ')}`
    })
  } else {
    checks.push({
      name: 'API keys',
      status: 'fail',
      message: 'No API keys found — at least one provider key is required',
      action: 'Run: atlas key add GOOGLE_AI_API_KEY=your-key  (free tier available)\n    Or: atlas key add GROQ_API_KEY=your-key  (completely free at console.groq.com)'
    })
    requiresManual.push('Add at least one API key via atlas key add')
  }

  // ─── Check 2: Playwright ────────────────────────────────────────────────────

  try {
    await execAsync('npx playwright --version', { timeout: 5000 })
    checks.push({ name: 'Playwright', status: 'pass', message: 'Playwright installed — E2E testing enabled' })
  } catch {
    checks.push({
      name: 'Playwright',
      status: 'warn',
      message: 'Playwright not found — E2E browser testing disabled',
      fix: 'npm install playwright && npx playwright install chromium'
    })

    if (repair) {
      onProgress?.('  Installing Playwright...')
      try {
        await execAsync('npm install playwright && npx playwright install chromium', {
          cwd: projectDir,
          timeout: 120000
        })
        repaired.push('Playwright installed')
        checks[checks.length - 1]!.status = 'pass'
        checks[checks.length - 1]!.message = 'Playwright installed (just now)'
      } catch {
        onProgress?.('  Playwright install failed — run manually')
      }
    }
  }

  // ─── Check 3: Node version ──────────────────────────────────────────────────

  try {
    const { stdout } = await execAsync('node --version')
    const version = stdout.trim()
    const major = parseInt(version.replace('v', '').split('.')[0]!, 10)

    if (major >= 18) {
      checks.push({ name: 'Node.js version', status: 'pass', message: `${version} — compatible` })
    } else {
      checks.push({
        name: 'Node.js version',
        status: 'fail',
        message: `${version} — Node 18+ required`,
        action: 'Upgrade Node.js to v18 or higher'
      })
      requiresManual.push('Upgrade Node.js to v18+')
    }
  } catch {
    checks.push({ name: 'Node.js version', status: 'fail', message: 'Node.js not found', action: 'Install Node.js from nodejs.org' })
  }

  // ─── Check 4: .atlas/ folder ────────────────────────────────────────────────

  const atlasDir = path.join(projectDir, '.atlas')

  if (!existsSync(atlasDir)) {
    checks.push({
      name: '.atlas/ folder',
      status: 'warn',
      message: '.atlas/ not found in this project — run atlas init to create it',
    })
  } else {
    checks.push({ name: '.atlas/ folder', status: 'pass', message: '.atlas/ exists' })

    // ─── Check 5: task-index.json integrity ───────────────────────────────────

    const taskIndexPath = path.join(atlasDir, 'task-index.json')
    const taskMdPath = path.join(atlasDir, 'task.md')

    if (existsSync(taskIndexPath) && existsSync(taskMdPath)) {
      try {
        const indexRaw = await readFile(taskIndexPath, 'utf-8')
        const index = JSON.parse(indexRaw)
        const taskMd = await readFile(taskMdPath, 'utf-8')
        const mdCount = (taskMd.match(/^- \[[ x]\] TASK-/gm) ?? []).length
        const indexCount = index.total ?? 0

        if (Math.abs(mdCount - indexCount) <= 1) {
          checks.push({ name: 'task-index.json sync', status: 'pass', message: `${indexCount} tasks indexed, ${mdCount} in task.md — in sync` })
        } else {
          checks.push({
            name: 'task-index.json sync',
            status: 'warn',
            message: `Mismatch: ${mdCount} tasks in task.md but ${indexCount} in index`,
            fix: 'atlas sync --tasks to rebuild task index'
          })

          if (repair) {
            onProgress?.('  Rebuilding task index...')
            index.total = mdCount
            await writeFile(taskIndexPath, JSON.stringify(index, null, 2), 'utf-8')
            repaired.push('task-index.json count corrected')
            checks[checks.length - 1]!.status = 'pass'
            checks[checks.length - 1]!.message = 'task-index.json repaired'
          }
        }
      } catch {
        checks.push({
          name: 'task-index.json sync',
          status: 'fail',
          message: 'task-index.json is corrupted or invalid JSON',
          fix: 'atlas sync to rebuild from scratch'
        })
        if (repair) {
          const emptyIndex = {
            total: 0, last_updated: '', last_updated_date: '',
            summary: { complete: 0, in_progress: 0, blocked: 0, todo: 0, rolled_back: 0 },
            tasks: [], keywords_index: {}, files_index: {}, next_task_number: 1
          }
          await writeFile(taskIndexPath, JSON.stringify(emptyIndex, null, 2), 'utf-8')
          repaired.push('task-index.json rebuilt (empty — run atlas sync to repopulate)')
        }
      }
    } else {
      checks.push({ name: 'task-index.json sync', status: 'skip', message: 'No task files yet — will be created on first use' })
    }

    // ─── Check 6: goal.md ────────────────────────────────────────────────────

    if (existsSync(path.join(atlasDir, 'goal.md'))) {
      checks.push({ name: 'goal.md', status: 'pass', message: 'Project goal defined — scope enforcement active' })
    } else {
      checks.push({
        name: 'goal.md',
        status: 'warn',
        message: 'No goal.md — AI has no scope anchor',
        action: 'Run atlas init or create .atlas/goal.md manually'
      })
    }

    // ─── Check 7: decisions.json readable ────────────────────────────────────

    const decisionsPath = path.join(atlasDir, 'nervous-system', 'decisions.json')
    if (existsSync(decisionsPath)) {
      try {
        const raw = await readFile(decisionsPath, 'utf-8')
        const parsed = JSON.parse(raw)
        const count = Array.isArray(parsed) ? parsed.length : 0
        checks.push({ name: 'decisions.json', status: 'pass', message: `${count} decisions stored and readable` })
      } catch {
        checks.push({
          name: 'decisions.json',
          status: 'fail',
          message: 'decisions.json corrupted',
          fix: 'Delete and let atlas recreate it'
        })
        if (repair) {
          await writeFile(decisionsPath, '[]', 'utf-8')
          repaired.push('decisions.json reset to empty array')
        }
      }
    }

    // ─── Check 8: function-registry.json readable ─────────────────────────────

    const registryPath = path.join(atlasDir, 'nervous-system', 'function-registry.json')
    if (existsSync(registryPath)) {
      try {
        const raw = await readFile(registryPath, 'utf-8')
        const parsed = JSON.parse(raw)
        const count = Array.isArray(parsed) ? parsed.length : 0
        checks.push({ name: 'function-registry.json', status: 'pass', message: `${count} functions tracked` })
      } catch {
        checks.push({
          name: 'function-registry.json',
          status: 'warn',
          message: 'function-registry.json unreadable — run atlas sync to rebuild',
        })
        if (repair) {
          await writeFile(registryPath, '[]', 'utf-8')
          repaired.push('function-registry.json reset')
        }
      }
    }
  }

  // ─── Check 9: atlas.config.json ──────────────────────────────────────────────

  const configPath = path.join(projectDir, 'atlas.config.json')
  if (existsSync(configPath)) {
    try {
      const raw = await readFile(configPath, 'utf-8')
      JSON.parse(raw)
      checks.push({ name: 'atlas.config.json', status: 'pass', message: 'Config file found and valid JSON' })
    } catch {
      checks.push({
        name: 'atlas.config.json',
        status: 'fail',
        message: 'atlas.config.json is invalid JSON — fix syntax errors',
      })
      requiresManual.push('Fix JSON syntax in atlas.config.json')
    }
  } else {
    checks.push({
      name: 'atlas.config.json',
      status: 'warn',
      message: 'No atlas.config.json — using defaults. Run atlas key add to configure.',
    })
  }

  // ─── Check 10: Local Ollama (optional) ───────────────────────────────────────

  const ollamaEndpoint = process.env['LOCAL_OLLAMA_ENDPOINT'] ?? 'http://localhost:11434'
  try {
    const res = await fetch(`${ollamaEndpoint}/api/tags`, { signal: AbortSignal.timeout(2000) })
    if (res.ok) {
      checks.push({ name: 'Ollama (local)', status: 'pass', message: `Ollama running at ${ollamaEndpoint}` })
    } else {
      checks.push({ name: 'Ollama (local)', status: 'skip', message: 'Ollama not running (optional)' })
    }
  } catch {
    checks.push({ name: 'Ollama (local)', status: 'skip', message: 'Ollama not running (optional)' })
  }

  // ─── Summary ────────────────────────────────────────────────────────────────

  const failures = checks.filter(c => c.status === 'fail').length
  const warnings = checks.filter(c => c.status === 'warn').length
  const overall = failures > 0 ? 'broken' : warnings > 2 ? 'degraded' : 'healthy'
  const report: DoctorReport = { overall, checks, repaired, requires_manual_fix: requiresManual }

  onProgress?.('ATLAS DOCTOR REPORT')
  onProgress?.('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  for (const check of checks) {
    const icon = check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : check.status === 'warn' ? '⚠' : '·'
    onProgress?.(`  ${icon} ${check.name}: ${check.message}`)
    if (check.action) onProgress?.(`    → ${check.action}`)
    if (check.fix && !repair) onProgress?.(`    → Fix: ${check.fix}`)
  }

  onProgress?.('')
  if (repaired.length > 0) {
    onProgress?.('Auto-repaired:')
    repaired.forEach(r => onProgress?.(`  ✓ ${r}`))
    onProgress?.('')
  }
  if (requiresManual.length > 0) {
    onProgress?.('Requires manual action:')
    requiresManual.forEach(r => onProgress?.(`  ! ${r}`))
    onProgress?.('')
  }

  const statusIcon = overall === 'healthy' ? '✓' : overall === 'degraded' ? '⚠' : '✗'
  onProgress?.(`${statusIcon} Overall: ${overall.toUpperCase()}`)
  onProgress?.('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  if (failures > 0 && !repair) {
    onProgress?.('Run atlas doctor --repair to auto-fix repairable issues.')
  }

  return report
}
