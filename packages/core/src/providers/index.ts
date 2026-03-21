import type { ATLASConfig, RoutingTable, ResolvedModel } from '../types.js'
import { AnthropicProvider } from './anthropic.js'
import { OpenAIProvider, GroqProvider, DeepSeekProvider } from './openai.js'
import { GoogleProvider } from './google.js'
import { OllamaProvider } from './local.js'
import { BaseProvider } from './base.js'

export {
  AnthropicProvider,
  OpenAIProvider,
  GroqProvider,
  DeepSeekProvider,
  GoogleProvider,
  OllamaProvider,
  BaseProvider
}

// Build the right provider instance for a given model+provider string
export function buildProvider(model: string, provider: string): BaseProvider {
  switch (provider) {
    case 'anthropic':
      return new AnthropicProvider({ model, apiKey: process.env['ANTHROPIC_API_KEY'] })
    case 'openai':
      return new OpenAIProvider({ model, apiKey: process.env['OPENAI_API_KEY'] })
    case 'groq':
      return new GroqProvider(process.env['GROQ_API_KEY'], model)
    case 'deepseek':
      return new DeepSeekProvider(process.env['DEEPSEEK_API_KEY'], model)
    case 'google':
      return new GoogleProvider({ model, apiKey: process.env['GOOGLE_AI_API_KEY'] })
    case 'local':
      return new OllamaProvider(model)
    default:
      throw new Error(`Unknown provider: "${provider}". Check atlas.config.json auto_provider_selection.`)
  }
}

// Detect which providers are available based on env vars + Ollama check
export async function detectAvailableProviders(): Promise<Set<string>> {
  const available = new Set<string>()

  if (process.env['ANTHROPIC_API_KEY']) available.add('anthropic')
  if (process.env['OPENAI_API_KEY']) available.add('openai')
  if (process.env['GOOGLE_AI_API_KEY']) available.add('google')
  if (process.env['GROQ_API_KEY']) available.add('groq')
  if (process.env['DEEPSEEK_API_KEY']) available.add('deepseek')
  if (process.env['MISTRAL_API_KEY']) available.add('mistral')
  if (process.env['V0_API_KEY']) available.add('v0')
  if (process.env['LOVABLE_API_KEY']) available.add('lovable')

  // Test local Ollama — non-blocking
  const ollamaEndpoint = process.env['LOCAL_OLLAMA_ENDPOINT'] ?? 'http://localhost:11434'
  try {
    const res = await fetch(`${ollamaEndpoint}/api/tags`, {
      signal: AbortSignal.timeout(2000)
    })
    if (res.ok) available.add('local')
  } catch {
    // Not available — skip silently
  }

  return available
}

// Build the session routing table: which agent uses which provider/model
export async function buildRoutingTable(config: ATLASConfig): Promise<RoutingTable> {
  // Copy any api_keys from config into env vars (env vars take priority)
  const keyMap: Record<string, string> = {
    'ANTHROPIC_API_KEY': config.api_keys.ANTHROPIC_API_KEY ?? '',
    'OPENAI_API_KEY': config.api_keys.OPENAI_API_KEY ?? '',
    'GOOGLE_AI_API_KEY': config.api_keys.GOOGLE_AI_API_KEY ?? '',
    'GROQ_API_KEY': config.api_keys.GROQ_API_KEY ?? '',
    'DEEPSEEK_API_KEY': config.api_keys.DEEPSEEK_API_KEY ?? '',
    'LOCAL_OLLAMA_ENDPOINT': config.api_keys.LOCAL_OLLAMA_ENDPOINT ?? ''
  }
  for (const [key, value] of Object.entries(keyMap)) {
    if (value && !process.env[key]) {
      process.env[key] = value
    }
  }

  const available = await detectAvailableProviders()

  // Require at least one provider
  if (available.size === 0) {
    throw new Error(config.fallback_strategy.on_hard_stop_message)
  }

  const table: Record<string, ResolvedModel> = {}
  const fallbacks: RoutingTable['fallbacks_triggered'] = []
  const notes: string[] = []

  const agentConfigs = config.simplicity_mode
    ? config.auto_provider_selection
    : config.advanced_config?.models
      ? Object.fromEntries(
          Object.entries(config.advanced_config.models).map(([agent, m]) => [
            agent,
            { priority: [`${m.provider}/${m.model}`] }
          ])
        )
      : config.auto_provider_selection

  for (const [agentName, cfg] of Object.entries(agentConfigs)) {
    if (agentName.startsWith('_')) continue

    let resolved: ResolvedModel | null = null

    for (const entry of cfg.priority) {
      // Entry format: "provider/model" e.g. "anthropic/claude-sonnet-4-6"
      const slashIdx = entry.indexOf('/')
      const providerName = slashIdx >= 0 ? entry.slice(0, slashIdx) : entry
      const modelName = slashIdx >= 0 ? entry.slice(slashIdx + 1) : entry

      if (available.has(providerName)) {
        resolved = {
          model: modelName,
          provider: providerName,
          reason: `${providerName} key detected — first available in priority list`
        }
        break
      }
    }

    if (!resolved) {
      // Final fallback: anthropic/claude-sonnet
      const [fbProvider, fbModel] = config.fallback_strategy.final_fallback.split('/')
      resolved = {
        model: fbModel ?? 'claude-sonnet-4-6',
        provider: fbProvider ?? 'anthropic',
        reason: 'final fallback — no priority provider available'
      }
      fallbacks.push({
        agent: agentName,
        wanted: cfg.priority[0] ?? 'none',
        using: `${resolved.provider}/${resolved.model}`,
        reason: 'no configured provider was available'
      })
    }

    table[agentName] = resolved
  }

  // Generate helpful session notes
  if (table['atlas-critic']?.provider === 'openai') {
    notes.push('Critic → GPT-4o-mini (OpenAI) — cross-company validation active.')
  }
  if (table['atlas-frontend-builder']?.provider === 'v0') {
    notes.push('Frontend builder → v0 — specialized UI generation active.')
  } else if (table['atlas-frontend-builder']?.provider === 'anthropic') {
    notes.push('Frontend builder → Claude. Tip: add V0_API_KEY for better UI generation.')
  }
  if (fallbacks.length > 0) {
    notes.push(`${fallbacks.length} agent(s) fell back to default provider.`)
  }

  return {
    session_routing_table: table,
    providers_active: Array.from(available),
    providers_unavailable: ['anthropic', 'openai', 'google', 'groq', 'deepseek', 'v0', 'lovable', 'local']
      .filter(p => !available.has(p)),
    fallbacks_triggered: fallbacks,
    session_notes: notes
  }
}
