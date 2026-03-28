import { writeFile, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import type { GoalGuardian } from './goal-guardian.js'
import type { TaskManager } from './task-manager.js'
import type { PlanManager } from './plan-manager.js'
import type { NervousSystem } from './nervous-system.js'

export class SessionBriefManager {
  private briefPath: string

  constructor(
    private projectDir: string,
    private goalGuardian: GoalGuardian,
    private taskManager: TaskManager,
    private planManager: PlanManager,
    private nervousSystem: NervousSystem
  ) {
    this.briefPath = path.join(projectDir, '.quorum', 'context', 'session-brief.md')
  }

  // ─── Generate and save brief at session start ─────────────────────────────────
  // This is the ~500-token document every agent reads first.
  // Built from indexes only — does NOT read full files.

  async generate(sessionId: string, providers: string[]): Promise<string> {
    const [goalSummary, taskSummary, planSummary, openQCount] = await Promise.all([
      this.goalGuardian.getContextSummary(),
      this.taskManager.getContextSummary(),
      this.planManager.getContextSummary(),
      this.getOpenQuestionCount()
    ])

    const brief = `# Session Brief
Session: ${sessionId}
Generated: ${new Date().toISOString()}
Providers active: ${providers.join(', ')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GOAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${goalSummary}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PLAN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${planSummary}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TASKS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${taskSummary}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Open questions: ${openQCount}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

AGENT INSTRUCTIONS:
- Read this brief before any other context
- Do not read full task.md or implementation-plan.md unless working on a specific task
- Always check goal.md scope before proposing new work
- Load full task details only for tasks in your current working set
`

    // Ensure context dir exists
    const { mkdir } = await import('fs/promises')
    await mkdir(path.dirname(this.briefPath), { recursive: true })
    await writeFile(this.briefPath, brief, 'utf-8')
    return brief
  }

  async read(): Promise<string> {
    if (!existsSync(this.briefPath)) return ''
    return readFile(this.briefPath, 'utf-8')
  }

  private async getOpenQuestionCount(): Promise<number> {
    try {
      const questions = await this.nervousSystem.readOpenQuestions()
      return questions.filter((q: { status: string }) => q.status === 'open').length
    } catch {
      return 0
    }
  }
}
