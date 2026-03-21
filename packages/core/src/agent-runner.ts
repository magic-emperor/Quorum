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

    // Build message array
    const messages: AgentMessage[] = [
      ...conversationHistory,
      { role: 'user', content: userMessage }
    ]

    // Call provider with automatic fallback on hard errors (credit/auth/quota)
    let response = await this.callWithFallback(
      messages, systemPrompt, maxTokens, routing, agentName, onProgress
    )

    // Run with tool call loop (max 10 iterations)
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
      response = await this.callWithFallback(
        messages, systemPrompt, maxTokens, routing, agentName, onProgress
      )
    }

    return response
  }

  // ─── Provider call with runtime fallback ─────────────────────────────────────
  // If the primary provider fails with a hard error (credit/auth/quota/400),
  // automatically try the next provider in fallback_chain.

  private async callWithFallback(
    messages: AgentMessage[],
    systemPrompt: string,
    maxTokens: number | undefined,
    routing: import('./types.js').ResolvedModel,
    agentName: string,
    onProgress?: (msg: string) => void
  ): Promise<AgentResponse> {
    const providersToTry = [
      { model: routing.model, provider: routing.provider },
      ...(routing.fallback_chain ?? [])
    ]

    const failures: string[] = []

    for (let i = 0; i < providersToTry.length; i++) {
      const { model, provider } = providersToTry[i]!
      try {
        const p = buildProvider(model, provider)
        return await p.call(messages, systemPrompt, maxTokens)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const status = (err as { status?: number }).status
        const isHardError = this.isHardProviderError(errMsg, status)
        const reason = this.summariseError(errMsg, status)
        const hasMore = i < providersToTry.length - 1

        if (isHardError && hasMore) {
          onProgress?.(`  ⚠ ${provider}/${model} unavailable (${reason}) — trying next...`)
          failures.push(`${provider}: ${reason}`)
          continue
        }

        if (isHardError && !hasMore) {
          // All providers exhausted — throw a clear ATLAS-formatted error
          failures.push(`${provider}: ${reason}`)
          const summary = failures.join(', ')
          throw new Error(
            `All providers failed for [${agentName}] — ${summary}.\n` +
            `Check your API keys and credit balances in atlas.config.json`
          )
        }

        // Non-retryable error (e.g. network, parsing) — rethrow as-is
        throw err
      }
    }

    throw new Error(`All providers failed for agent ${agentName}`)
  }

  private isHardProviderError(errMsg: string, status?: number): boolean {
    // Numeric HTTP status check (Anthropic SDK APIError has .status)
    if (status && [400, 401, 403, 429, 503].includes(status)) return true

    const hardPatterns = [
      'credit balance',
      'insufficient_quota',
      'billing',
      'payment required',
      'rate limit',
      'too many requests',
      'quota exceeded',
      'overloaded',
      'service unavailable',
      'invalid_request_error',
      'authentication_error'
    ]
    const lower = errMsg.toLowerCase()
    // Also match "400 " at start (Anthropic SDK formats errors as "400 {...}")
    if (/^(400|401|403|429|503)\s/.test(errMsg)) return true
    return hardPatterns.some(p => lower.includes(p))
  }

  private summariseError(errMsg: string, status?: number): string {
    if (status === 429 || errMsg.toLowerCase().includes('rate')) return 'rate limited'
    if (status === 401 || errMsg.toLowerCase().includes('auth')) return 'invalid key'
    if (status === 503 || errMsg.toLowerCase().includes('overload')) return 'overloaded'
    if (errMsg.toLowerCase().includes('credit') || errMsg.toLowerCase().includes('billing')) return 'no credits'
    if (status === 400) return 'bad request / no credits'
    return 'error'
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
