import { writeFile, readFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import type { ATLASRunOptions, HandoffState } from '../types.js'
import { TaskManager } from '../memory/task-manager.js'

export async function runPause(
  projectDir: string,
  options: ATLASRunOptions,
  currentState?: Partial<HandoffState>
): Promise<void> {
  const { onProgress } = options

  const handoffPath = path.join(projectDir, '.atlas', 'HANDOFF.md')
  const handoffJsonPath = path.join(projectDir, '.atlas', 'HANDOFF.json')
  const sessionId = `session_${Date.now()}`

  const taskManager = new TaskManager(projectDir)
  const index = await taskManager.readIndex()
  const inProgress = index.tasks.filter(t => t.status === 'IN_PROGRESS')

  const handoff: HandoffState = {
    session_id: currentState?.session_id ?? sessionId,
    paused_at: new Date().toISOString(),
    command: currentState?.command ?? 'unknown',
    description: currentState?.description ?? options.description ?? '',
    current_phase: currentState?.current_phase ?? 'unknown',
    current_step: currentState?.current_step ?? 'unknown',
    completed_steps: currentState?.completed_steps ?? [],
    remaining_steps: currentState?.remaining_steps ?? [],
    context_snapshot: JSON.stringify({
      in_progress_tasks: inProgress.map(t => t.id),
      task_summary: await taskManager.getContextSummary()
    }),
    resume_instruction: `Run: atlas resume\nThis will load the paused state and continue from: ${currentState?.current_step ?? 'last known step'}`
  }

  await writeFile(handoffJsonPath, JSON.stringify(handoff, null, 2), 'utf-8')

  const md = `# ATLAS Paused Session
Session: ${handoff.session_id}
Paused: ${handoff.paused_at}

## What Was Happening
Command: ${handoff.command}
Task: ${handoff.description}
Phase: ${handoff.current_phase}
Step: ${handoff.current_step}

## Completed This Session
${handoff.completed_steps.map(s => `- [x] ${s}`).join('\n') || '(none)'}

## Remaining Steps
${handoff.remaining_steps.map(s => `- [ ] ${s}`).join('\n') || '(none recorded)'}

## In-Progress Tasks
${inProgress.map(t => `- ${t.id}: ${t.title}`).join('\n') || '(none)'}

## To Resume
\`\`\`
atlas resume
\`\`\`

---
_State saved automatically. Safe to close terminal._
`

  await writeFile(handoffPath, md, 'utf-8')

  onProgress?.('')
  onProgress?.('Session paused cleanly.')
  onProgress?.(`State saved to .atlas/HANDOFF.md`)
  onProgress?.('To resume: atlas resume')
}

export async function runResume(
  projectDir: string,
  options: ATLASRunOptions
): Promise<{ shouldRun: true; handoff: HandoffState } | { shouldRun: false }> {
  const { onProgress, onCheckpoint } = options

  const handoffJsonPath = path.join(projectDir, '.atlas', 'HANDOFF.json')
  const handoffMdPath = path.join(projectDir, '.atlas', 'HANDOFF.md')

  if (!existsSync(handoffJsonPath)) {
    onProgress?.('No paused session found.')
    onProgress?.('Use atlas next to see what to do.')
    return { shouldRun: false }
  }

  const raw = await readFile(handoffJsonPath, 'utf-8')
  const handoff = JSON.parse(raw) as HandoffState

  onProgress?.('')
  onProgress?.('Found paused session:')
  onProgress?.(`  Command: ${handoff.command}`)
  onProgress?.(`  Task: ${handoff.description}`)
  onProgress?.(`  Paused at: ${handoff.paused_at}`)
  onProgress?.(`  Last step: ${handoff.current_step}`)
  onProgress?.('')

  if (handoff.remaining_steps.length > 0) {
    onProgress?.('Remaining steps:')
    handoff.remaining_steps.forEach(s => onProgress?.(`  - ${s}`))
  }

  if (!options.auto && onCheckpoint) {
    const response = await onCheckpoint({
      type: 'BLOCKER',
      title: 'Resume Paused Session',
      completed: handoff.completed_steps,
      question: 'Resume this paused session?',
      options: [
        { label: 'RESUME', tradeoff: 'Continue from where you left off' },
        { label: 'DISCARD', tradeoff: 'Clear the paused state and start fresh' }
      ]
    })

    if (response.toUpperCase().includes('DISCARD')) {
      await unlink(handoffJsonPath)
      if (existsSync(handoffMdPath)) await unlink(handoffMdPath)
      onProgress?.('Paused session discarded.')
      return { shouldRun: false }
    }
  }

  await unlink(handoffJsonPath)
  if (existsSync(handoffMdPath)) await unlink(handoffMdPath)

  onProgress?.('Resuming session...')
  return { shouldRun: true, handoff }
}
