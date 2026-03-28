import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import type { ProjectGoal, ScopeCheckResult } from '../types.js'

export class GoalGuardian {
  private goalPath: string
  private cachedGoal: ProjectGoal | null = null

  constructor(private projectDir: string) {
    this.goalPath = path.join(projectDir, '.quorum', 'goal.md')
  }

  // ─── Existence ──────────────────────────────────────────────────────────────

  exists(): boolean {
    return existsSync(this.goalPath)
  }

  // ─── Read ───────────────────────────────────────────────────────────────────

  async read(): Promise<ProjectGoal | null> {
    if (this.cachedGoal) return this.cachedGoal
    if (!this.exists()) return null
    const raw = await readFile(this.goalPath, 'utf-8')
    this.cachedGoal = this.parseGoalMarkdown(raw)
    return this.cachedGoal
  }

  async readRaw(): Promise<string> {
    if (!this.exists()) return ''
    return readFile(this.goalPath, 'utf-8')
  }

  // ─── Create (only at init — AI never modifies after this) ───────────────────

  async create(goal: ProjectGoal): Promise<void> {
    const markdown = this.goalToMarkdown(goal)
    await writeFile(this.goalPath, markdown, 'utf-8')
    this.cachedGoal = goal
  }

  // ─── IMPORTANT: No update() method ──────────────────────────────────────────
  // goal.md can only be modified by humans directly.
  // Agents read it but never write it after creation.
  // This is intentional and enforced here.

  // ─── Scope Check ────────────────────────────────────────────────────────────

  async checkScope(proposedWork: string): Promise<ScopeCheckResult> {
    const goal = await this.read()

    if (!goal) {
      return {
        in_scope: true,
        confidence: 'low',
        reasoning: 'No goal.md found — cannot verify scope. Proceeding but recommend running quorum init.',
        recommendation: 'PROCEED'
      }
    }

    // Check against out_of_scope items
    for (const oos of goal.out_of_scope) {
      if (this.semanticMatch(proposedWork, oos.item)) {
        return {
          in_scope: false,
          confidence: 'high',
          reasoning: `This work matches an explicitly out-of-scope item: "${oos.item}". Reason: ${oos.reason}`,
          conflicting_oos: oos.item,
          recommendation: 'BLOCK'
        }
      }
    }

    // Check alignment with what we're building
    const alignsWithGoal = this.semanticMatch(proposedWork, goal.what)
    const alignsWithCriteria = goal.success_criteria.some(c =>
      this.semanticMatch(proposedWork, c)
    )

    if (!alignsWithGoal && !alignsWithCriteria) {
      return {
        in_scope: false,
        confidence: 'medium',
        reasoning: `This work does not clearly align with the project goal ("${goal.what}") or any success criteria. May be scope creep.`,
        recommendation: 'CLARIFY'
      }
    }

    const matchingCriterion = goal.success_criteria.find(c =>
      this.semanticMatch(proposedWork, c)
    )

    return {
      in_scope: true,
      confidence: alignsWithCriteria ? 'high' : 'medium',
      reasoning: `Aligns with project goal: "${goal.what}"`,
      matching_criteria: matchingCriterion,
      recommendation: 'PROCEED'
    }
  }

  // ─── Get goal as compact context string for agents ──────────────────────────

  async getContextSummary(): Promise<string> {
    const goal = await this.read()
    if (!goal) return 'No goal.md defined yet. Run quorum init to create one.'

    return `PROJECT GOAL: ${goal.what}
WHY: ${goal.why}
SUCCESS CRITERIA: ${goal.success_criteria.join(' | ')}
OUT OF SCOPE: ${goal.out_of_scope.map(o => o.item).join(' | ') || 'none defined'}
CURRENT MILESTONE: ${goal.milestones[0]?.name ?? 'MVP'}`
  }

  // ─── Parse/Serialize ──────────────────────────────────────────────────────

