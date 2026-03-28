import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type {
  QUORUMConfig,
  QUORUMRunOptions,
  RoutingTable,
  Checkpoint,
  ClassificationResult,
  AgentMessage
} from './types.js'
import { buildRoutingTable } from './providers/index.js'
import { AgentRunner } from './agent-runner.js'
import { NervousSystem } from './memory/nervous-system.js'
import { GoalGuardian } from './memory/goal-guardian.js'
import { TaskManager } from './memory/task-manager.js'
import { PlanManager } from './memory/plan-manager.js'
import { SessionBriefManager } from './memory/session-brief.js'
import { ToolExecutor } from './tool-executor.js'
import { FunctionRegistry } from './memory/function-registry.js'

import { runInit } from './commands/init.js'
import { runFast } from './commands/fast.js'
import { runNext } from './commands/next.js'
import { runPause, runResume } from './commands/pause-resume.js'
import { runDoctor } from './commands/doctor.js'
import { runDiscuss } from './commands/discuss.js'
import { runVerify } from './commands/verify.js'
import { runShip } from './commands/ship.js'
import { runReview } from './commands/review.js'
import { runMap } from './commands/map.js'
import { runDebug } from './commands/debug.js'
import { runSessionReport } from './commands/session-report.js'
import { runSeed, runBacklog, runNote } from './commands/seed-backlog-note.js'
import { runAgents, runProfile } from './commands/agents-profile.js'
import { runExport } from './commands/export.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CONFIG_PATHS = ['quorum.config.json', '.quorum/config.json']

type Hooks = Pick<QUORUMRunOptions, 'onProgress' | 'onCheckpoint' | 'onAgentOutput'>

export class QUORUMEngine {
  private config!: QUORUMConfig
  private routingTable!: RoutingTable
  private ns!: NervousSystem
  private goalGuardian!: GoalGuardian
  private taskManager!: TaskManager
  private planManager!: PlanManager
  private briefManager!: SessionBriefManager
  private runner!: AgentRunner
  private tools!: ToolExecutor
  private functionRegistry!: FunctionRegistry
  private agentsDir: string
  private sessionId: string
  private projectDir: string
  private initialized = false

  constructor(private options: {
    projectDir: string
    configPath?: string
    agentsDir?: string
  }) {
    this.projectDir = path.resolve(options.projectDir)
    // Default agents dir: repo root/agents (3 levels up from packages/core/dist/)
    this.agentsDir = options.agentsDir ??
      path.join(__dirname, '..', '..', '..', 'agents')
    this.sessionId = `session_${Date.now()}`
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.config = await this.loadConfig()

    // Promote api_keys from quorum.config.json into process.env
    // (env vars always take priority — only set if env var is not already set)
    if (this.config.api_keys) {
      const keys = this.config.api_keys as Record<string, string>
      const envVarNames = [
        'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_AI_API_KEY',
        'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY',
        'V0_API_KEY', 'LOVABLE_API_KEY', 'LOCAL_OLLAMA_ENDPOINT'
      ]
      for (const envVar of envVarNames) {
        const value = keys[envVar]
        if (value && !process.env[envVar]) {
          process.env[envVar] = value
        }
      }
    }

    this.routingTable = await buildRoutingTable(this.config)
    this.ns = new NervousSystem(this.projectDir)
    this.goalGuardian = new GoalGuardian(this.projectDir)
    this.taskManager = new TaskManager(this.projectDir)
    this.planManager = new PlanManager(this.projectDir)
    this.briefManager = new SessionBriefManager(
      this.projectDir,
      this.goalGuardian,
      this.taskManager,
      this.planManager,
      this.ns
    )
    this.runner = new AgentRunner(this.projectDir)
    this.tools = new ToolExecutor(this.projectDir)
    this.functionRegistry = new FunctionRegistry(this.projectDir)

    // Initialize task + plan indexes (creates files if first run)
    await this.taskManager.initialize()
    await this.planManager.initialize()
    this.initialized = true
  }

  async run(options: QUORUMRunOptions): Promise<void> {
    await this.initialize()

    const { command, description, onProgress } = options

    onProgress?.(`QUORUM — session ${this.sessionId}`)

    // Show session notes from routing table (active providers etc.)
    for (const note of this.routingTable.session_notes) {
      onProgress?.(`  ${note}`)
    }

    switch (command) {
      case 'new':     await this.runNew(description ?? '', options); break
      case 'enhance': await this.runEnhance(description ?? '', options); break
      case 'status':  await this.runStatus(options); break
      case 'sync':    await this.runSync(options); break
      case 'rollback':onProgress?.('Rollback not yet implemented.'); break

      // ─── Phase 3 commands ───────────────────────────────────────────
      case 'init':
        await runInit(this.projectDir, options); break

      case 'fast':
        await runFast(description ?? '', this.projectDir, this.agentsDir, this.routingTable, options); break

      case 'next':
        await runNext(this.projectDir, options); break

      case 'pause':
        await runPause(this.projectDir, options); break

      case 'resume':
        await runResume(this.projectDir, options); break

      case 'doctor':
        await runDoctor(this.projectDir, options); break

      case 'discuss':
        await runDiscuss(description ?? '', this.projectDir, this.agentsDir, this.routingTable, options); break

      case 'verify':
        await runVerify(this.projectDir, options); break

      case 'ship':
        await runShip(this.projectDir, this.agentsDir, this.routingTable, options); break

      case 'review':
        await runReview(this.projectDir, this.agentsDir, this.routingTable, options); break

      case 'map':
        await runMap(this.projectDir, this.agentsDir, this.routingTable, options); break

      case 'debug':
        await runDebug(description ?? '', this.projectDir, this.agentsDir, this.routingTable, options); break

      case 'session-report':
        await runSessionReport(this.projectDir, options); break

      case 'seed':
        await runSeed(description ?? '', this.projectDir, options); break

      case 'backlog':
        await runBacklog(options.subcommand ?? 'list', description ?? '', this.projectDir, options); break

      case 'note':
        await runNote(description ?? '', this.projectDir, options); break

      case 'agents':
        await runAgents(this.projectDir, options, this.routingTable); break

      case 'profile':
        await runProfile(description ?? '', this.projectDir, options); break

      case 'export':
        await runExport(this.projectDir, options); break

      default:
        onProgress?.(`Unknown command: ${command}`)
    }
  }

