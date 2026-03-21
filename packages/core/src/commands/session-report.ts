import { writeFile } from 'fs/promises'
import path from 'path'
import type { ATLASRunOptions, SessionReport } from '../types.js'
import { NervousSystem } from '../memory/nervous-system.js'
import { TaskManager } from '../memory/task-manager.js'
import { PlanManager } from '../memory/plan-manager.js'
import { runNext } from './next.js'

export async function runSessionReport(
  projectDir: string,
  options: ATLASRunOptions
): Promise<SessionReport> {
  const { onProgress } = options

  const nervousSystem = new NervousSystem(projectDir)
  const taskManager = new TaskManager(projectDir)
  const planManager = new PlanManager(projectDir)

  const [actions, decisions, taskIndex, planIndex] = await Promise.all([
    nervousSystem.readActions(),
    nervousSystem.readDecisions(),
    taskManager.readIndex(),
    planManager.readIndex()
  ])

  const today = new Date().toISOString().split('T')[0]!
  const todayActions = actions.filter(a => a.timestamp.startsWith(today))
  const todayDecisions = decisions.filter(d => d.timestamp?.startsWith(today))

  const tasksCompleted = taskIndex.tasks
    .filter(t => t.status === 'COMPLETE' && t.session_completed)
    .slice(-10)

  const filesChanged = [...new Set(
    todayActions
      .filter(a => a.file_affected)
      .map(a => a.file_affected!)
  )]

  const agentsUsed = [...new Set(todayActions.map(a => a.agent))]
  const nextRec = await runNext(projectDir, { ...options, onProgress: undefined })
  const estimatedCost = `~$${(todayActions.length * 0.02).toFixed(2)}`
  const summary = `${tasksCompleted.length} tasks completed, ${todayDecisions.length} decisions made, ${filesChanged.length} files changed.`

  const report: SessionReport = {
    session_id: today,
    date: today,
    duration_minutes: 0,
    tasks_created: taskIndex.tasks
      .filter(t => t.session_completed === today || t.status === 'IN_PROGRESS')
      .map(t => t.id),
    tasks_completed: tasksCompleted.map(t => t.id),
    decisions_made: todayDecisions.length,
    files_changed: filesChanged,
    agents_used: agentsUsed,
    cost_estimate: estimatedCost,
    summary,
    next_recommended: nextRec.command
  }

  const reportPath = path.join(projectDir, '.atlas', 'context', 'session-report.md')
  const md = `# Session Report
Date: ${today}

## Summary
${summary}

## Tasks Completed
${tasksCompleted.map(t => `- [x] ${t.id}: ${t.title}`).join('\n') || '(none today)'}

## Decisions Made
${todayDecisions.map(d => `- ${d.what} — ${d.why}`).join('\n') || '(none today)'}

## Files Changed
${filesChanged.map(f => `- ${f}`).join('\n') || '(none tracked)'}

## Agents Used
${agentsUsed.join(', ') || '(none)'}

## Estimated Cost
${estimatedCost}

## Next Recommended Action
${nextRec.command} — ${nextRec.reason}
`
  await writeFile(reportPath, md, 'utf-8')

  onProgress?.('')
  onProgress?.('SESSION REPORT')
  onProgress?.('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  onProgress?.(`Date: ${today}`)
  onProgress?.(`Tasks completed: ${tasksCompleted.length}`)
  onProgress?.(`Decisions made: ${todayDecisions.length}`)
  onProgress?.(`Files changed: ${filesChanged.length}`)
  onProgress?.(`Est. cost: ${estimatedCost}`)
  onProgress?.(`Next: ${nextRec.command}`)
  onProgress?.('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  onProgress?.(`Full report: .atlas/context/session-report.md`)

  return report
}
