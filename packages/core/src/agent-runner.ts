import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import matter from 'gray-matter'
import path from 'path'
import type {
  AgentMessage,
  AgentResponse,
  ToolCall,
  RoutingTable
} from './types.js'
import { buildProvider } from './providers/index.js'
import { ToolExecutor } from './tool-executor.js'

export interface AgentRunOptions {
  agentName: string
  userMessage: string
  conversationHistory?: AgentMessage[]
  context?: Record<string, string>
  projectDir: string
  agentsDir: string
  routingTable: RoutingTable
  onProgress?: (msg: string) => void
  maxTokens?: number
}

export class AgentRunner {
  private toolExecutor: ToolExecutor

  constructor(projectDir: string) {
    this.toolExecutor = new ToolExecutor(projectDir)
  }

  async run(options: AgentRunOptions): Promise<AgentResponse> {
    const {
      agentName,
      userMessage,
      conversationHistory = [],
      context = {},
      agentsDir,
      routingTable,
      onProgress,
      maxTokens
    } = options

    // Load agent .md file as system prompt
    const systemPrompt = await this.loadAgentPrompt(agentName, agentsDir, context)

    // Resolve routing for this agent
    const routing = routingTable.session_routing_table[agentName]
    if (!routing) {
      throw new Error(
        `No routing found for agent "${agentName}". ` +
        `Check auto_provider_selection in atlas.config.json.`
      )
    }

    onProgress?.(`[${agentName}] → ${routing.provider}/${routing.model}`)

    const provider = buildProvider(routing.model, routing.provider)

    // Build message array
    const messages: AgentMessage[] = [
      ...conversationHistory,
      { role: 'user', content: userMessage }
    ]

    // Run with tool call loop (max 10 iterations)
    let response = await provider.call(messages, systemPrompt, maxTokens)

    for (let i = 0; i < 10; i++) {
      const toolCalls = this.extractToolCalls(response.content)
      if (toolCalls.length === 0) break

      // Execute all tool calls
      const toolResults: string[] = []
      for (const tc of toolCalls) {
        onProgress?.(`  tool: ${tc.tool} ${tc.path ?? tc.command ?? tc.pattern ?? ''}`)
        const result = await this.toolExecutor.execute(tc)
        toolResults.push(
          result.success
            ? `[${tc.tool} result]\n${result.output}`
            : `[${tc.tool} error]\n${result.error}`
        )
      }

      // Append assistant response + tool results and re-call
      messages.push({ role: 'assistant', content: response.content })
      messages.push({ role: 'user', content: toolResults.join('\n\n') })
      response = await provider.call(messages, systemPrompt, maxTokens)
    }

    return response
  }

  private async loadAgentPrompt(
    agentName: string,
    agentsDir: string,
    context: Record<string, string>
  ): Promise<string> {
    const agentFile = path.join(agentsDir, `${agentName}.md`)

    if (!existsSync(agentFile)) {
      throw new Error(
        `Agent file not found: ${agentFile}\n` +
        `Make sure the agents/ directory is at: ${agentsDir}`
      )
    }

    const raw = await readFile(agentFile, 'utf-8')
    const parsed = matter(raw)

    // Use markdown body (after frontmatter) as the system prompt
    let prompt = parsed.content.trim()

    // Replace any {{VARIABLE}} placeholders with context values
    for (const [key, value] of Object.entries(context)) {
      prompt = prompt.replaceAll(`{{${key}}}`, value)
    }

    return prompt
  }

  private extractToolCalls(content: string): ToolCall[] {
    const results: ToolCall[] = []

    // Match JSON objects that have a "tool" key
    // We look for { ... "tool": "..." ... } patterns
    const regex = /\{[^{}]*"tool"\s*:\s*"[^"]+[^{}]*\}/g
    let match: RegExpExecArray | null

    while ((match = regex.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[0]) as ToolCall
        if (parsed.tool) {
          results.push(parsed)
        }
      } catch {
        // JSON parse failed — not a valid tool call, skip
      }
    }

    return results
  }
}
