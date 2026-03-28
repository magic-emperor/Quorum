import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import type { Task, TaskStatus, TaskIndex, TaskIndexEntry, TaskUpdate, ImpactAnalysis } from '../types.js'

export class TaskManager {
  private taskFilePath: string
  private taskIndexPath: string
  private cachedIndex: TaskIndex | null = null

  constructor(private projectDir: string) {
    this.taskFilePath = path.join(projectDir, '.quorum', 'task.md')
    this.taskIndexPath = path.join(projectDir, '.quorum', 'task-index.json')
  }

  // ─── Initialization ──────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    await mkdir(path.join(this.projectDir, '.quorum'), { recursive: true })

    if (!existsSync(this.taskFilePath)) {
      await writeFile(this.taskFilePath, this.getInitialTaskTemplate(), 'utf-8')
    }

    if (!existsSync(this.taskIndexPath)) {
      const emptyIndex: TaskIndex = {
        total: 0,
        last_updated: '',
        last_updated_date: new Date().toISOString().split('T')[0]!,
        summary: { complete: 0, in_progress: 0, blocked: 0, todo: 0, rolled_back: 0 },
        tasks: [],
        keywords_index: {},
        files_index: {},
        next_task_number: 1
      }
      await writeFile(this.taskIndexPath, JSON.stringify(emptyIndex, null, 2), 'utf-8')
    }
  }

  // ─── Read index (cheap — always use this first) ──────────────────────────────

  async readIndex(): Promise<TaskIndex> {
    if (this.cachedIndex) return this.cachedIndex
    if (!existsSync(this.taskIndexPath)) await this.initialize()
    const raw = await readFile(this.taskIndexPath, 'utf-8')
    this.cachedIndex = JSON.parse(raw) as TaskIndex
    return this.cachedIndex
  }

  // ─── Read specific tasks by ID ───────────────────────────────────────────────

  async readTasksByIds(taskIds: string[]): Promise<Task[]> {
    const allTasks = await this.readAllTasksFull()
    return allTasks.filter(t => taskIds.includes(t.id))
  }

  // ─── Find related tasks by keyword (uses index — cheap) ──────────────────────

  async findRelatedTaskIds(keywords: string[]): Promise<string[]> {
    const index = await this.readIndex()
    const taskIds = new Set<string>()

    for (const keyword of keywords) {
      const lower = keyword.toLowerCase()
      for (const [indexKeyword, ids] of Object.entries(index.keywords_index)) {
        if (indexKeyword.includes(lower) || lower.includes(indexKeyword)) {
          ids.forEach(id => taskIds.add(id))
        }
      }
    }

    return Array.from(taskIds)
  }

  async findTasksByFolder(folderPath: string): Promise<TaskIndexEntry[]> {
    const index = await this.readIndex()
    return index.tasks.filter(t =>
      t.folder === folderPath ||
      t.folder.startsWith(folderPath) ||
      folderPath.startsWith(t.folder)
    )
  }

  async findTasksByFile(filePath: string): Promise<TaskIndexEntry[]> {
    const index = await this.readIndex()
    const taskIds = index.files_index[filePath] ?? []
    return index.tasks.filter(t => taskIds.includes(t.id))
  }

  // ─── Create new task ─────────────────────────────────────────────────────────

  async createTask(
    partial: Omit<Task, 'id' | 'created_date' | 'updates'>,
    sessionId: string
  ): Promise<Task> {
    const index = await this.readIndex()
    const taskNumber = index.next_task_number
    const id = `TASK-${String(taskNumber).padStart(3, '0')}`

    const task: Task = {
      ...partial,
      id,
      created_date: new Date().toISOString().split('T')[0]!,
      created_in_session: sessionId,
      updates: []
    }

    await this.appendTaskToFile(task)
    await this.appendToFolderTaskFile(task)
    await this.updateIndex(task, 'create', sessionId)
    this.cachedIndex = null
    return task
  }

  // ─── Update task status ──────────────────────────────────────────────────────

  async updateTaskStatus(
    taskId: string,
    newStatus: TaskStatus,
    sessionId: string,
    note?: string
  ): Promise<void> {
    const update: TaskUpdate = {
      session: sessionId,
      date: new Date().toISOString().split('T')[0]!,
      type: 'status_change',
      note: note ?? `Status changed to ${newStatus}`
    }

    await this.appendUpdateToTaskFile(taskId, newStatus, update)
    await this.updateIndexStatus(taskId, newStatus, sessionId)
    this.cachedIndex = null
  }

  // ─── Complete a task ─────────────────────────────────────────────────────────

  async completeTask(
    taskId: string,
    sessionId: string,
    summary: string,
    affectedFiles: string[]
  ): Promise<void> {
    const completedDate = new Date().toISOString().split('T')[0]!

    const update: TaskUpdate = {
      session: sessionId,
      date: completedDate,
      type: 'status_change',
      note: `COMPLETED. Summary: ${summary}. Files: ${affectedFiles.join(', ')}`
    }

    await this.appendUpdateToTaskFile(taskId, 'COMPLETE', update)
    await this.updateIndexStatus(taskId, 'COMPLETE', sessionId, summary, affectedFiles, completedDate)
    this.cachedIndex = null
  }

  // ─── Impact analysis ─────────────────────────────────────────────────────────

  async analyzeImpact(
    description: string,
    keywords: string[],
    folderScope: string
  ): Promise<ImpactAnalysis> {
    const index = await this.readIndex()

    const keywordMatches = await this.findRelatedTaskIds(keywords)
    const folderMatches = (await this.findTasksByFolder(folderScope)).map(t => t.id)
    const candidateIds = Array.from(new Set([...keywordMatches, ...folderMatches]))
    const candidates = await this.readTasksByIds(candidateIds.slice(0, 10))

    const related: ImpactAnalysis['related_tasks'] = []

    for (const candidate of candidates) {
      const relationship = this.determineRelationship(description, candidate)
      if (relationship) {
        related.push({
          task_id: candidate.id,
          title: candidate.title,
          relationship: relationship.type,
          reason: relationship.reason,
          requires_update: relationship.requires_update,
          update_description: relationship.update_description
        })
      }
    }

    const affectedFiles = this.inferAffectedFiles(description, folderScope, candidates)

    const planIndexPath = path.join(this.projectDir, '.quorum', 'plan-index.json')
    let recommendedPhase = 'current'
    if (existsSync(planIndexPath)) {
      const planIndexRaw = await readFile(planIndexPath, 'utf-8')
      const planIndex = JSON.parse(planIndexRaw) as { current_phase: string }
      recommendedPhase = planIndex.current_phase
    }

    return {
      new_task_description: description,
      related_tasks: related,
      affected_files: affectedFiles,
      recommended_phase: recommendedPhase,
      creates_new_task: true,
      new_task_draft: {
        title: this.inferTitle(description),
        keywords,
        folder_scope: folderScope,
        depends_on: related
          .filter(r => r.relationship === 'depends_on')
          .map(r => r.task_id),
        status: 'TODO',
        milestone: index.current_milestone ?? 'MVP'
      }
    } as ImpactAnalysis
  }

  // ─── Get compact context for agents ─────────────────────────────────────────

  async getContextSummary(): Promise<string> {
    const index = await this.readIndex()

    const inProgress = index.tasks
      .filter(t => t.status === 'IN_PROGRESS')
      .map(t => `  ${t.id}: ${t.title}`)
      .join('\n')

    const recentlyCompleted = index.tasks
      .filter(t => t.status === 'COMPLETE')
      .slice(-5)
      .map(t => `  ${t.id}: ${t.title}`)
      .join('\n')

    const blocked = index.tasks
      .filter(t => t.status === 'BLOCKED')
      .map(t => `  ${t.id}: ${t.title}`)
      .join('\n')

    return `TASK STATUS: ${index.summary.complete} complete, ${index.summary.in_progress} in progress, ${index.summary.todo} todo, ${index.summary.blocked} blocked

IN PROGRESS:
${inProgress || '  none'}

RECENTLY COMPLETED:
${recentlyCompleted || '  none'}

BLOCKED:
${blocked || '  none'}

Total tasks: ${index.total} | Next ID: TASK-${String(index.next_task_number).padStart(3, '0')}`
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  private async readAllTasksFull(): Promise<Task[]> {
    if (!existsSync(this.taskFilePath)) return []
    const raw = await readFile(this.taskFilePath, 'utf-8')
    return this.parseTasksFromMarkdown(raw)
  }

  private async appendTaskToFile(task: Task): Promise<void> {
    const existing = existsSync(this.taskFilePath)
      ? await readFile(this.taskFilePath, 'utf-8')
      : this.getInitialTaskTemplate()

    const statusChar = task.status === 'COMPLETE' ? 'x' : ' '
    const dependsLine = task.depends_on.length > 0
      ? `\n  Depends on: ${task.depends_on.join(', ')}`
      : ''
    const blockedLine = task.status === 'BLOCKED' && task.blocked_reason
      ? `\n  Blocked: ${task.blocked_reason}`
      : ''

    const entry = `
- [${statusChar}] ${task.id} — ${task.title}
  Status: ${task.status}
  Phase: ${task.phase}
  Folder: ${task.folder_scope}
  Keywords: ${task.keywords.join(', ')}${dependsLine}${blockedLine}
  Description: ${task.description}
  Created: ${task.created_date} (session: ${task.created_in_session})
`
    await writeFile(this.taskFilePath, existing + entry, 'utf-8')
  }

  private async appendUpdateToTaskFile(
    taskId: string,
    newStatus: TaskStatus,
    update: TaskUpdate
  ): Promise<void> {
    if (!existsSync(this.taskFilePath)) return

    let content = await readFile(this.taskFilePath, 'utf-8')

    const statusLineRegex = new RegExp(
      `(- \\[[ x]\\] ${taskId} — .+\n  Status: )\\w+`,
      'm'
    )

    const statusChar = newStatus === 'COMPLETE' ? 'x' : ' '
    content = content.replace(
      new RegExp(`- \\[[ x]\\] (${taskId} — )`),
      `- [${statusChar}] $1`
    )
    content = content.replace(statusLineRegex, `$1${newStatus}`)

    const updateNote = `\n  Update [${update.date}]: ${update.note}`
    // Append update after the Created line for this task
    const createdPattern = new RegExp(
      `(  Created: [^\\n]+\\(session: [^)]+\\))((?:\\n  Update[^\\n]*)*)(\\n(?:-|$))`,
      'm'
    )
    // Simple approach: append at end of file if task found
    if (content.includes(taskId)) {
      content = content + updateNote + '\n'
    }

    await writeFile(this.taskFilePath, content, 'utf-8')
  }

  private async appendToFolderTaskFile(task: Task): Promise<void> {
    if (!task.folder_scope || task.folder_scope === 'global' || task.folder_scope === 'src/') return

    const folderTasksDir = path.join(this.projectDir, task.folder_scope, '.tasks')
    const folderTasksFile = path.join(folderTasksDir, 'tasks.md')

    await mkdir(folderTasksDir, { recursive: true })

    const existing = existsSync(folderTasksFile)
      ? await readFile(folderTasksFile, 'utf-8')
      : `# Tasks — ${task.folder_scope}\n<!-- Append only. References global task IDs from /.quorum/task.md -->\n\n`

    const entry = `
## ${task.id} — ${task.title}
Global ID: ${task.id}
Status: ${task.status}
Description: ${task.description}
Created: ${task.created_date}
${task.depends_on.length > 0 ? `Depends on: ${task.depends_on.join(', ')}` : ''}

---
`
    await writeFile(folderTasksFile, existing + entry, 'utf-8')
  }

  private async updateIndex(task: Task, operation: 'create' | 'update', sessionId: string): Promise<void> {
    const index = await this.readIndex()

    if (operation === 'create') {
      const entry: TaskIndexEntry = {
        id: task.id,
        title: task.title,
        status: task.status,
        phase: task.phase,
        folder: task.folder_scope,
        keywords: task.keywords,
        depends_on: task.depends_on,
        affects_files: task.affects_files,
        milestone: task.milestone
      }

      index.tasks.push(entry)
      index.total = index.tasks.length
      index.next_task_number++

      for (const keyword of task.keywords) {
        const key = keyword.toLowerCase()
        if (!index.keywords_index[key]) index.keywords_index[key] = []
        index.keywords_index[key]!.push(task.id)
      }

      for (const file of task.affects_files) {
        if (!index.files_index[file]) index.files_index[file] = []
        index.files_index[file]!.push(task.id)
      }
    }

    index.last_updated = sessionId
    index.last_updated_date = new Date().toISOString().split('T')[0]!
    index.summary = {
      complete: index.tasks.filter(t => t.status === 'COMPLETE').length,
      in_progress: index.tasks.filter(t => t.status === 'IN_PROGRESS').length,
      blocked: index.tasks.filter(t => t.status === 'BLOCKED').length,
      todo: index.tasks.filter(t => t.status === 'TODO').length,
      rolled_back: index.tasks.filter(t => t.status === 'ROLLED_BACK').length
    }

    await writeFile(this.taskIndexPath, JSON.stringify(index, null, 2), 'utf-8')
    this.cachedIndex = index
  }

  private async updateIndexStatus(
    taskId: string,
    newStatus: TaskStatus,
    sessionId: string,
    summary?: string,
    affectedFiles?: string[],
    completedDate?: string
  ): Promise<void> {
    const index = await this.readIndex()
    const entry = index.tasks.find(t => t.id === taskId)
    if (!entry) return

    entry.status = newStatus
    if (completedDate) entry.session_completed = sessionId
    if (affectedFiles?.length) {
      entry.affects_files = [...new Set([...entry.affects_files, ...affectedFiles])]
      for (const file of affectedFiles) {
        if (!index.files_index[file]) index.files_index[file] = []
        if (!index.files_index[file]!.includes(taskId)) {
          index.files_index[file]!.push(taskId)
        }
      }
    }

    index.last_updated = sessionId
    index.last_updated_date = new Date().toISOString().split('T')[0]!
    index.summary = {
      complete: index.tasks.filter(t => t.status === 'COMPLETE').length,
      in_progress: index.tasks.filter(t => t.status === 'IN_PROGRESS').length,
      blocked: index.tasks.filter(t => t.status === 'BLOCKED').length,
      todo: index.tasks.filter(t => t.status === 'TODO').length,
      rolled_back: index.tasks.filter(t => t.status === 'ROLLED_BACK').length
    }

    await writeFile(this.taskIndexPath, JSON.stringify(index, null, 2), 'utf-8')
    this.cachedIndex = index
  }

  private parseTasksFromMarkdown(raw: string): Task[] {
    const tasks: Task[] = []
    const blocks = raw.split(/\n- \[[ x]\] TASK-/)

    for (const block of blocks.slice(1)) {
      const lines = block.split('\n')
      const firstLine = lines[0] ?? ''
      const idMatch = firstLine.match(/^(\d+) — (.+)/)
      if (!idMatch) continue

      const id = `TASK-${idMatch[1]}`
      const title = idMatch[2] ?? ''

      const statusLine = lines.find(l => l.trim().startsWith('Status:'))
      const phaseLine = lines.find(l => l.trim().startsWith('Phase:'))
      const folderLine = lines.find(l => l.trim().startsWith('Folder:'))
      const descLine = lines.find(l => l.trim().startsWith('Description:'))
      const keywordsLine = lines.find(l => l.trim().startsWith('Keywords:'))
      const dependsLine = lines.find(l => l.trim().startsWith('Depends on:'))

      tasks.push({
        id,
        title,
        status: (statusLine?.split(':')[1]?.trim() ?? 'TODO') as TaskStatus,
        phase: phaseLine?.split(':')[1]?.trim() ?? '',
        folder_scope: folderLine?.split(':')[1]?.trim() ?? 'global',
        description: descLine?.split(':').slice(1).join(':').trim() ?? '',
        keywords: keywordsLine?.split(':')[1]?.split(',').map(k => k.trim()) ?? [],
        depends_on: dependsLine?.split(':')[1]?.split(',').map(d => d.trim()).filter(Boolean) ?? [],
        affects_files: [],
        milestone: 'MVP',
        created_in_session: '',
        created_date: '',
        updates: []
      })
    }

    return tasks
  }

  private determineRelationship(
    newDescription: string,
    existingTask: Task
  ): { type: ImpactAnalysis['related_tasks'][0]['relationship']; reason: string; requires_update: boolean; update_description?: string } | null {
    const descWords = new Set(newDescription.toLowerCase().split(/\s+/))
    const titleWords = existingTask.title.toLowerCase().split(/\s+/)
    const keywordMatch = existingTask.keywords.some(k => descWords.has(k.toLowerCase()))
    const titleMatch = titleWords.filter(w => w.length > 3).some(w => descWords.has(w))

    if (!keywordMatch && !titleMatch) return null

    if (existingTask.status === 'COMPLETE' && existingTask.affects_files.length > 0) {
      return {
        type: 'modifies',
        reason: `New work touches same area as ${existingTask.id} (${existingTask.title})`,
        requires_update: true,
        update_description: `Review ${existingTask.id} — new task may modify its output`
      }
    }

    if (existingTask.status === 'IN_PROGRESS') {
      return { type: 'extends', reason: `${existingTask.id} is currently in progress in the same area`, requires_update: false }
    }

    if (existingTask.status === 'TODO') {
      return { type: 'depends_on', reason: `${existingTask.id} should be completed before this task`, requires_update: false }
    }

    return null
  }

  private inferAffectedFiles(description: string, folderScope: string, relatedTasks: Task[]): string[] {
    const files = new Set<string>()
    for (const task of relatedTasks) {
      for (const file of task.affects_files) {
        if (file.includes(folderScope.replace(/\/$/, ''))) {
          files.add(file)
        }
      }
    }
    return Array.from(files)
  }

  private inferTitle(description: string): string {
    const cleaned = description.replace(/^(build|create|add|implement|fix|update)\s+/i, '')
    const titled = cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
    return titled.length > 60 ? titled.slice(0, 57) + '...' : titled
  }

  private getInitialTaskTemplate(): string {
    return `# Task Registry
<!-- APPEND ONLY. Never delete tasks. Never modify completed tasks.
     This is the permanent record of all work done on this project.
     AI agents append here — never edit existing entries. -->

## Rules
- Every task has a permanent sequential ID: TASK-001, TASK-002, etc.
- Completed tasks stay forever — they are historical record.
- New tasks are added at the bottom with the next number.
- Status values: TODO | IN_PROGRESS | COMPLETE | BLOCKED | ROLLED_BACK

---

`
  }

  get currentMilestone(): string {
    return this.cachedIndex?.current_milestone ?? 'MVP'
  }
}
