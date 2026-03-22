import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import type { ATLASRunOptions, RoutingTable, DiscussResult } from '../types.js'
import { AgentRunner } from '../agent-runner.js'
import { NervousSystem } from '../memory/nervous-system.js'
import { GoalGuardian } from '../memory/goal-guardian.js'
import { TaskManager } from '../memory/task-manager.js'

/** Convert a feature description to a stable slug for file naming.
 *  e.g. "Add OAuth login" → "add-oauth-login"
 *  This allows atlas new / atlas enhance to auto-find the discuss context.
 */
function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
}

export async function runDiscuss(
  description: string,
  projectDir: string,
  agentsDir: string,
  routingTable: RoutingTable,
  options: ATLASRunOptions
): Promise<DiscussResult> {
  const { onProgress, onAgentOutput } = options

  onProgress?.(`Gathering context for: ${description}`)
  onProgress?.('This step prevents misunderstandings before planning starts.')
  onProgress?.('')

  const agentRunner = new AgentRunner(projectDir)
  const nervousSystem = new NervousSystem(projectDir)
  const goalGuardian = new GoalGuardian(projectDir)
  const taskManager = new TaskManager(projectDir)
  const sessionId = `discuss_${Date.now()}`
  const slug = toSlug(description)

  const [goalSummary, taskSummary, decisions] = await Promise.all([
    goalGuardian.getContextSummary(),
    taskManager.getContextSummary(),
    nervousSystem.readDecisions()
  ])

  const recentDecisions = decisions.slice(-5)
    .map(d => `- ${d.what} (because: ${d.why})`)
    .join('\n')

  const response = await agentRunner.run({
    agentName: 'atlas-planner',
    userMessage: `DISCUSS MODE — do not create a plan yet.

Feature to discuss: ${description}

Project context:
${goalSummary}

Recent decisions:
${recentDecisions || '(none yet)'}

Task state:
${taskSummary}

Your job in DISCUSS MODE:
1. Identify what you ALREADY KNOW from context (don't ask about these)
2. Identify the 3-5 most important unknowns that would change how this gets built
3. Ask those specific questions — nothing else
4. For each question, explain WHY the answer matters architecturally

Format:
WHAT I ALREADY KNOW:
- [fact from context]

QUESTIONS (answer these before planning):
1. [question] — Why it matters: [reason]
2. [question] — Why it matters: [reason]
3. [question] — Why it matters: [reason]`,
    projectDir,
    agentsDir,
    routingTable,
    onProgress
  })

  onAgentOutput?.('atlas-planner (discuss)', response.content)

  // Persist to slug-named file so atlas new / atlas enhance can auto-inject context
  const contextDir = path.join(projectDir, '.atlas', 'context')
  await mkdir(contextDir, { recursive: true })

  const outputFile = path.join(contextDir, `discuss-${slug}.md`)
  const md = `# Discussion: ${description}
Date: ${new Date().toISOString()}
Session: ${sessionId}
Slug: ${slug}

## Request
${description}

## Agent Analysis
${response.content}

## Human Answers
(fill these in, then run: atlas new "${description}")

---
`

  await writeFile(outputFile, md, 'utf-8')

  const questionLines = response.content
    .split('\n')
    .filter(l => /^\d+\./.test(l.trim()))
    .map(l => l.replace(/^\d+\.\s*/, '').split('—')[0]?.trim() ?? l)

  onProgress?.('')
  onProgress?.(`✓ Discussion saved to: .atlas/context/discuss-${slug}.md`)
  onProgress?.('  Fill in your answers in that file, then run:')
  onProgress?.(`  atlas new "${description}"`)
  onProgress?.('  ATLAS will automatically load your answers before planning.')

  return {
    feature: description,
    questions_asked: questionLines,
    decisions_captured: [],
    output_file: outputFile,
    ready_to_plan: questionLines.length === 0
  }
}