  // ── quorum chat ───────────────────────────────────────────────────────────────

  /**
   * Process a single turn of an interactive chat session.
   * Call repeatedly with updated history to maintain conversation context.
   */
  async runChatTurn(
    message: string,
    history: AgentMessage[],
    hooks: Hooks
  ): Promise<{ response: string; updatedHistory: AgentMessage[] }> {
    if (!this.initialized) await this.initialize()

    const { onProgress } = hooks

    const result = await this.runner.run({
      agentName: 'quorum-chat',
      userMessage: message,
      conversationHistory: history,
      projectDir: this.projectDir,
      agentsDir: this.agentsDir,
      routingTable: this.routingTable,
      onProgress
    })

    // If the response contains code blocks, write them to disk
    const written = await this.extractAndWriteCodeBlocks(result.content)

    const updatedHistory: AgentMessage[] = [
      ...history,
      { role: 'user', content: message },
      { role: 'assistant', content: result.content }
    ]

    return {
      response: result.content,
      updatedHistory
    }
  }



  private async runNew(description: string, hooks: Hooks): Promise<void> {
    const { onProgress } = hooks

    // Classify first — MICRO tasks skip everything including Foundation Mode
    onProgress?.('\nClassifying project...')
    const classification = await this.classify(description, hooks)
    onProgress?.(`→ ${classification.classification}: ${classification.reasoning}`)

    // For MICRO: suppress verbose classifier panel, just one line above
    // For SIMPLE/COMPLEX: show full classifier details
    if (classification.classification !== 'MICRO') {
      hooks.onAgentOutput?.('quorum-classifier', `CLASSIFICATION: ${classification.classification}\nREASONING: ${classification.reasoning}`)
    }

    // MICRO path: single script/snippet — skip all phases, write code directly
    if (classification.classification === 'MICRO') {
      onProgress?.('Micro task — writing code directly.')
      const coderResponse = await this.runner.run({
        agentName: 'quorum-coder',
        userMessage: description,
        projectDir: this.projectDir,
        agentsDir: this.agentsDir,
        routingTable: this.routingTable,
        onProgress
      })

      // Extract code blocks from the AI response and write them to disk
      const written = await this.extractAndWriteCodeBlocks(coderResponse.content)
      
      hooks.onAgentOutput?.('quorum-coder', coderResponse.content)
      if (written.length > 0) {
        onProgress?.(`\n✓ Written to ${this.projectDir}:`)
        for (const f of written) {
          onProgress?.(`  → ${f}`)
        }
      } else {
        // No parseable code blocks — show the raw response
        onProgress?.(coderResponse.content)
      }
      return
    }

    // Foundation mode for new non-micro projects
    const isNew = !(await this.ns.exists())
    if (isNew) {
      onProgress?.('New project — running Foundation Mode...')
      await this.ns.initialize()
      await this.runFoundationMode(description, hooks)
    }

    if (classification.classification === 'SIMPLE' &&
        this.config.checkpoints.auto_proceed_simple_projects) {
      onProgress?.('Simple project — building directly.')
      await this.runBuildPhase(description, hooks)
      await this.saveSession(hooks)
      return
    }

    // Complex project — full pipeline
    onProgress?.('Complex project — full pipeline.')

    const archOk = await this.runArchitecturePhase(description, hooks)
    if (!archOk) return

    const designOk = await this.runDesignPhase(description, hooks)
    if (!designOk) return

    await this.runBuildPhase(description, hooks)
    await this.runIntegrationPhase(hooks)

    const testOk = await this.runTestingPhase(hooks)
    if (!testOk) return

    // Optional scaling phase
    if (this.config.checkpoints.prompt_scaling_phase_6 && hooks.onCheckpoint) {
      const checkpoint: Checkpoint = {
        type: 'BLOCKER',
        title: 'Phase 6 — Scaling Analysis',
        completed: ['Architecture', 'Design', 'Build', 'Integration', 'Testing'],
        question: 'Run scaling & cost analysis? (shows bottlenecks at 100/1K/10K/100K users)',
        options: [
          { label: 'YES', tradeoff: '~2 min, recommended before launch' },
          { label: 'SKIP', tradeoff: 'Run quorum sync --scaling later' }
        ]
      }
      const response = await hooks.onCheckpoint(checkpoint)
      if (/^(yes|y|a)/i.test(response)) {
        await this.runScalingPhase(hooks)
      }
    }

    await this.saveSession(hooks)
    onProgress?.('\nATLAS complete.')
  }

  // ── quorum enhance ───────────────────────────────────────────────────────────