  private parseGoalMarkdown(raw: string): ProjectGoal {
    const lines = raw.split('\n')

    const what = this.extractSection(lines, '## What We Are Building')
    const why = this.extractSection(lines, '## Why It Exists')
    const successCriteria = this.extractListItems(lines, '## Success Criteria')
    const outOfScopeRaw = this.extractListItems(lines, '## What Is OUT OF SCOPE')

    const out_of_scope = outOfScopeRaw.map(item => {
      const parts = item.split(' — ')
      return {
        item: parts[0]?.trim() ?? item,
        reason: parts[1]?.trim() ?? ''
      }
    })

    const milestones = this.extractMilestones(lines)

    const metaLine = lines.find(l => l.startsWith('_Created:')) ?? ''
    const createdMatch = metaLine.match(/Created: ([^|]+)/)
    const updatedMatch = metaLine.match(/Last updated: ([^|]+)/)

    return {
      what: what.trim(),
      why: why.trim(),
      success_criteria: successCriteria.map(s => s.replace(/^- \[ \] /, '').trim()),
      out_of_scope,
      constraints: {},
      milestones,
      created_date: createdMatch?.[1]?.trim() ?? new Date().toISOString().split('T')[0]!,
      last_updated_date: updatedMatch?.[1]?.trim() ?? new Date().toISOString().split('T')[0]!,
      version: 1
    }
  }

  private goalToMarkdown(goal: ProjectGoal): string {
    const today = new Date().toISOString().split('T')[0]!

    const oosList = goal.out_of_scope
      .map(o => `- ${o.item}${o.reason ? ` — ${o.reason}` : ''}`)
      .join('\n') || '(none defined)'

    const criteriaList = goal.success_criteria
      .map(c => `- [ ] ${c}`)
      .join('\n')

    const milestoneList = goal.milestones
      .map(m => `- **${m.name}**: ${m.description}`)
      .join('\n')

    return `# Project Goal
<!-- Written ONCE by human before anything is built.
     AI agents NEVER modify this file.
     Only a human may update the scope.
     Every QUORUM agent reads this at session start. -->

## What We Are Building
${goal.what}

## Why It Exists
${goal.why}

## Success Criteria
${criteriaList}

## What Is OUT OF SCOPE
${oosList}

## Constraints
${goal.constraints.tech_stack ? `Tech stack: ${goal.constraints.tech_stack.join(', ')}` : ''}
${goal.constraints.timeline ? `Timeline: ${goal.constraints.timeline}` : ''}
${goal.constraints.team_size ? `Team size: ${goal.constraints.team_size}` : ''}

## Milestone Map
${milestoneList}

---
_Created: ${goal.created_date} | Last updated: ${goal.last_updated_date ?? today} | Version: ${goal.version}_
_ATLAS agents: read this file. Never modify it. Flag any work that contradicts it._
`
  }

  private extractSection(lines: string[], heading: string): string {
    const startIdx = lines.findIndex(l => l.trim() === heading)
    if (startIdx === -1) return ''
    const result: string[] = []
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i]!
      if (line.startsWith('## ') || line.startsWith('---')) break
      if (!line.startsWith('<!--')) result.push(line)
    }
    return result.join('\n').trim()
  }

  private extractListItems(lines: string[], heading: string): string[] {
    const section = this.extractSection(lines, heading)
    return section
      .split('\n')
      .filter(l => l.trim().startsWith('-'))
      .map(l => l.replace(/^-\s*/, '').trim())
  }

  private extractMilestones(lines: string[]): Array<{ name: string; description: string }> {
    const items = this.extractListItems(lines, '## Milestone Map')
    return items.map(item => {
      const match = item.match(/\*\*([^*]+)\*\*[:\s]*(.*)/)
      return {
        name: match?.[1]?.trim() ?? item,
        description: match?.[2]?.trim() ?? ''
      }
    })
  }

  private semanticMatch(text: string, target: string): boolean {
    const normalise = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)

    const textWords = new Set(normalise(text))
    const targetWords = normalise(target)

    const matches = targetWords.filter(w => w.length > 3 && textWords.has(w))
    const ratio = matches.length / Math.max(targetWords.filter(w => w.length > 3).length, 1)

    return ratio >= 0.35  // 35% word overlap = semantic match
  }
}
