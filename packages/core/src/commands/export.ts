import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import type { QUORUMRunOptions } from '../types.js'

/**
 * quorum export — generates a single shareable markdown document
 * from all .quorum/ artifacts: task.md, plan, session brief, BUGS.md,
 * DEVGUIDE.md, and decisions.json.
 *
 * Useful for team handoffs, sprint documentation, and onboarding.
 */
export async function runExport(
  projectDir: string,
  options: QUORUMRunOptions
): Promise<void> {
  const { onProgress } = options
  const quorumDir = path.join(projectDir, '.quorum')
  const outputPath = options.extra?.['output'] ??
    path.join(quorumDir, `export-${new Date().toISOString().slice(0, 10)}.md`)

  onProgress?.('Compiling session export...')

  const sections: string[] = []

  // Header
  sections.push(`# QUORUM Session Export`)
  sections.push(`Generated: ${new Date().toISOString()}`)
  sections.push(`Project: ${path.basename(projectDir)}`)
  sections.push('')

  // Goal
  const goalPath = path.join(quorumDir, 'goal.md')
  if (existsSync(goalPath)) {
    const goal = await readFile(goalPath, 'utf-8')
    sections.push('---')
    sections.push('## Project Goal')
    sections.push(goal.trim())
    sections.push('')
  }

  // Implementation Plan
  const planPath = path.join(quorumDir, 'implementation-plan.md')
  if (existsSync(planPath)) {
    const plan = await readFile(planPath, 'utf-8')
    sections.push('---')
    sections.push('## Implementation Plan')
    sections.push(plan.trim())
    sections.push('')
    onProgress?.('  ✓ implementation-plan.md')
  }

  // Task summary
  const taskPath = path.join(quorumDir, 'task.md')
  if (existsSync(taskPath)) {
    const tasks = await readFile(taskPath, 'utf-8')
    sections.push('---')
    sections.push('## Task Log')
    sections.push(tasks.trim())
    sections.push('')
    onProgress?.('  ✓ task.md')
  }

  // Session brief (compressed context)
  const briefPath = path.join(quorumDir, 'session-brief.md')
  if (existsSync(briefPath)) {
    const brief = await readFile(briefPath, 'utf-8')
    sections.push('---')
    sections.push('## Session Summary')
    sections.push(brief.trim())
    sections.push('')
    onProgress?.('  ✓ session-brief.md')
  }

  // Dev guide (onboarding docs from quorum map)
  const devguidePath = path.join(quorumDir, 'DEVGUIDE.md')
  if (existsSync(devguidePath)) {
    const devguide = await readFile(devguidePath, 'utf-8')
    sections.push('---')
    sections.push('## Architecture & Developer Guide')
    sections.push(devguide.trim())
    sections.push('')
    onProgress?.('  ✓ DEVGUIDE.md')
  }

  // Bug log
  const bugsPath = path.join(quorumDir, 'BUGS.md')
  if (existsSync(bugsPath)) {
    const bugs = await readFile(bugsPath, 'utf-8')
    sections.push('---')
    sections.push('## Bug Registry')
    sections.push(bugs.trim())
    sections.push('')
    onProgress?.('  ✓ BUGS.md')
  }

  // Key architectural decisions (from nervous system)
  const decisionsPath = path.join(quorumDir, 'nervous-system', 'decisions.json')
  if (existsSync(decisionsPath)) {
    try {
      const raw = await readFile(decisionsPath, 'utf-8')
      const decisions = JSON.parse(raw) as Array<{
        what: string; why: string; when: string; agent?: string
      }>
      if (decisions.length > 0) {
        sections.push('---')
        sections.push('## Architectural Decisions')
        for (const d of decisions) {
          sections.push(`### ${d.what}`)
          sections.push(`**Why:** ${d.why}`)
          sections.push(`**When:** ${d.when}${d.agent ? ` (by ${d.agent})` : ''}`)
          sections.push('')
        }
        onProgress?.(`  ✓ decisions.json (${decisions.length} decisions)`)
      }
    } catch {
      // skip malformed decisions
    }
  }

  // Open questions
  const questionsPath = path.join(quorumDir, 'nervous-system', 'open-questions.json')
  if (existsSync(questionsPath)) {
    try {
      const raw = await readFile(questionsPath, 'utf-8')
      const questions = JSON.parse(raw) as Array<{ question: string; status: string }>
      const open = questions.filter(q => q.status !== 'resolved')
      if (open.length > 0) {
        sections.push('---')
        sections.push('## Open Questions')
        for (const q of open) {
          sections.push(`- ${q.question}`)
        }
        sections.push('')
        onProgress?.(`  ✓ open-questions.json (${open.length} unresolved)`)
      }
    } catch {
      // skip
    }
  }

  const content = sections.join('\n')
  await writeFile(outputPath as string, content, 'utf-8')

  onProgress?.('')
  onProgress?.(`✓ Export complete: ${outputPath}`)
  onProgress?.(`  ${Math.round(content.length / 1024)}KB — share with your team or commit to docs/`)
}
