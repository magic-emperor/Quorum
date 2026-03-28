import { writeFile } from 'fs/promises'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import type { QUORUMRunOptions, RoutingTable } from '../types.js'
import { AgentRunner } from '../agent-runner.js'
import { NervousSystem } from '../memory/nervous-system.js'
import { GoalGuardian } from '../memory/goal-guardian.js'

const execAsync = promisify(exec)

export async function runReview(
  projectDir: string,
  agentsDir: string,
  routingTable: RoutingTable,
  options: QUORUMRunOptions
): Promise<void> {
  const { onProgress, onAgentOutput } = options
  const targetPath = options.description

  onProgress?.('Running code + security review...')

  const agentRunner = new AgentRunner(projectDir)
  const nervousSystem = new NervousSystem(projectDir)
  const goalGuardian = new GoalGuardian(projectDir)

  let diffContext = ''
  try {
    const { stdout } = await execAsync('git diff HEAD --stat', { cwd: projectDir, timeout: 5000 })
    diffContext = stdout
  } catch {
    diffContext = '(could not get git diff)'
  }

  let fullDiff = ''
  try {
    const { stdout } = await execAsync('git diff HEAD --unified=3', { cwd: projectDir, timeout: 10000 })
    fullDiff = stdout.slice(0, 8000)
  } catch {
    fullDiff = '(could not get full diff)'
  }

  const [goalSummary, decisions, bugRegistry] = await Promise.all([
    goalGuardian.getContextSummary(),
    nervousSystem.readDecisions(),
    nervousSystem.readBugRegistry()
  ])

  const knownBugPatterns = bugRegistry
    .map(b => `- Pattern: ${b.pattern}. Check: ${b.prevention_check}`)
    .join('\n')

  const reviewContext = `
PROJECT GOAL:
${goalSummary}

RECENT DECISIONS:
${decisions.slice(-5).map(d => `- ${d.what}`).join('\n')}

KNOWN BUG PATTERNS TO CHECK:
${knownBugPatterns || '(none recorded yet)'}

GIT DIFF SUMMARY:
${diffContext}

CHANGED CODE:
${fullDiff}

${targetPath ? `FOCUSED ON: ${targetPath}` : 'REVIEWING: all uncommitted changes'}
`

  onProgress?.('Running code quality review...')
  const codeResponse = await agentRunner.run({
    agentName: 'quorum-critic',
    userMessage: `Code review mode — review these changes for:
1. Logic errors and edge cases
2. Missing error handling
3. Performance issues
4. Consistency with project decisions
5. Known bug patterns (check the list above)

${reviewContext}`,
    projectDir,
    agentsDir,
    routingTable,
    onProgress
  })

  onAgentOutput?.('quorum-critic (code review)', codeResponse.content)

  onProgress?.('Running security review...')
  const securityResponse = await agentRunner.run({
    agentName: 'quorum-critic',
    userMessage: `Security review mode — check these changes for:
1. Injection vulnerabilities (SQL, command, XSS)
2. Authentication and authorization flaws
3. Sensitive data exposure (hardcoded keys, logging PII)
4. Missing input validation
5. OWASP Top 10 issues

${reviewContext}`,
    projectDir,
    agentsDir,
    routingTable,
    onProgress
  })

  onAgentOutput?.('quorum-critic (security review)', securityResponse.content)

  const reportPath = path.join(projectDir, '.quorum', 'context', 'review-report.md')
  const report = `# Code Review Report
Date: ${new Date().toISOString()}
${targetPath ? `Scope: ${targetPath}` : 'Scope: all uncommitted changes'}

## Code Quality Review
${codeResponse.content}

## Security Review
${securityResponse.content}

## Changes Reviewed
\`\`\`
${diffContext}
\`\`\`
`
  await writeFile(reportPath, report, 'utf-8')

  onProgress?.('')
  onProgress?.(`Review complete. Report saved to .quorum/context/review-report.md`)
}
