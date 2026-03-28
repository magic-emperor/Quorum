import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import type { QUORUMRunOptions, RoutingTable } from '../types.js'
import { AgentRunner } from '../agent-runner.js'
import { NervousSystem } from '../memory/nervous-system.js'
import { TaskManager } from '../memory/task-manager.js'

// Fast path — for small tasks that don't need the full 12-agent pipeline.
// Rule: if task touches < 5 files and has no architectural impact, use fast.
// Critic still runs. task.md still updated. But no planning, no design, no E2E.

export async function runFast(
  description: string,
  projectDir: string,
  agentsDir: string,
  routingTable: RoutingTable,
  options: QUORUMRunOptions
): Promise<void> {
  const { onProgress, onAgentOutput } = options

  onProgress?.(`Fast task: ${description}`)
  onProgress?.('Skipping full pipeline — direct execution')

  const nervousSystem = new NervousSystem(projectDir)
  const taskManager = new TaskManager(projectDir)
  const agentRunner = new AgentRunner(projectDir)
  const sessionId = `fast_${Date.now()}`

  const stack = await nervousSystem.readStack()
  const taskSummary = await taskManager.getContextSummary()

  const goalPath = path.join(projectDir, '.quorum', 'goal.md')
  let goalContext = ''
  if (existsSync(goalPath)) {
    const raw = await readFile(goalPath, 'utf-8')
    goalContext = raw.slice(0, 500)
  }

  // Step 1: Critic pre-check (fast)
  onProgress?.('Running quick assumption check...')
  const criticResponse = await agentRunner.run({
    agentName: 'quorum-critic',
    userMessage: `Quick check: is this task safe to execute directly without planning?
Task: ${description}
Project goal: ${goalContext}
Stack: ${JSON.stringify(stack)}

Check:
1. Is this clearly in scope?
2. Does this require architecture changes? (if yes: output NEEDS_FULL_PIPELINE)
3. Does this touch auth, payments, or database schema? (if yes: output NEEDS_FULL_PIPELINE)
4. Can this be done in < 5 files?

Output: FAST_OK or NEEDS_FULL_PIPELINE with brief reason.`,
    projectDir,
    agentsDir,
    routingTable,
    onProgress
  })

  if (criticResponse.content.includes('NEEDS_FULL_PIPELINE')) {
    onProgress?.('')
    onProgress?.('This task needs the full pipeline — routing to quorum new...')
    onProgress?.(criticResponse.content)
    throw new Error('NEEDS_FULL_PIPELINE')
  }

  onProgress?.('Quick check passed — executing directly')

  // Step 2: Create task (minimal)
  if (!options.noSave) {
    await taskManager.createTask({
      title: description.slice(0, 60),
      status: 'IN_PROGRESS',
      phase: 'fast',
      folder_scope: 'src/',
      depends_on: [],
      keywords: description.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5),
      affects_files: [],
      description,
      milestone: 'current',
      created_in_session: sessionId
    }, sessionId)
  }

  // Step 3: Execute with backend architect (acts as general builder in fast mode)
  const buildResponse = await agentRunner.run({
    agentName: 'quorum-backend-architect',
    userMessage: `Fast execution — implement this directly:
${description}

Context:
Stack: ${JSON.stringify(stack)}
Recent tasks: ${taskSummary}

Rules for fast mode:
- Make the minimal change needed
- Touch as few files as possible
- No new dependencies unless absolutely necessary
- Write the code directly
- Report exactly which files you changed`,
    projectDir,
    agentsDir,
    routingTable,
    onProgress
  })

  onAgentOutput?.('quorum-backend-architect', buildResponse.content)

  // Step 4: Update task as complete
  if (!options.noSave) {
    const index = await taskManager.readIndex()
    const lastTask = index.tasks[index.tasks.length - 1]
    if (lastTask) {
      await taskManager.completeTask(
        lastTask.id,
        sessionId,
        `Fast execution: ${description}`,
        []
      )
    }
  }

  // Step 5: Log to nervous system
  if (!options.noSave) {
    await nervousSystem.appendAction({
      id: `a_${sessionId}_1`,
      type: 'action',
      what: `Fast task executed: ${description}`,
      agent: 'quorum-fast',
      status: 'completed',
      output: buildResponse.content.slice(0, 200),
      session: sessionId,
      timestamp: new Date().toISOString()
    })
  }

  onProgress?.('Fast task complete.')
}
