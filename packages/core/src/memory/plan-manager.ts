import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import type { PlanVersion, PlanPhase, PlanIndex, PhaseStatus } from '../types.js'

export class PlanManager {
  private planFilePath: string
  private planIndexPath: string
  private cachedIndex: PlanIndex | null = null

  constructor(private projectDir: string) {
    this.planFilePath = path.join(projectDir, '.quorum', 'implementation-plan.md')
    this.planIndexPath = path.join(projectDir, '.quorum', 'plan-index.json')
  }

  // ─── Initialization ──────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    await mkdir(path.join(this.projectDir, '.quorum'), { recursive: true })

    if (!existsSync(this.planIndexPath)) {
      const emptyIndex: PlanIndex = {
        current_version: 0,
        last_updated: '',
        phases: [],
        current_phase: '',
        current_milestone: 'MVP'
      }
      await writeFile(this.planIndexPath, JSON.stringify(emptyIndex, null, 2), 'utf-8')
    }
  }

  exists(): boolean {
    return existsSync(this.planFilePath)
  }

  // ─── Read index (cheap — always use this first) ──────────────────────────────

  async readIndex(): Promise<PlanIndex> {
    if (this.cachedIndex) return this.cachedIndex
    if (!existsSync(this.planIndexPath)) await this.initialize()
    const raw = await readFile(this.planIndexPath, 'utf-8')
    this.cachedIndex = JSON.parse(raw) as PlanIndex
    return this.cachedIndex
  }

  async readCurrentPhase(): Promise<PlanIndex['phases'][0] | null> {
    const index = await this.readIndex()
    return index.phases.find(p => p.id === index.current_phase) ?? index.phases[0] ?? null
  }

  async readFullPlan(): Promise<string> {
    if (!this.exists()) return ''
    return readFile(this.planFilePath, 'utf-8')
  }

  // ─── Create initial plan ─────────────────────────────────────────────────────

  async createPlan(
    phases: Omit<PlanPhase, 'task_ids' | 'started_date' | 'completed_date'>[],
    sessionId: string,
    approvedByHuman: boolean
  ): Promise<PlanVersion> {
    await this.initialize()

    const plan: PlanVersion = {
      version: 1,
      created_date: new Date().toISOString().split('T')[0]!,
      created_in_session: sessionId,
      status: 'ACTIVE',
      approved_by_human: approvedByHuman,
      approved_date: approvedByHuman ? new Date().toISOString().split('T')[0]! : undefined,
      phases: phases.map(p => ({ ...p, task_ids: [] }))
    }

    await this.writePlanToFile(plan)
    await this.updateIndex(plan, sessionId)
    return plan
  }

  // ─── Add task to phase ───────────────────────────────────────────────────────

  async addTaskToPhase(phaseId: string, taskId: string, sessionId: string): Promise<void> {
    const index = await this.readIndex()
    const phase = index.phases.find(p => p.id === phaseId)
    if (!phase) return

    const content = await this.readFullPlan()
    const lines = content.split('\n')
    const phaseLineIdx = lines.findIndex(l =>
      l.startsWith('## Phase') && l.includes(phase.name)
    )

    if (phaseLineIdx !== -1) {
      let insertIdx = phaseLineIdx
      for (let i = phaseLineIdx + 1; i < lines.length; i++) {
        const line = lines[i]!
        if (line.startsWith('## Phase') || line.startsWith('## Change')) break
        if (line.startsWith('### Tasks Generated')) {
          insertIdx = i + 1
          while (insertIdx < lines.length && lines[insertIdx]!.startsWith('- TASK-')) {
            insertIdx++
          }
          break
        }
      }
      lines.splice(insertIdx, 0, `- ${taskId} — IN_PROGRESS`)
      await writeFile(this.planFilePath, lines.join('\n'), 'utf-8')
    }

    index.last_updated = sessionId
    await writeFile(this.planIndexPath, JSON.stringify(index, null, 2), 'utf-8')
    this.cachedIndex = null
  }

  // ─── Update phase status ──────────────────────────────────────────────────────

  async updatePhaseStatus(phaseId: string, newStatus: PhaseStatus, sessionId: string): Promise<void> {
    const index = await this.readIndex()
    const phase = index.phases.find(p => p.id === phaseId)
    if (!phase) return

    phase.status = newStatus
    if (newStatus === 'COMPLETE') {
      phase.summary = `Complete — ${phase.summary}`
      const currentIdx = index.phases.findIndex(p => p.id === phaseId)
      const nextPhase = index.phases[currentIdx + 1]
      if (nextPhase) index.current_phase = nextPhase.id
    }

    index.last_updated = sessionId
    await writeFile(this.planIndexPath, JSON.stringify(index, null, 2), 'utf-8')
    this.cachedIndex = null
    await this.appendChangeLog(`Phase "${phase.name}" status changed to ${newStatus}`, sessionId)
  }

  // ─── Append change log (never edit existing content) ────────────────────────

  async appendChangeLog(reason: string, sessionId: string, what?: string): Promise<void> {
    if (!this.exists()) return
    const content = await this.readFullPlan()
    const changeEntry = `
### Change — ${new Date().toISOString().split('T')[0]!} (session: ${sessionId})
Reason: ${reason}
${what ? `What changed: ${what}` : ''}
`
    if (content.includes('## Change Log')) {
      await writeFile(this.planFilePath, content + changeEntry, 'utf-8')
    } else {
      await writeFile(this.planFilePath, content + '\n## Change Log\n' + changeEntry, 'utf-8')
    }
  }

  // ─── Get compact context for agents ─────────────────────────────────────────

  async getContextSummary(): Promise<string> {
    const index = await this.readIndex()
    const currentPhase = await this.readCurrentPhase()

    if (index.phases.length === 0) {
      return 'No implementation plan yet. Run quorum new to create one.'
    }

    const phaseSummaries = index.phases
      .map(p => `  ${p.status === 'COMPLETE' ? '✓' : p.id === index.current_phase ? '→' : '○'} ${p.name}: ${p.summary}`)
      .join('\n')

    return `IMPLEMENTATION PLAN — Version ${index.current_version}
Current phase: ${currentPhase?.name ?? 'none'}
Current milestone: ${index.current_milestone}

Phases:
${phaseSummaries}`
  }

  // ─── Private: write plan to markdown ─────────────────────────────────────────

  private async writePlanToFile(plan: PlanVersion): Promise<void> {
    const lines: string[] = [
      '# Implementation Plan',
      '<!-- Created by quorum-lanner BEFORE any code is written.',
      '     Approved by human at planning checkpoint.',
      '     Tasks are generated FROM this plan.',
      '     APPEND ONLY. Never delete entries. -->',
      '',
      `## Plan Version`,
      `Version: ${plan.version}`,
      `Created: ${plan.created_date}`,
      `Session: ${plan.created_in_session}`,
      `Status: ${plan.status}`,
      `Approved by human: ${plan.approved_by_human ? `yes (${plan.approved_date ?? ''})` : 'pending'}`,
      ''
    ]

    for (const phase of plan.phases) {
      lines.push(
        `## Phase ${phase.number}: ${phase.name}`,
        `Status: ${phase.status}`,
        `Goal: ${phase.goal}`,
        `Milestone: ${phase.milestone}`,
        '',
        '### Approach',
        phase.approach,
        '',
        '### Key Decisions Pre-Made',
        ...phase.key_decisions.map(d => `- ${d.decision}: ${d.why}`),
        '',
        '### Success Criteria',
        ...phase.success_criteria.map(c => `- [ ] ${c}`),
        '',
        '### Tasks Generated',
        '<!-- Auto-populated as tasks are created -->',
        '',
        '---',
        ''
      )
    }

    lines.push('## Change Log', '')
    await writeFile(this.planFilePath, lines.join('\n'), 'utf-8')
  }

  private async updateIndex(plan: PlanVersion, sessionId: string): Promise<void> {
    const index: PlanIndex = {
      current_version: plan.version,
      last_updated: sessionId,
      current_phase: plan.phases[0]?.id ?? '',
      current_milestone: plan.phases[0]?.milestone ?? 'MVP',
      phases: plan.phases.map(p => ({
        id: p.id,
        name: p.name,
        status: p.status,
        task_count: 0,
        tasks_complete: 0,
        summary: p.goal,
        milestone: p.milestone
      }))
    }

    await writeFile(this.planIndexPath, JSON.stringify(index, null, 2), 'utf-8')
    this.cachedIndex = index
  }
}
