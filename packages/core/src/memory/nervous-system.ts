import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import type {
  Decision,
  Action,
  OpenQuestion,
  TechStack,
  Bug,
  FunctionEntry,
  ProjectMemory
} from '../types.js'

export class NervousSystem {
  private atlasDir: string
  private nsDir: string // nervous-system dir

  constructor(private projectDir: string) {
    this.atlasDir = path.join(projectDir, '.atlas')
    this.nsDir = path.join(this.atlasDir, 'nervous-system')
  }

  async initialize(): Promise<void> {
    const dirs = [
      this.atlasDir,
      this.nsDir,
      path.join(this.atlasDir, 'index'),
      path.join(this.atlasDir, 'context'),
      path.join(this.atlasDir, 'rollback_points'),
      path.join(this.atlasDir, 'context', 'sessions')
    ]
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true })
    }

    // Initialize empty JSON files
    const jsonFiles: Record<string, unknown> = {
      'decisions.json': [],
      'actions.json': [],
      'reasoning.json': [],
      'open-questions.json': [],
      'conflicts.json': [],
      'function-registry.json': [],
      'bug-registry.json': [],
      'env-registry.json': [],
      'cached-instincts.json': [],
      'test-coverage.json': {}
    }
    for (const [filename, defaultValue] of Object.entries(jsonFiles)) {
      const filePath = path.join(this.nsDir, filename)
      if (!existsSync(filePath)) {
        await writeFile(filePath, JSON.stringify(defaultValue, null, 2), 'utf-8')
      }
    }

    // Initialize plan.md
    const planPath = path.join(this.atlasDir, 'plan.md')
    if (!existsSync(planPath)) {
      await writeFile(planPath, this.initialPlanTemplate(), 'utf-8')
    }

    // Initialize history_plan.md
    const historyPath = path.join(this.atlasDir, 'history_plan.md')
    if (!existsSync(historyPath)) {
      await writeFile(historyPath, '# ATLAS Plan History\n\n', 'utf-8')
    }

    // Initialize BUGS.md
    const bugsPath = path.join(this.atlasDir, 'BUGS.md')
    if (!existsSync(bugsPath)) {
      await writeFile(bugsPath, '# BUGS\n\nMaintained by: atlas-testing\n\n', 'utf-8')
    }

    // Initialize DEVGUIDE.md
    const devguidePath = path.join(this.atlasDir, 'DEVGUIDE.md')
    if (!existsSync(devguidePath)) {
      await writeFile(devguidePath, '# Developer Guide\n\nMaintained by: atlas-nervous-system\n\n', 'utf-8')
    }
  }

  async exists(): Promise<boolean> {
    return existsSync(path.join(this.nsDir, 'decisions.json'))
  }

  // ── Decisions ───────────────────────────────────────────────────────────────

  async readDecisions(): Promise<Decision[]> {
    return this.readJson<Decision[]>('decisions.json', [])
  }

  async appendDecision(decision: Decision): Promise<void> {
    const list = await this.readDecisions()
    list.push(decision)
    await this.writeJson('decisions.json', list)
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  async readActions(): Promise<Action[]> {
    return this.readJson<Action[]>('actions.json', [])
  }

  async appendAction(action: Action): Promise<void> {
    const list = await this.readActions()
    list.push(action)
    await this.writeJson('actions.json', list)
  }

  // ── Open Questions ───────────────────────────────────────────────────────────

  async readOpenQuestions(): Promise<OpenQuestion[]> {
    return this.readJson<OpenQuestion[]>('open-questions.json', [])
  }

  async appendOpenQuestion(question: OpenQuestion): Promise<void> {
    const list = await this.readOpenQuestions()
    list.push(question)
    await this.writeJson('open-questions.json', list)
  }

  // ── Stack ────────────────────────────────────────────────────────────────────

  async readStack(): Promise<Partial<TechStack>> {
    const p = path.join(this.nsDir, 'stack.json')
    if (!existsSync(p)) return {}
    try {
      return JSON.parse(await readFile(p, 'utf-8')) as Partial<TechStack>
    } catch { return {} }
  }

  async writeStack(stack: Partial<TechStack>): Promise<void> {
    await writeFile(
      path.join(this.nsDir, 'stack.json'),
      JSON.stringify(stack, null, 2),
      'utf-8'
    )
  }

  // ── Function Registry ────────────────────────────────────────────────────────

  async readFunctionRegistry(): Promise<FunctionEntry[]> {
    return this.readJson<FunctionEntry[]>('function-registry.json', [])
  }

  async upsertFunction(entry: FunctionEntry): Promise<void> {
    const registry = await this.readFunctionRegistry()
    const idx = registry.findIndex(f => f.file === entry.file && f.name === entry.name)
    if (idx >= 0) {
      registry[idx] = { ...registry[idx], ...entry }
    } else {
      registry.push(entry)
    }
    await this.writeJson('function-registry.json', registry)
  }

  // ── Bug Registry ─────────────────────────────────────────────────────────────

  async readBugRegistry(): Promise<Bug[]> {
    return this.readJson<Bug[]>('bug-registry.json', [])
  }

  async appendBug(bug: Bug): Promise<void> {
    const list = await this.readBugRegistry()
    list.push(bug)
    await this.writeJson('bug-registry.json', list)
    await this.appendToBugsFile(bug)
  }

  // ── Plan ─────────────────────────────────────────────────────────────────────

  async readPlan(): Promise<string> {
    const p = path.join(this.atlasDir, 'plan.md')
    if (!existsSync(p)) return ''
    return readFile(p, 'utf-8')
  }

  async updatePlan(content: string): Promise<void> {
    await writeFile(path.join(this.atlasDir, 'plan.md'), content, 'utf-8')
  }

  // Archive current plan with a version stamp — ALWAYS APPENDS, never replaces
  async archivePlan(sessionId: string, reason: string, modelsUsed: string[]): Promise<void> {
    const current = await this.readPlan()
    const historyPath = path.join(this.atlasDir, 'history_plan.md')
    const existing = existsSync(historyPath)
      ? await readFile(historyPath, 'utf-8')
      : '# ATLAS Plan History\n\n'

    const versionCount = (existing.match(/## plan\.md v\d+/g) ?? []).length + 1
    const entry = `
---
## plan.md v${versionCount} | Session: ${sessionId} | ${new Date().toISOString()}
Models: ${modelsUsed.join(', ')}
Archived because: ${reason}

${current}
---
`
    await writeFile(historyPath, existing + entry, 'utf-8')
  }

  // ── Interrupt Queue ──────────────────────────────────────────────────────────

  async readInterruptQueue(): Promise<Array<{ id: string; content: string; status: string }>> {
    const p = path.join(this.atlasDir, 'interrupt-queue.json')
    if (!existsSync(p)) return []
    try {
      const raw = JSON.parse(await readFile(p, 'utf-8')) as {
        queue: Array<{ id: string; content: string; status: string }>
      }
      return raw.queue ?? []
    } catch { return [] }
  }

  async clearInterruptQueue(): Promise<void> {
    await writeFile(
      path.join(this.atlasDir, 'interrupt-queue.json'),
      JSON.stringify({ queue: [] }, null, 2),
      'utf-8'
    )
  }

  // ── Full Memory ──────────────────────────────────────────────────────────────

  async getFullMemory(): Promise<ProjectMemory> {
    const [decisions, actions, openQuestions, stack, bugs] = await Promise.all([
      this.readDecisions(),
      this.readActions(),
      this.readOpenQuestions(),
      this.readStack(),
      this.readBugRegistry()
    ])
    return { decisions, actions, openQuestions, stack: stack as TechStack, bugs }
  }

  // ── Private Helpers ──────────────────────────────────────────────────────────

  private async appendToBugsFile(bug: Bug): Promise<void> {
    const p = path.join(this.atlasDir, 'BUGS.md')
    const existing = existsSync(p) ? await readFile(p, 'utf-8') : '# BUGS\n\n'
    const entry = `
## ${bug.id}
**Found by:** ${bug.found_by} | **Severity:** ${bug.severity} | **Status:** ${bug.status}

**Description:** ${bug.description}

**Root Cause:** ${bug.root_cause}

**Fix Applied:** ${bug.fix_applied ?? 'Pending'}

---
`
    await writeFile(p, existing + entry, 'utf-8')
  }

  private async readJson<T>(filename: string, defaultValue: T): Promise<T> {
    const p = path.join(this.nsDir, filename)
    if (!existsSync(p)) return defaultValue
    try {
      return JSON.parse(await readFile(p, 'utf-8')) as T
    } catch { return defaultValue }
  }

  private async writeJson(filename: string, data: unknown): Promise<void> {
    await writeFile(path.join(this.nsDir, filename), JSON.stringify(data, null, 2), 'utf-8')
  }

  private initialPlanTemplate(): string {
    return `# ATLAS Execution Plan
Project: (pending)
Session: (new)
Last updated: ${new Date().toISOString()}
Phase: Phase 0 — Foundation
Status: IN_PROGRESS

## Active Task
Foundation Mode — seeding project memory

## Completed Steps
(none yet)

## Current Steps
- [ ] Classify project complexity
- [ ] Seed .atlas/ with stack and decisions

## Upcoming Steps
- [ ] Phase 1: Backend Architecture
- [ ] Phase 2: Frontend Design
- [ ] Phase 3: Build
- [ ] Phase 4: Integration
- [ ] Phase 5: Testing
- [ ] Phase 6: Scaling (optional)

## Human Checkpoints
- [ ] CHECKPOINT A — Architecture
- [ ] CHECKPOINT B — Design
- [ ] CHECKPOINT C — Testing

## Interrupt Queue Status
clear
`
  }
}
