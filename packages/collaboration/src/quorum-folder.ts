import { mkdir, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import type { PlanRequest, ApprovalRequest, Contributor, CollaborationConfig } from './types.js'

// ─── Manages .quorum/collaboration/ folder ────────────────────────────────────

export class CollaborationStore {
  private collabDir: string

  constructor(projectDir: string) {
    this.collabDir = path.join(projectDir, '.quorum', 'collaboration')
  }

  async ensureDir(): Promise<void> {
    await mkdir(path.join(this.collabDir, 'chat-summaries'), { recursive: true })
    await mkdir(path.join(this.collabDir, 'approvals'), { recursive: true })

    if (!existsSync(path.join(this.collabDir, 'contributors.json'))) {
      await this.writeJson('contributors.json', [])
    }
    if (!existsSync(path.join(this.collabDir, 'audit-trail.json'))) {
      await this.writeJson('audit-trail.json', [])
    }
    if (!existsSync(path.join(this.collabDir, 'config.json'))) {
      const defaults: CollaborationConfig = {
        quorum: 'any',
        approval_timeout_hours: 24,
        auto_execute_on_approval: true
      }
      await this.writeJson('config.json', defaults)
    }
  }

  async getConfig(): Promise<CollaborationConfig> {
    return this.readJson<CollaborationConfig>('config.json')
  }

  // ── Plan requests ──────────────────────────────────────────────────────────

  async savePlanRequest(plan: PlanRequest): Promise<void> {
    await this.writeJson(`approvals/${plan.id}-plan.json`, plan)
  }

  async getPlanRequest(planId: string): Promise<PlanRequest | null> {
    const file = path.join(this.collabDir, 'approvals', `${planId}-plan.json`)
    if (!existsSync(file)) return null
    return this.readJson<PlanRequest>(`approvals/${planId}-plan.json`)
  }

  // ── Approval requests ──────────────────────────────────────────────────────

  async saveApproval(approval: ApprovalRequest): Promise<void> {
    await this.writeJson(`approvals/${approval.plan_request_id}-approval.json`, approval)
  }

  async getApproval(planId: string): Promise<ApprovalRequest | null> {
    const file = path.join(this.collabDir, 'approvals', `${planId}-approval.json`)
    if (!existsSync(file)) return null
    return this.readJson<ApprovalRequest>(`approvals/${planId}-approval.json`)
  }

  // ── Chat summaries ─────────────────────────────────────────────────────────

  async saveChatSummary(planId: string, content: string): Promise<void> {
    const date = new Date().toISOString().split('T')[0]
    const file = path.join(this.collabDir, 'chat-summaries', `${planId}-${date}.md`)
    await writeFile(file, content, 'utf-8')
  }

  // ── Plan + Task markdown files in .quorum/ ─────────────────────────────────

  async writePlanMd(projectDir: string, planMd: string): Promise<string> {
    const file = path.join(projectDir, '.quorum', 'plan.md')
    await writeFile(file, planMd, 'utf-8')
    return file
  }

  async writeTaskMd(projectDir: string, taskMd: string): Promise<string> {
    const file = path.join(projectDir, '.quorum', 'task.md')
    await writeFile(file, taskMd, 'utf-8')
    return file
  }

  // ── Audit trail (append-only) ─────────────────────────────────────────────

  async appendAudit(entry: {
    event: string
    plan_id: string
    user_id?: string
    details?: string
    timestamp: string
  }): Promise<void> {
    const trail = await this.readJson<unknown[]>('audit-trail.json')
    trail.push(entry)
    await this.writeJson('audit-trail.json', trail)
  }

  // ── Contributors ───────────────────────────────────────────────────────────

  async getContributors(): Promise<Contributor[]> {
    return this.readJson<Contributor[]>('contributors.json')
  }

  async upsertContributor(contributor: Contributor): Promise<void> {
    const contributors = await this.getContributors()
    const idx = contributors.findIndex(c => c.quorum_user_id === contributor.quorum_user_id)
    if (idx >= 0) {
      contributors[idx] = { ...contributors[idx], ...contributor }
    } else {
      contributors.push(contributor)
    }
    await this.writeJson('contributors.json', contributors)
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async readJson<T>(relPath: string): Promise<T> {
    const file = path.join(this.collabDir, relPath)
    const raw = await readFile(file, 'utf-8')
    return JSON.parse(raw) as T
  }

  private async writeJson(relPath: string, data: unknown): Promise<void> {
    const file = path.join(this.collabDir, relPath)
    await writeFile(file, JSON.stringify(data, null, 2), 'utf-8')
  }
}
