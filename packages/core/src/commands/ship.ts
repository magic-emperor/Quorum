import { writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import type { QUORUMRunOptions, RoutingTable } from '../types.js'
import { AgentRunner } from '../agent-runner.js'
import { TaskManager } from '../memory/task-manager.js'
import { PlanManager } from '../memory/plan-manager.js'
import { NervousSystem } from '../memory/nervous-system.js'

const execAsync = promisify(exec)

export async function runShip(
  projectDir: string,
  agentsDir: string,
  routingTable: RoutingTable,
  options: QUORUMRunOptions
): Promise<void> {
  const { onProgress, onCheckpoint } = options
  const draft = options.extra?.draft === 'true'

  onProgress?.('Preparing to ship...')

  const taskManager = new TaskManager(projectDir)
  const planManager = new PlanManager(projectDir)
  const nervousSystem = new NervousSystem(projectDir)

  const [taskIndex, planIndex, decisions] = await Promise.all([
    taskManager.readIndex(),
    planManager.readIndex(),
    nervousSystem.readDecisions()
  ])

  const verifyPath = path.join(projectDir, '.quorum', 'context', 'verify-report.md')
  if (!existsSync(verifyPath) && !options.auto) {
    onProgress?.('No verification report found.')
    onProgress?.('Run quorum verify first, then quorum ship.')
    return
  }

  const completedTasks = taskIndex.tasks.filter(t => t.status === 'COMPLETE').slice(-20)
  const recentDecisions = decisions.slice(-5)
  const agentRunner = new AgentRunner(projectDir)

  onProgress?.('Generating PR description...')

  const prResponse = await agentRunner.run({
    agentName: 'quorum-nervous-system',
    userMessage: `Generate a PR title and description for these changes.

Completed tasks:
${completedTasks.map(t => `- ${t.id}: ${t.title}`).join('\n')}

Key decisions made:
${recentDecisions.map(d => `- ${d.what}`).join('\n')}

Current phase: ${planIndex.current_phase}

Format your response as:
TITLE: [concise PR title in present tense, max 72 chars]

BODY:
[markdown PR body with: summary, what changed, key decisions, testing notes]`,
    projectDir,
    agentsDir,
    routingTable,
    onProgress
  })

  const titleMatch = prResponse.content.match(/TITLE:\s*(.+)/)
  const bodyMatch = prResponse.content.match(/BODY:\s*([\s\S]+)/)

  const prTitle = titleMatch?.[1]?.trim() ?? `Phase ${planIndex.current_phase} complete`
  const prBody = bodyMatch?.[1]?.trim() ?? prResponse.content

  onProgress?.('')
  onProgress?.(`PR Title: ${prTitle}`)
  onProgress?.('')

  if (!options.auto && onCheckpoint) {
    const response = await onCheckpoint({
      type: 'BLOCKER',
      title: 'Create Pull Request',
      completed: completedTasks.slice(0, 5).map(t => t.title),
      question: `Create ${draft ? 'draft ' : ''}PR with title: "${prTitle}"?`,
      options: [
        { label: 'CREATE PR', tradeoff: `Creates ${draft ? 'draft ' : ''}PR on current branch` },
        { label: 'EDIT TITLE', tradeoff: 'Type the PR title you want instead' }
      ]
    })

    if (response.toUpperCase() !== 'CREATE PR' && response !== 'A') {
      if (response.length > 5 && !response.includes('EDIT')) {
        onProgress?.(`Using title: ${response}`)
      }
    }
  }

  try {
    await execAsync('gh --version', { timeout: 3000 })
  } catch {
    onProgress?.('')
    onProgress?.('GitHub CLI (gh) not found. Install from: cli.github.com')
    onProgress?.('')
    onProgress?.('PR content saved to .quorum/context/pr-draft.md')
    const prDraftPath = path.join(projectDir, '.quorum', 'context', 'pr-draft.md')
    await writeFile(prDraftPath, `# PR: ${prTitle}\n\n${prBody}`, 'utf-8')
    return
  }

  const draftFlag = draft ? '--draft' : ''
  const bodyTempPath = path.join(projectDir, '.quorum', 'context', 'pr-body-temp.md')
  await writeFile(bodyTempPath, prBody, 'utf-8')

  try {
    const { stdout } = await execAsync(
      `gh pr create --title "${prTitle.replace(/"/g, '\\"')}" --body-file "${bodyTempPath}" ${draftFlag}`,
      { cwd: projectDir, timeout: 30000 }
    )

    onProgress?.('')
    onProgress?.(`PR created: ${stdout.trim()}`)
    onProgress?.('')
    onProgress?.(draft ? 'Draft PR created. Mark as ready when verified.' : 'PR ready for review.')

    await nervousSystem.appendAction({
      id: `a_ship_${Date.now()}`,
      type: 'action',
      what: `PR created: ${prTitle}`,
      agent: 'quorum-ship',
      status: 'completed',
      output: stdout.trim(),
      session: `ship_${Date.now()}`,
      timestamp: new Date().toISOString()
    })

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    onProgress?.(`gh pr create failed: ${error}`)
    onProgress?.('PR content saved to .quorum/context/pr-draft.md')
    const prDraftPath = path.join(projectDir, '.quorum', 'context', 'pr-draft.md')
    await writeFile(prDraftPath, `# PR: ${prTitle}\n\n${prBody}`, 'utf-8')
  }
}
