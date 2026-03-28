import { existsSync } from 'fs'
import path from 'path'
import type { QUORUMRunOptions } from '../types.js'
import { TaskManager } from '../memory/task-manager.js'
import { PlanManager } from '../memory/plan-manager.js'
import { GoalGuardian } from '../memory/goal-guardian.js'
import { NervousSystem } from '../memory/nervous-system.js'

export interface NextRecommendation {
  action: string
  command: string
  reason: string
  urgency: 'do_now' | 'suggested' | 'optional'
}

export async function runNext(
  projectDir: string,
  options: QUORUMRunOptions
): Promise<NextRecommendation> {
  const { onProgress } = options
  const quorumDir = path.join(projectDir, '.quorum')

  onProgress?.('Analyzing project state...')

  if (!existsSync(path.join(quorumDir, 'nervous-system', 'decisions.json'))) {
    const rec: NextRecommendation = {
      action: 'Initialize QUORUM',
      command: 'quorum init',
      reason: 'No .quorum/ folder found — project not initialized',
      urgency: 'do_now'
    }
    printRecommendation(rec, onProgress)
    return rec
  }

  if (!existsSync(path.join(quorumDir, 'goal.md'))) {
    const rec: NextRecommendation = {
      action: 'Define project goal',
      command: 'quorum init',
      reason: 'No goal.md found — AI has no scope anchor and may go off-track',
      urgency: 'do_now'
    }
    printRecommendation(rec, onProgress)
    return rec
  }

  const taskManager = new TaskManager(projectDir)
  const planManager = new PlanManager(projectDir)
  const nervousSystem = new NervousSystem(projectDir)

  const [taskIndex, planIndex, openQuestions] = await Promise.all([
    taskManager.readIndex(),
    planManager.readIndex(),
    nervousSystem.readOpenQuestions()
  ])

  const blocked = taskIndex.tasks.filter(t => t.status === 'BLOCKED')
  if (blocked.length > 0) {
    const rec: NextRecommendation = {
      action: `Unblock ${blocked.length} task(s)`,
      command: `quorum tasks list --status blocked`,
      reason: `${blocked[0]?.title} and ${blocked.length - 1} others are blocked`,
      urgency: 'do_now'
    }
    printRecommendation(rec, onProgress)
    return rec
  }

  const handoffPath = path.join(quorumDir, 'HANDOFF.md')
  if (existsSync(handoffPath)) {
    const rec: NextRecommendation = {
      action: 'Resume paused session',
      command: 'quorum resume',
      reason: 'Found a paused session — pick up where you left off',
      urgency: 'do_now'
    }
    printRecommendation(rec, onProgress)
    return rec
  }

  const inProgress = taskIndex.tasks.filter(t => t.status === 'IN_PROGRESS')
  if (inProgress.length > 0) {
    const task = inProgress[0]!
    const rec: NextRecommendation = {
      action: `Continue: ${task.title}`,
      command: `quorum enhance "continue ${task.title}"`,
      reason: `${task.id} is in progress — finish it before starting new work`,
      urgency: 'do_now'
    }
    printRecommendation(rec, onProgress)
    return rec
  }

  const currentPhase = planIndex.phases.find(p => p.id === planIndex.current_phase)
  if (currentPhase && currentPhase.tasks_complete < currentPhase.task_count) {
    const todoTasks = taskIndex.tasks.filter(
      t => t.status === 'TODO' && t.phase === planIndex.current_phase
    )
    if (todoTasks.length > 0) {
      const rec: NextRecommendation = {
        action: `Build next task: ${todoTasks[0]!.title}`,
        command: `quorum new "${todoTasks[0]!.title}"`,
        reason: `Phase "${currentPhase.name}" has ${todoTasks.length} tasks remaining`,
        urgency: 'do_now'
      }
      printRecommendation(rec, onProgress)
      return rec
    }

    const rec: NextRecommendation = {
      action: `Verify phase "${currentPhase.name}"`,
      command: 'quorum verify',
      reason: `All tasks in "${currentPhase.name}" appear complete — run UAT verification`,
      urgency: 'suggested'
    }
    printRecommendation(rec, onProgress)
    return rec
  }

  const allComplete = planIndex.phases.every(p => p.status === 'COMPLETE')
  if (allComplete && planIndex.phases.length > 0) {
    const rec: NextRecommendation = {
      action: 'Ship — create pull request',
      command: 'quorum ship',
      reason: 'All planned phases complete — ready to create PR',
      urgency: 'suggested'
    }
    printRecommendation(rec, onProgress)
    return rec
  }

  if (planIndex.phases.length === 0) {
    const rec: NextRecommendation = {
      action: 'Start building',
      command: 'quorum new "describe what you want to build"',
      reason: 'No implementation plan yet — start with a new feature',
      urgency: 'suggested'
    }
    printRecommendation(rec, onProgress)
    return rec
  }

  const openQ = openQuestions.filter(q => q.status === 'open' && q.blocking)
  if (openQ.length > 0) {
    const rec: NextRecommendation = {
      action: 'Resolve blocking questions',
      command: 'quorum status --decisions',
      reason: `${openQ.length} blocking question(s) need resolution`,
      urgency: 'suggested'
    }
    printRecommendation(rec, onProgress)
    return rec
  }

  const rec: NextRecommendation = {
    action: 'Check project status',
    command: 'quorum status',
    reason: 'Project state unclear — review status for next steps',
    urgency: 'optional'
  }
  printRecommendation(rec, onProgress)
  return rec
}

function printRecommendation(
  rec: NextRecommendation,
  onProgress?: (msg: string) => void
): void {
  const urgencyIcon = rec.urgency === 'do_now' ? '→'
    : rec.urgency === 'suggested' ? '○'
    : '·'

  onProgress?.('')
  onProgress?.(`QUORUM NEXT`)
  onProgress?.(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  onProgress?.(`${urgencyIcon} ${rec.action}`)
  onProgress?.(`  Why: ${rec.reason}`)
  onProgress?.(`  Run: ${rec.command}`)
  onProgress?.(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
}
