import { writeFile } from 'fs/promises'
import path from 'path'
import type { ATLASRunOptions, RoutingTable, MapResult } from '../types.js'
import { AgentRunner } from '../agent-runner.js'
import { NervousSystem } from '../memory/nervous-system.js'
import { ToolExecutor } from '../tool-executor.js'

export async function runMap(
  projectDir: string,
  agentsDir: string,
  routingTable: RoutingTable,
  options: ATLASRunOptions
): Promise<MapResult> {
  const { onProgress, onAgentOutput } = options
  const area = options.description ?? 'src'

  onProgress?.(`Mapping codebase: ${area}`)
  onProgress?.('Agents will read and summarize what exists — this takes a few minutes.')
  onProgress?.('')

  const agentRunner = new AgentRunner(projectDir)
  const nervousSystem = new NervousSystem(projectDir)
  const toolExecutor = new ToolExecutor(projectDir)

  const fileList = await toolExecutor.execute({
    tool: 'glob_search',
    pattern: `${area}/**/*.{ts,tsx,js,jsx,py,go,rs,java}`,
    max_results: 200
  })

  const files = fileList.output.split('\n').filter(Boolean)
  onProgress?.(`Found ${files.length} source files`)

  const byDir: Record<string, string[]> = {}
  for (const file of files) {
    const dir = path.dirname(file)
    if (!byDir[dir]) byDir[dir] = []
    byDir[dir]!.push(file)
  }

  const modules = Object.keys(byDir).slice(0, 15)

  const mapResponse = await agentRunner.run({
    agentName: 'atlas-backend-architect',
    userMessage: `CODEBASE MAPPING MODE — read and summarize this codebase.

Area: ${area}

Files found:
${files.slice(0, 50).join('\n')}
${files.length > 50 ? `... and ${files.length - 50} more files` : ''}

Directory structure:
${modules.map(d => `${d}/: ${byDir[d]?.length ?? 0} files`).join('\n')}

Your job:
1. Read the key files in each module (focus on entry points, not tests)
2. Understand: what does each module do?
3. Identify: architecture patterns, conventions, tech stack
4. Find: potential issues or technical debt

Output format:
ARCHITECTURE SUMMARY:
[2-3 paragraph overview]

MODULES:
[Module name]: [what it does, key files, patterns used]

KEY PATTERNS:
- [pattern]: [where used, why it matters]

TECH STACK CONFIRMED:
- language: [detected]
- frontend_framework: [detected]
- backend_framework: [detected]
- database: [detected]

TECHNICAL DEBT:
- [issue]: [location, impact]`,
    projectDir,
    agentsDir,
    routingTable,
    onProgress
  })

  onAgentOutput?.('atlas-backend-architect (map)', mapResponse.content)

  const outputFile = path.join(projectDir, '.atlas', 'context', 'codebase-map.md')
  const md = `# Codebase Map
Generated: ${new Date().toISOString()}
Area: ${area}
Files scanned: ${files.length}

${mapResponse.content}
`
  await writeFile(outputFile, md, 'utf-8')

  const stackMatch = mapResponse.content.match(/TECH STACK CONFIRMED:([\s\S]*?)(?:\n[A-Z]|$)/)
  if (stackMatch) {
    const stackLines = stackMatch[1]!.split('\n').filter(l => l.includes(':'))
    const stackUpdate: Record<string, string> = {}
    for (const line of stackLines) {
      const [key, val] = line.split(':').map(s => s.replace(/^[-\s*]+/, '').trim())
      if (key && val) stackUpdate[key] = val
    }
    if (Object.keys(stackUpdate).length > 0) {
      await nervousSystem.writeStack(stackUpdate as any)
      onProgress?.('Tech stack updated from map results.')
    }
  }

  const moduleLines = mapResponse.content
    .split('\n')
    .filter(l => l.match(/^[A-Z][a-z].*:/))
    .map(l => l.split(':')[0]!.trim())
    .slice(0, 10)

  onProgress?.('')
  onProgress?.(`Codebase map saved to .atlas/context/codebase-map.md`)
  onProgress?.(`Run atlas enhance to build on this existing code.`)

  return {
    area,
    files_scanned: files.length,
    modules_found: moduleLines,
    architecture_summary: 'See .atlas/context/codebase-map.md',
    key_patterns: [],
    tech_stack_confirmed: {},
    output_file: outputFile
  }
}
