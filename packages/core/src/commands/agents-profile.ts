import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import type { ATLASRunOptions, AgentInfo, RoutingTable } from '../types.js'

export async function runAgents(
  projectDir: string,
  options: ATLASRunOptions,
  routingTable: RoutingTable
): Promise<AgentInfo[]> {
  const { onProgress } = options

  const agentDefs: Array<{
    name: string
    description: string
    tools: string[]
    phase: string
  }> = [
    { name: 'atlas-orchestrator',       description: 'Master coordinator — runs the full pipeline',          tools: ['Read', 'Write', 'Glob', 'Task'], phase: 'all' },
    { name: 'atlas-classifier',         description: 'Detects SIMPLE vs COMPLEX project',                    tools: ['Read', 'Glob', 'Grep'],           phase: '0' },
    { name: 'atlas-critic',             description: 'Evidence-only assumption interceptor',                 tools: ['Read', 'Grep', 'Glob'],           phase: 'all' },
    { name: 'atlas-backend-architect',  description: 'Designs data model, APIs, architecture',               tools: ['Read', 'Write', 'Grep', 'Glob'],  phase: '1' },
    { name: 'atlas-backend-validator',  description: 'Challenges architect in confidence loop',              tools: ['Read', 'Grep'],                   phase: '1' },
    { name: 'atlas-design-architect',   description: 'Designs UI/UX with 4 variations + v0 prompts',        tools: ['Read', 'Write', 'Glob'],          phase: '2' },
    { name: 'atlas-design-validator',   description: 'Confirms design is technically buildable',             tools: ['Read', 'Grep'],                   phase: '2' },
    { name: 'atlas-frontend-builder',   description: 'Builds frontend (v0/Lovable/Claude)',                  tools: ['Read', 'Write', 'Bash', 'Glob'],  phase: '3' },
    { name: 'atlas-integration',        description: 'Connects frontend ↔ backend API contracts',           tools: ['Read', 'Write', 'Grep', 'Glob'],  phase: '4' },
    { name: 'atlas-testing',            description: 'E2E browser testing with Playwright',                  tools: ['Read', 'Write', 'Bash', 'Glob'],  phase: '5' },
    { name: 'atlas-scaling',            description: 'Cost and bottleneck analysis',                         tools: ['Read', 'Grep', 'Glob'],           phase: '6' },
    { name: 'atlas-nervous-system',     description: 'Maintains permanent project memory',                   tools: ['Read', 'Write', 'Bash', 'Glob', 'Grep'], phase: 'end' },
    { name: 'atlas-planner',            description: 'Creates implementation plan before coding',            tools: ['Read', 'Write', 'Glob'],          phase: 'pre-3' },
    { name: 'atlas-task-manager',       description: 'Manages task lifecycle and impact analysis',           tools: ['Read', 'Write', 'Glob', 'Grep'],  phase: 'all' },
  ]

  const agents: AgentInfo[] = agentDefs.map(def => {
    const routing = routingTable.session_routing_table[def.name]
    return {
      name: def.name,
      description: def.description,
      model: routing?.model ?? 'not configured',
      provider: routing?.provider ?? 'unknown',
      tools: def.tools,
      phase: def.phase,
      status: 'idle' as const
    }
  })

  onProgress?.('')
  onProgress?.('ATLAS AGENTS')
  onProgress?.('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  onProgress?.(`${'Agent'.padEnd(35)} ${'Provider'.padEnd(12)} Model`)
  onProgress?.('─'.repeat(80))

  for (const agent of agents) {
    onProgress?.(
      `${agent.name.padEnd(35)} ${agent.provider.padEnd(12)} ${agent.model}`
    )
  }

  onProgress?.('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  onProgress?.(`${agents.length} agents | ${[...new Set(agents.map(a => a.provider))].join(', ')} providers`)
  onProgress?.('')
  onProgress?.('To change models: atlas profile [fast|balanced|quality]')
  onProgress?.('To add a provider: atlas key add PROVIDER_KEY=your-key')

  return agents
}

export async function runProfile(
  profileName: string,
  projectDir: string,
  options: ATLASRunOptions
): Promise<void> {
  const { onProgress } = options

  const validProfiles = ['fast', 'balanced', 'quality']
  if (!validProfiles.includes(profileName)) {
    onProgress?.(`Unknown profile: ${profileName}`)
    onProgress?.('Available: fast | balanced | quality')
    return
  }

  const configPath = path.join(projectDir, 'atlas.config.json')
  let config: Record<string, unknown> = {}

  if (existsSync(configPath)) {
    config = JSON.parse(await readFile(configPath, 'utf-8'))
  }

  // In the new dynamic system, profile affects model_preferences
  const profileDesc: Record<string, string> = {
    fast: 'Cheaper/faster models (Groq + Gemini Flash). Lower cost, slightly lower quality on complex tasks.',
    balanced: 'Best available model auto-detected from your configured providers. (default)',
    quality: 'Best models for every agent. Higher cost. Requires multiple provider keys.'
  }

  config['_active_profile'] = profileName
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')

  onProgress?.(`Profile set to: ${profileName}`)
  onProgress?.('')
  onProgress?.(profileDesc[profileName] ?? '')

  if (profileName === 'quality') {
    onProgress?.('Note: Quality profile works best with Google AI + Anthropic + OpenAI keys all configured.')
    onProgress?.('Run: atlas key list to see what you have configured.')
  }
}
