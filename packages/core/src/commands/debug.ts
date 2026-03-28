import { writeFile } from 'fs/promises'
import path from 'path'
import type { QUORUMRunOptions, RoutingTable } from '../types.js'
import { AgentRunner } from '../agent-runner.js'
import { NervousSystem } from '../memory/nervous-system.js'
import { TaskManager } from '../memory/task-manager.js'

export async function runDebug(
  description: string,
  projectDir: string,
  agentsDir: string,
  routingTable: RoutingTable,
  options: QUORUMRunOptions
): Promise<void> {
  const { onProgress, onAgentOutput, onCheckpoint } = options

  onProgress?.(`Debugging: ${description}`)
  onProgress?.('')

  const agentRunner = new AgentRunner(projectDir)
  const nervousSystem = new NervousSystem(projectDir)
  const taskManager = new TaskManager(projectDir)
  const sessionId = `debug_${Date.now()}`

  const bugRegistry = await nervousSystem.readBugRegistry()
  const knownPatterns = bugRegistry
    .map(b => `Pattern: ${b.pattern ?? 'unknown'} | Category: ${b.category ?? 'unknown'}`)
    .slice(-10)
    .join('\n')

  const matchingBugs = bugRegistry.filter(b =>
    (b.category && description.toLowerCase().includes(b.category)) ||
    description.toLowerCase().split(' ').some(w => b.pattern?.toLowerCase().includes(w))
  )

  if (matchingBugs.length > 0) {
    onProgress?.(`Known bug pattern match found:`)
    matchingBugs.forEach(b => onProgress?.(`  - ${b.pattern}: ${b.prevention_check}`))
    onProgress?.('')
  }

  await taskManager.createTask({
    title: `Debug: ${description.slice(0, 50)}`,
    status: 'IN_PROGRESS',
    phase: 'debug',
    folder_scope: 'src/',
    depends_on: [],
    keywords: ['debug', 'fix', ...description.toLowerCase().split(' ').filter(w => w.length > 4).slice(0, 3)],
    affects_files: [],
    description: `Debugging: ${description}`,
    milestone: 'current',
    created_in_session: sessionId
  }, sessionId)

  let debugResolved = false
  let attempt = 0
  const maxAttempts = 3
  let lastDebugContent = ''

  while (!debugResolved && attempt < maxAttempts) {
    attempt++
    onProgress?.(`Debug attempt ${attempt}/${maxAttempts}...`)

    const debugResponse = await agentRunner.run({
      agentName: 'quorum-backend-architect',
      userMessage: `DEBUGGING MODE — systematic bug investigation.

Bug description: ${description}
Attempt: ${attempt} of ${maxAttempts}

${matchingBugs.length > 0 ? `Similar known bugs:
${matchingBugs.map(b => `- ${b.pattern}: ${b.prevention_check}`).join('\n')}
` : ''}

Known bug patterns to check:
${knownPatterns || '(none)'}

Investigation steps:
1. Read error message or symptom carefully
2. Trace the code path that leads to this error
3. Identify the root cause (not just symptoms)
4. Propose a specific fix
5. Verify the fix doesn't break related code

Output:
ROOT CAUSE: [exact root cause]
FIX: [exact code change needed]
FILES: [which files to change]
VERIFY: [how to confirm the fix worked]
PREVENTION: [what to check in future to avoid this]`,
      projectDir,
      agentsDir,
      routingTable,
      onProgress
    })

    lastDebugContent = debugResponse.content
    onAgentOutput?.(`quorum-backend-architect (debug attempt ${attempt})`, debugResponse.content)

    const hasRootCause = debugResponse.content.includes('ROOT CAUSE:')
    const hasFix = debugResponse.content.includes('FIX:')

    if (hasRootCause && hasFix) {
      onProgress?.('Root cause identified and fix proposed.')

      if (!options.auto && onCheckpoint) {
        const rootCauseMatch = debugResponse.content.match(/ROOT CAUSE:\s*(.+)/)

        const response = await onCheckpoint({
          type: 'BLOCKER',
          title: 'Debug — Apply Fix?',
          completed: [`Attempt ${attempt}: root cause found`],
          question: `Root cause: ${rootCauseMatch?.[1]?.trim() ?? 'see agent output'}\n\nApply the proposed fix?`,
          options: [
            { label: 'APPLY FIX', tradeoff: 'Agent applies the fix directly' },
            { label: 'SHOW ME THE FIX', tradeoff: 'Show the fix without applying' }
          ],
          supportingDoc: '.quorum/BUGS.md'
        })

        if (response.toUpperCase().includes('APPLY') || response === 'A') {
          await agentRunner.run({
            agentName: 'quorum-backend-architect',
            userMessage: `Apply this fix:
${debugResponse.content}

Apply the exact fix described. Change only what is needed. Nothing more.`,
            projectDir,
            agentsDir,
            routingTable,
            onProgress
          })
          debugResolved = true
        }
      } else {
        debugResolved = true
      }
    }

    if (!debugResolved && attempt < maxAttempts) {
      onProgress?.('Digging deeper...')
    }
  }

  const preventionMatch = lastDebugContent.match(/PREVENTION:\s*(.+)/)
  if (preventionMatch) {
    await nervousSystem.appendBug({
      id: `bug-${sessionId}`,
      description: description,
      severity: 'medium',
      status: debugResolved ? 'FIXED' : 'ESCALATED',
      root_cause: lastDebugContent.match(/ROOT CAUSE:\s*(.+)/)?.[1] ?? 'Unknown',
      fix_applied: debugResolved ? 'Applied in debug session' : undefined,
      session: sessionId,
      found_by: 'quorum-debug'
    })
  }

  if (!debugResolved) {
    onProgress?.('')
    onProgress?.('Could not resolve automatically after 3 attempts.')
    onProgress?.('Check .quorum/BUGS.md for full diagnosis.')
    onProgress?.('The debug session has been saved — review agent output above.')
  }
}