  private async runEnhance(description: string, hooks: Hooks): Promise<void> {
    const { onProgress } = hooks

    if (!(await this.ns.exists())) {
      onProgress?.('No .quorum/ found. Run: atlas init')
      return
    }

    // Scope guard — check if this is in scope
    if (!(await this.checkScopeGuard(description, onProgress))) return

    onProgress?.('Loading project context...')
    const memory = await this.ns.getFullMemory()
    onProgress?.(`Loaded ${memory.decisions.length} decisions, ${memory.actions.length} actions.`)

    // Function registry context — cheap navigation instead of reading files
    const registryContext = await this.functionRegistry.getContextSummary()

    const memoryContext = JSON.stringify({
      decisions: memory.decisions.slice(-20),
      stack: memory.stack,
      bugs: memory.bugs.filter(b => b.status !== 'FIXED')
    })

    const context = `${registryContext}\n\nProject memory:\n${memoryContext}`

    onProgress?.(`\nEnhancing: ${description}`)
    await this.runBuildPhase(description, hooks, context)

    // Update function registry after changes
    await this.functionRegistry.scanAndUpdate(this.sessionId, onProgress)

    await this.saveSession(hooks)
  }

  // ── quorum status ────────────────────────────────────────────────────────────

  private async runStatus(hooks: Hooks & { extra?: Record<string, string> }): Promise<void> {
    const { onProgress } = hooks
    const extra = (hooks as QUORUMRunOptions).extra ?? {}

    onProgress?.('\nATLAS STATUS')
    onProgress?.('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

    // Active providers
    const active = this.routingTable.providers_active
    onProgress?.(`Providers: ${active.length > 0 ? active.join(', ') : 'none — run: quorum key add PROVIDER_KEY=your-key'}`)

    // Optional: full routing table
    if (extra['routing'] === 'true') {
      onProgress?.('\nROUTING TABLE:')
      for (const [agent, routing] of Object.entries(this.routingTable.session_routing_table)) {
        onProgress?.(`  ${agent.padEnd(35)} ${routing.provider}/${routing.model}`)
      }
    }

    const quorumDir = path.join(this.projectDir, '.quorum')
    if (await this.ns.exists()) {
      const taskIndexPath = path.join(quorumDir, 'task-index.json')
      const planIndexPath = path.join(quorumDir, 'plan-index.json')

      if (existsSync(taskIndexPath)) {
        const ti = JSON.parse(await readFile(taskIndexPath, 'utf-8')) as {
          total: number; summary: { complete: number; in_progress: number; blocked: number; todo: number }
          current_milestone?: string
        }
        onProgress?.(`\nTASKS: ${ti.summary.complete}/${ti.total} complete | ${ti.summary.in_progress} in progress | ${ti.summary.blocked} blocked`)
        if (ti.current_milestone) onProgress?.(`Milestone: ${ti.current_milestone}`)
      }

      if (existsSync(planIndexPath)) {
        const pi = JSON.parse(await readFile(planIndexPath, 'utf-8')) as {
          current_phase: string; current_milestone: string
          phases?: Array<{ name: string; status: string; tasks_complete: number; task_count: number }>
        }
        onProgress?.(`Plan phase: ${pi.current_phase || 'none'}`)

        // Progress breakdown if requested
        if (extra['progress'] === 'true' && pi.phases) {
          onProgress?.('\nPROGRESS:')
          pi.phases.forEach(p => {
            const icon = p.status === 'COMPLETE' ? '✓' : p.status === 'IN_PROGRESS' ? '→' : '○'
            const pct = p.task_count > 0 ? Math.round((p.tasks_complete / p.task_count) * 100) : 0
            onProgress?.(`  ${icon} ${p.name}: ${p.tasks_complete}/${p.task_count} tasks (${pct}%)`)
          })
        }
      }

      if (extra['decisions'] === 'true') {
        const decisions = await this.ns.readDecisions()
        onProgress?.('\nRECENT DECISIONS:')
        decisions.slice(-5).forEach(d => onProgress?.(`  ${d.id}: ${d.what}`))
      }

    } else {
      onProgress?.('\nNo .quorum/ found → run: atlas init')
    }

    onProgress?.('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  }

  // ── quorum sync ──────────────────────────────────────────────────────────────

  private async runSync(hooks: Hooks): Promise<void> {
    const { onProgress } = hooks
    onProgress?.('Syncing project index...')

    const result = await this.tools.execute({ tool: 'glob_search', pattern: 'src/**/*', max_results: 1000 })
    const count = result.output.split('\n').filter(Boolean).length
    onProgress?.(`Scanned ${count} source files`)

    // Rebuild function registry
    await this.functionRegistry.scanAndUpdate(this.sessionId, onProgress)

    onProgress?.('Sync complete.')
  }

  // ── New helpers (Phase 4) ───────────────────────────────────────────────────

  private async checkScopeGuard(
    description: string,
    onProgress?: (msg: string) => void
  ): Promise<boolean> {
    if (!this.goalGuardian.exists()) return true

    const result = await this.goalGuardian.checkScope(description)

    if (result.recommendation === 'BLOCK') {
      onProgress?.(`SCOPE GUARD: ${result.reasoning}`)
      onProgress?.('This is explicitly out of scope per goal.md.')
      onProgress?.('To proceed: update .quorum/goal.md and re-run.')
      return false
    }

    if (result.recommendation === 'CLARIFY') {
      onProgress?.(`SCOPE NOTE: ${result.reasoning}`)
    }

    return true
  }

  private async ensurePlanExists(
    description: string,
    options: QUORUMRunOptions
  ): Promise<boolean> {
    const { onProgress, onCheckpoint, onAgentOutput } = options

    if (this.planManager.exists()) return true

    onProgress?.('\nNo implementation plan — creating one before building...')

    const planResponse = await this.runner.run({
      agentName: 'quorum-planner',
      userMessage: `Create implementation plan for: ${description}`,
      projectDir: this.projectDir,
      agentsDir: this.agentsDir,
      routingTable: this.routingTable,
      onProgress
    })
    onAgentOutput?.('quorum-planner', planResponse.content)

    if (!options.auto && onCheckpoint) {
      const response = await onCheckpoint({
        type: 'BLOCKER',
        title: 'Implementation Plan Approval',
        completed: ['Goal analyzed', 'Phases designed', 'Tasks drafted'],
        question: 'Approve the implementation plan before code is written.',
        options: [
          { label: 'APPROVE', tradeoff: 'Build starts' },
          { label: 'REQUEST CHANGES', tradeoff: 'Plan revised first' }
        ],
        supportingDoc: '.quorum/implementation-plan.md'
      })

      if (!response.toUpperCase().includes('APPROVE') && response !== 'A') {
        const revised = await this.runner.run({
          agentName: 'quorum-planner',
          userMessage: `Revise plan: ${response}\nOriginal:\n${planResponse.content}`,
          projectDir: this.projectDir,
          agentsDir: this.agentsDir,
          routingTable: this.routingTable,
          onProgress
        })
        onAgentOutput?.('quorum-planner (revision)', revised.content)
      }
    }

    return true
  }

  /** Parse fenced code blocks from agent output and write each to disk.
   *  Recognises: ```python:filename.py or ```python (derives filename automatically)
   *  Returns a list of files that were written. */
  private async extractAndWriteCodeBlocks(content: string): Promise<string[]> {
    const { writeFile: wf, mkdir: mkd } = await import('fs/promises')
    const written: string[] = []

    // Match ``` blocks — optional language and optional :filename hint
    const blockRe = /```(\w+)?(?::([^\n]+))?\n([\s\S]*?)```/g
    const langToExt: Record<string, string> = {
      python: 'py', py: 'py',
      javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts',
      bash: 'sh', sh: 'sh', shell: 'sh',
      go: 'go', rust: 'rs', ruby: 'rb', java: 'java', c: 'c', cpp: 'cpp',
      html: 'html', css: 'css', json: 'json', yaml: 'yml', toml: 'toml',
    }
    let fileIndex = 0
    let match: RegExpExecArray | null
    while ((match = blockRe.exec(content)) !== null) {
      const lang = (match[1] ?? '').toLowerCase()
      const hintFile = match[2]?.trim()
      const code = match[3] ?? ''
      if (!code.trim()) continue

      // Determine filename
      let filename: string
      if (hintFile) {
        filename = hintFile
      } else {
        const ext = langToExt[lang] ?? (lang || 'txt')
        // Try to extract filename from inside the code (e.g. # hello_world.py)
        const commentMatch = code.match(/^#\s*([^\n]+\.\w+)/m)
        if (commentMatch?.[1]) {
          filename = commentMatch[1].trim()
        } else {
          filename = fileIndex === 0 ? `output.${ext}` : `output_${fileIndex}.${ext}`
        }
      }
      fileIndex++

      const fullPath = path.join(this.projectDir, filename)
      await mkd(path.dirname(fullPath), { recursive: true })
      await wf(fullPath, code, 'utf-8')
      written.push(filename)
    }

    return written
  }

  private async createRollbackPoint(name: string): Promise<void> {
    const { mkdir: mkdirAsync, writeFile: writeFileAsync } = await import('fs/promises')
    const rollbackDir = path.join(this.projectDir, '.quorum', 'rollback_points', name)
    await mkdirAsync(rollbackDir, { recursive: true })

    const snapshot = {
      name,
      created: new Date().toISOString(),
      session: this.sessionId,
      task_summary: await this.taskManager.getContextSummary()
    }

    await writeFileAsync(
      path.join(rollbackDir, 'snapshot.json'),
      JSON.stringify(snapshot, null, 2),
      'utf-8'
    )
  }

  private inferFolderScope(description: string): string {
    const lower = description.toLowerCase()
    if (lower.includes('auth') || lower.includes('login') || lower.includes('password')) return 'src/auth/'
    if (lower.includes('api') || lower.includes('endpoint') || lower.includes('route')) return 'src/api/'
    if (lower.includes('dashboard') || lower.includes('ui') || lower.includes('component')) return 'src/components/'
    if (lower.includes('database') || lower.includes('migration') || lower.includes('schema')) return 'src/db/'
    if (lower.includes('test')) return 'src/__tests__/'
    return 'src/'
  }


  private async loadSessionContext(onProgress?: (msg: string) => void): Promise<string> {
    try {
      const brief = await this.briefManager.generate(
        this.sessionId,
        this.routingTable.providers_active
      )
      return brief
    } catch {
      return ''
    }
  }

  private async classify(description: string, hooks: Hooks): Promise<ClassificationResult> {
    const stack = await this.ns.readStack()
    const response = await this.runner.run({
      agentName: 'quorum-classifier',
      userMessage: `Project description: ${description}\n\nExisting stack context: ${JSON.stringify(stack)}`,
      projectDir: this.projectDir,
      agentsDir: this.agentsDir,
      routingTable: this.routingTable,
      onProgress: hooks.onProgress
    })
    // NOTE: onAgentOutput is intentionally NOT called here.
    // The caller (runNew) decides whether to surface classifier details to the UI.

    const lines = response.content.split('\n')
    const classLine = lines.find(l => /^CLASSIFICATION:/i.test(l))
    const reasonLine = lines.find(l => /^REASONING:/i.test(l))

    const rawClass = classLine?.split(':')[1]?.trim().toUpperCase() ?? 'COMPLEX'
    const validClasses = ['MICRO', 'SIMPLE', 'COMPLEX']
    const safeClass = validClasses.includes(rawClass) ? rawClass : 'COMPLEX'
    return {
      classification: safeClass as 'MICRO' | 'SIMPLE' | 'COMPLEX',
      reasoning: reasonLine?.split(':').slice(1).join(':').trim() ?? response.content.slice(0, 200),
      inferred_stack: {},
      unknown_critical: [],
      suggested_questions: []
    }
  }

  private async runFoundationMode(description: string, hooks: Hooks): Promise<void> {
    const response = await this.runner.run({
      agentName: 'quorum-nervous-system',
      userMessage: `FOUNDATION MODE — New project.\nDescription: ${description}\nSeed the .quorum/ folder with initial stack detection and decisions.`,
      context: { PROJECT_DESCRIPTION: description },
      projectDir: this.projectDir,
      agentsDir: this.agentsDir,
      routingTable: this.routingTable,
      onProgress: hooks.onProgress
    })
    hooks.onAgentOutput?.('quorum-nervous-system', response.content)

    // Try to extract stack JSON and save it
    const stackMatch = response.content.match(/```json\n([\s\S]*?)\n```/)
    if (stackMatch?.[1]) {
      try {
        await this.ns.writeStack(JSON.parse(stackMatch[1]))
      } catch { /* not parseable — skip */ }
    }
  }

  private async runArchitecturePhase(description: string, hooks: Hooks): Promise<boolean> {
    const { onProgress } = hooks
    onProgress?.('\n── Phase 1: Backend Architecture ──────────────────')

    const messages: AgentMessage[] = []

    // Architect proposes
    const archResponse = await this.runner.run({
      agentName: 'quorum-backend-architect',
      userMessage: `Project: ${description}`,
      projectDir: this.projectDir,
      agentsDir: this.agentsDir,
      routingTable: this.routingTable,
      onProgress
    })
    hooks.onAgentOutput?.('quorum-backend-architect', archResponse.content)
    messages.push({ role: 'assistant', content: archResponse.content })

    // Critic reviews
    const criticResponse = await this.runner.run({
      agentName: 'quorum-critic',
      userMessage: `Review this architecture:\n\n${archResponse.content}`,
      projectDir: this.projectDir,
      agentsDir: this.agentsDir,
      routingTable: this.routingTable,
      onProgress
    })
    hooks.onAgentOutput?.('quorum-critic', criticResponse.content)

    // Architect-Validator loop
    let architectureDoc = archResponse.content
    const maxRounds = this.config.loop_limits.architect_validator_max_rounds

    for (let round = 0; round < maxRounds; round++) {
      const valResponse = await this.runner.run({
        agentName: 'quorum-backend-validator',
        userMessage: `Validate:\n\n${architectureDoc}\n\nCritic notes:\n${criticResponse.content}`,
        projectDir: this.projectDir,
        agentsDir: this.agentsDir,
        routingTable: this.routingTable,
        onProgress
      })
      hooks.onAgentOutput?.('quorum-backend-validator', valResponse.content)

      const approved =
        /CONFIDENCE:\s*100%/i.test(valResponse.content) ||
        /READY TO APPROVE:\s*yes/i.test(valResponse.content)

      if (approved || round === maxRounds - 1) {
        onProgress?.(`  Validator approved architecture (round ${round + 1})`)
        break
      }

      // Architect revises
      const revResponse = await this.runner.run({
        agentName: 'quorum-backend-architect',
        userMessage: `Revise based on validator:\n\n${valResponse.content}\n\nOriginal:\n\n${architectureDoc}`,
        projectDir: this.projectDir,
        agentsDir: this.agentsDir,
        routingTable: this.routingTable,
        onProgress
      })
      architectureDoc = revResponse.content
      hooks.onAgentOutput?.('quorum-backend-architect', revResponse.content)
    }

    // Save architecture proposal
    await this.tools.execute({
      tool: 'file_write',
      path: '.quorum/context/architecture-proposal.md',
      content: architectureDoc,
      mode: 'create'
    })

    // Checkpoint A
    if (this.config.checkpoints.require_human_phase_1 && hooks.onCheckpoint) {
      const checkpoint: Checkpoint = {
        type: 'A',
        title: 'Backend Architecture',
        completed: ['Complexity classification', 'Architecture design', 'Critic review', 'Validator approval'],
        question: 'Approve the architecture or describe what to change.',
        options: [
          { label: 'APPROVE', tradeoff: 'Proceed to frontend design' },
          { label: 'REQUEST CHANGES', tradeoff: 'One revision round, then proceed' }
        ],
        supportingDoc: '.quorum/context/architecture-proposal.md'
      }
      const response = await hooks.onCheckpoint(checkpoint)

      if (!/^(approve|a)$/i.test(response.trim())) {
        // Human wants changes — one more revision
        const finalRev = await this.runner.run({
          agentName: 'quorum-backend-architect',
          userMessage: `Human feedback: ${response}\n\nRevise:\n\n${architectureDoc}`,
          projectDir: this.projectDir,
          agentsDir: this.agentsDir,
          routingTable: this.routingTable,
          onProgress
        })
        architectureDoc = finalRev.content
        await this.tools.execute({
          tool: 'file_write',
          path: '.quorum/context/architecture-proposal.md',
          content: architectureDoc,
          mode: 'create'
        })
        hooks.onAgentOutput?.('quorum-backend-architect', finalRev.content)
      }
    }

    onProgress?.('  Phase 1 complete.')
    return true
  }

  private async runDesignPhase(description: string, hooks: Hooks): Promise<boolean> {
    const { onProgress } = hooks
    onProgress?.('\n── Phase 2: Frontend Design ───────────────────────')

    const archDoc = existsSync(path.join(this.projectDir, '.quorum/context/architecture-proposal.md'))
      ? await readFile(path.join(this.projectDir, '.quorum/context/architecture-proposal.md'), 'utf-8')
      : 'No architecture doc available.'

    const designResponse = await this.runner.run({
      agentName: 'quorum-design-architect',
      userMessage: `Project: ${description}\n\nApproved architecture:\n${archDoc}`,
      projectDir: this.projectDir,
      agentsDir: this.agentsDir,
      routingTable: this.routingTable,
      onProgress
    })
    hooks.onAgentOutput?.('quorum-design-architect', designResponse.content)

    // Design validator loop
    let designDoc = designResponse.content
    for (let round = 0; round < this.config.loop_limits.design_loop_max_rounds; round++) {
      const valResponse = await this.runner.run({
        agentName: 'quorum-design-validator',
        userMessage: `Validate design:\n\n${designDoc}`,
        projectDir: this.projectDir,
        agentsDir: this.agentsDir,
        routingTable: this.routingTable,
        onProgress
      })
      hooks.onAgentOutput?.('quorum-design-validator', valResponse.content)
      if (/Confidence:\s*100%/i.test(valResponse.content) ||
          /DESIGN VALIDATOR SIGN-OFF/i.test(valResponse.content)) {
        break
      }
    }

    await this.tools.execute({
      tool: 'file_write',
      path: '.quorum/context/design-proposal.md',
      content: designDoc,
      mode: 'create'
    })

    // Checkpoint B
    if (this.config.checkpoints.require_human_phase_2 && hooks.onCheckpoint) {
      const checkpoint: Checkpoint = {
        type: 'B',
        title: 'Frontend Design',
        completed: ['Design variations generated', 'Buildability validated'],
        question: 'Select design option (1/2/3/4) or describe customizations.',
        options: [
          { label: 'SELECT 1', tradeoff: '' },
          { label: 'SELECT 2', tradeoff: '' },
          { label: 'SELECT 3', tradeoff: '' },
          { label: 'SELECT 4', tradeoff: '' }
        ],
        supportingDoc: '.quorum/context/design-proposal.md'
      }
      await hooks.onCheckpoint(checkpoint)
    }

    onProgress?.('  Phase 2 complete.')
    return true
  }

  private async runBuildPhase(
    description: string,
    hooks: Hooks,
    memoryContext?: string
  ): Promise<void> {
    const { onProgress } = hooks
    onProgress?.('\n── Phase 3: Building ──────────────────────────────')

    const context = memoryContext ? `\n\nProject memory:\n${memoryContext}` : ''

    // Backend and frontend run in parallel
    const [backendResponse, frontendResponse] = await Promise.all([
      this.runner.run({
        agentName: 'quorum-backend-builder',
        userMessage: `Build the backend for: ${description}${context}`,
        projectDir: this.projectDir,
        agentsDir: this.agentsDir,
        routingTable: this.routingTable,
        onProgress
      }),
      this.runner.run({
        agentName: 'quorum-frontend-builder',
        userMessage: `Build the frontend for: ${description}${context}`,
        projectDir: this.projectDir,
        agentsDir: this.agentsDir,
        routingTable: this.routingTable,
        onProgress
      })
    ])

    hooks.onAgentOutput?.('quorum-backend-builder', backendResponse.content)
    hooks.onAgentOutput?.('quorum-frontend-builder', frontendResponse.content)

    // Extract and persist agent output documents for Phase 4 to consume
    await this.extractAndSaveDoc(backendResponse.content, 'api-contract.md', '.quorum/context/api-contract.md')
    await this.extractAndSaveDoc(frontendResponse.content, 'frontend-api-calls.md', '.quorum/context/frontend-api-calls.md')

    // Critic monitors
    await this.runner.run({
      agentName: 'quorum-critic',
      userMessage: `Review build output.\nBackend:\n${backendResponse.content.slice(0, 3000)}\n\nFrontend:\n${frontendResponse.content.slice(0, 3000)}`,
      projectDir: this.projectDir,
      agentsDir: this.agentsDir,
      routingTable: this.routingTable,
      onProgress
    })

    await this.createRollbackPoint('rp_003_build_complete')
    onProgress?.('  Phase 3 complete.')
  }

  private async runIntegrationPhase(hooks: Hooks): Promise<void> {
    const { onProgress } = hooks
    onProgress?.('\n── Phase 4: Integration ───────────────────────────')

    const archPath = path.join(this.projectDir, '.quorum/context/architecture-proposal.md')
    const frontendCallsPath = path.join(this.projectDir, '.quorum/context/frontend-api-calls.md')
    const archDoc = existsSync(archPath) ? await readFile(archPath, 'utf-8') : 'No architecture doc available.'
    const frontendCalls = existsSync(frontendCallsPath) ? await readFile(frontendCallsPath, 'utf-8') : 'No frontend-api-calls.md found.'

    const maxRounds = this.config.loop_limits.integration_max_rounds ?? 2
    let integrationDoc = ''
    let readyForTesting = false

    for (let round = 0; round < maxRounds; round++) {
      const roundPrefix = round > 0 ? `Round ${round + 1} — previous output had unresolved issues.\n\n` : ''
      const response = await this.runner.run({
        agentName: 'quorum-integration',
        userMessage: `${roundPrefix}Verify frontend-backend API connections and fix all mismatches.\n\narchitecture-proposal.md:\n${archDoc.slice(0, 4000)}\n\nfrontend-api-calls.md:\n${frontendCalls.slice(0, 4000)}`,
        projectDir: this.projectDir,
        agentsDir: this.agentsDir,
        routingTable: this.routingTable,
        onProgress
      })
      hooks.onAgentOutput?.('quorum-integration', response.content)
      integrationDoc = response.content
      readyForTesting = /Status:\s*READY FOR TESTING/i.test(response.content)

      // Surface architecture gaps to human for a go/defer decision
      if (/ARCHITECTURE GAP FOUND/i.test(response.content) && hooks.onCheckpoint) {
        const gapSection = response.content.match(/ARCHITECTURE GAP FOUND[\s\S]*?(?=\n##|\n---|$)/)?.[0] ?? ''
        const checkpoint: Checkpoint = {
          type: 'BLOCKER',
          title: 'Architecture Gap — Human Decision Required',
          completed: ['Contract comparison', 'Mismatch classification'],
          question: `${gapSection}\n\nChoose: A) Implement simple version now  B) Defer to next session`,
          options: [
            { label: 'A — IMPLEMENT NOW', tradeoff: 'Agent implements minimal version' },
            { label: 'B — DEFER', tradeoff: 'Gap logged, continue with existing code' }
          ]
        }
        const gapResponse = await hooks.onCheckpoint(checkpoint)
        if (/^b|defer/i.test(gapResponse.trim())) {
          onProgress?.('  Architecture gap deferred — continuing.')
          readyForTesting = true
          break
        }
        continue
      }

      if (readyForTesting) break
    }

    await this.tools.execute({
      tool: 'file_write',
      path: '.quorum/context/integration-fixes.md',
      content: integrationDoc,
      mode: 'create'
    })

    if (!readyForTesting) {
      onProgress?.('  ⚠ Integration sign-off not confirmed — proceeding with caution.')
    }
    onProgress?.('  Phase 4 complete.')
  }

  private async runTestingPhase(hooks: Hooks): Promise<boolean> {
    const { onProgress } = hooks
    onProgress?.('\n── Phase 5: Testing ───────────────────────────────')

    const integrationFixesPath = path.join(this.projectDir, '.quorum/context/integration-fixes.md')
    const bugRegistryPath = path.join(this.projectDir, '.quorum/nervous-system/bug-registry.json')
    const stackPath = path.join(this.projectDir, '.quorum/nervous-system/stack.json')
    const bugsPath = path.join(this.projectDir, '.quorum/BUGS.md')

    const integrationFixes = existsSync(integrationFixesPath) ? await readFile(integrationFixesPath, 'utf-8') : 'No integration-fixes.md found.'
    const bugRegistry = existsSync(bugRegistryPath) ? await readFile(bugRegistryPath, 'utf-8') : '[]'
    const stack = existsSync(stackPath) ? await readFile(stackPath, 'utf-8') : '{}'

    const maxAttempts = this.config.loop_limits.bug_fix_max_attempts ?? 2
    let testingResponse = ''

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const attemptPrefix = attempt > 0 ? `Fix attempt ${attempt + 1}. Address remaining critical bugs.\n\n` : ''
      const response = await this.runner.run({
        agentName: 'quorum-testing',
        userMessage: `${attemptPrefix}Run end-to-end tests on the application.\n\nintegration-fixes.md:\n${integrationFixes.slice(0, 3000)}\n\nbug-registry.json:\n${bugRegistry.slice(0, 2000)}\n\nstack.json:\n${stack}`,
        projectDir: this.projectDir,
        agentsDir: this.agentsDir,
        routingTable: this.routingTable,
        onProgress
      })
      hooks.onAgentOutput?.('quorum-testing', response.content)
      testingResponse = response.content

      await this.appendBugsToRegistry(testingResponse, bugsPath)
      await this.persistTestCoverage(testingResponse)

      // Stop retrying once no unresolved critical bugs remain
      const hasUnresolvedCritical = /Severity:\s*critical/i.test(testingResponse)
        && !/Fix applied:/i.test(testingResponse)
      if (!hasUnresolvedCritical) break
      onProgress?.(`  Critical bugs remain — fix attempt ${attempt + 2}...`)
    }

    // Checkpoint C
    if (this.config.checkpoints.require_human_phase_5 && hooks.onCheckpoint) {
      const checkpoint: Checkpoint = {
        type: 'C',
        title: 'Testing Complete',
        completed: ['End-to-end tests run', 'Bugs documented', 'Coverage recorded'],
        question: 'Review results and APPROVE to finalize, or type REVIEW <BUG-ID> to investigate a deferred bug.',
        options: [
          { label: 'APPROVE', tradeoff: 'Proceed to completion' },
          { label: 'REQUEST FIXES', tradeoff: 'Agents will address specific issues' }
        ],
        supportingDoc: '.quorum/BUGS.md'
      }
      const humanResponse = await hooks.onCheckpoint(checkpoint)

      if (/^review\s+/i.test(humanResponse.trim())) {
        const bugId = humanResponse.replace(/^review\s+/i, '').trim()
        onProgress?.(`  Reviewing ${bugId}...`)
        const reviewResponse = await this.runner.run({
          agentName: 'quorum-testing',
          userMessage: `Review and fix ${bugId}. Read .quorum/BUGS.md for full details.`,
          projectDir: this.projectDir,
          agentsDir: this.agentsDir,
          routingTable: this.routingTable,
          onProgress
        })
        hooks.onAgentOutput?.('quorum-testing', reviewResponse.content)
      } else if (!/^(approve|a)$/i.test(humanResponse.trim())) {
        return false
      }
    }

    onProgress?.('  Phase 5 complete.')
    return true
  }

  private async runScalingPhase(hooks: Hooks): Promise<void> {
    hooks.onProgress?.('\n── Phase 6: Scaling Analysis ──────────────────────')

    const archPath = path.join(this.projectDir, '.quorum/context/architecture-proposal.md')
    const registryPath = path.join(this.projectDir, '.quorum/function-registry.json')
    const archDoc = existsSync(archPath) ? await readFile(archPath, 'utf-8') : ''
    const registry = existsSync(registryPath) ? await readFile(registryPath, 'utf-8') : '{}'

    const response = await this.runner.run({
      agentName: 'quorum-scaling',
      userMessage: `Analyze scaling and cost for this application at 100/1K/10K/100K users.\n\narchitecture-proposal.md:\n${archDoc.slice(0, 5000)}\n\nfunction-registry.json:\n${registry.slice(0, 3000)}`,
      projectDir: this.projectDir,
      agentsDir: this.agentsDir,
      routingTable: this.routingTable,
      onProgress: hooks.onProgress
    })
    hooks.onAgentOutput?.('quorum-scaling', response.content)
    await this.tools.execute({
      tool: 'file_write',
      path: '.quorum/context/scaling-report.md',
      content: response.content,
      mode: 'create'
    })
    hooks.onProgress?.('  Phase 6 complete.')
  }

  /** Extract a named document section from agent output and write it to .quorum/. */
  private async extractAndSaveDoc(content: string, docName: string, savePath: string): Promise<void> {
    const escaped = docName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`# ${escaped}[\\s\\S]*?(?=\\n# |$)`, 'i')
    const match = content.match(pattern)
    if (match) {
      await this.tools.execute({ tool: 'file_write', path: savePath, content: match[0], mode: 'create' })
    }
  }

  /** Parse BUG-* blocks from testing output and append them to .quorum/BUGS.md. */
  private async appendBugsToRegistry(content: string, bugsPath: string): Promise<void> {
    const { appendFile, mkdir } = await import('fs/promises')
    const bugBlocks = content.match(/---\n## BUG-[\s\S]*?---/g) ?? []
    if (bugBlocks.length === 0) return
    await mkdir(path.dirname(bugsPath), { recursive: true })
    await appendFile(bugsPath, '\n' + bugBlocks.join('\n'), 'utf-8')
  }

  /** Parse test-coverage.json block from testing output and write it to .quorum/nervous-system/. */
  private async persistTestCoverage(content: string): Promise<void> {
    const { writeFile, mkdir } = await import('fs/promises')
    const jsonMatch = content.match(/```json\n(\{[\s\S]*?"last_run"[\s\S]*?\})\n```/)
    if (!jsonMatch?.[1]) return
    try {
      JSON.parse(jsonMatch[1])
      const coveragePath = path.join(this.projectDir, '.quorum/nervous-system/test-coverage.json')
      await mkdir(path.dirname(coveragePath), { recursive: true })
      await writeFile(coveragePath, jsonMatch[1], 'utf-8')
    } catch { /* not valid JSON — skip */ }
  }

  private async saveSession(hooks: Hooks): Promise<void> {
    await this.runner.run({
      agentName: 'quorum-nervous-system',
      userMessage: `End of session ${this.sessionId}. Extract and save all decisions, actions, and reasoning from this session.`,
      projectDir: this.projectDir,
      agentsDir: this.agentsDir,
      routingTable: this.routingTable,
      onProgress: hooks.onProgress
    })

    const modelsUsed = [...new Set(
      Object.values(this.routingTable.session_routing_table)
        .map(r => `${r.provider}/${r.model}`)
    )]
    await this.ns.archivePlan(this.sessionId, 'session ended', modelsUsed)
  }

  // ── Config loading ──────────────────────────────────────────────────────────

  private async loadConfig(): Promise<QUORUMConfig> {
    // Try user-provided path first
    if (this.options.configPath && existsSync(this.options.configPath)) {
      return JSON.parse(await readFile(this.options.configPath, 'utf-8')) as QUORUMConfig
    }
    // Try standard locations in project dir
    for (const rel of CONFIG_PATHS) {
      const fullPath = path.join(this.projectDir, rel)
      if (existsSync(fullPath)) {
        return JSON.parse(await readFile(fullPath, 'utf-8')) as QUORUMConfig
      }
    }
    // Default config — works with just ANTHROPIC_API_KEY
    return this.defaultConfig()
  }

  private defaultConfig(): QUORUMConfig {
    return {
      version: '2.0',
      simplicity_mode: true,
      api_keys: {},
      auto_provider_selection: {},
      fallback_strategy: {
        on_provider_unavailable: 'try_next_in_priority_list',
        final_fallback: 'anthropic/claude-sonnet-4-6',
        on_hard_stop_message:
          'No API keys found.\n\nSet at minimum:\n  export ANTHROPIC_API_KEY=your-key\n\nGet your key at: https://console.anthropic.com'
      },
      token_budgets: {
        phase_0_foundation: 5000,
        phase_1_architecture: 40000,
        phase_2_design: 25000,
        phase_3_build_per_module: 80000,
        phase_4_integration: 30000,
        phase_5_testing: 60000,
        phase_6_scaling: 15000,
        session_total_default: 300000
      },
      loop_limits: {
        architect_validator_max_rounds: 3,
        design_loop_max_rounds: 3,
        bug_fix_max_attempts: 2,
        integration_max_rounds: 2,
        progress_threshold_percent: 5,
        semantic_similarity_threshold: 0.85
      },
      checkpoints: {
        require_human_phase_1: true,
        require_human_phase_2: true,
        require_human_phase_5: true,
        prompt_scaling_phase_6: true,
        auto_proceed_simple_projects: true
      },
      project: { name: '', description: '', team_size: 1, project_hash: '' }
    }
  }
}
