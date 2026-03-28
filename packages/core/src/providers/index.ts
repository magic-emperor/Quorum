import type { QUORUMConfig, RoutingTable, ResolvedModel } from '../types.js'
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
export { discoverProviderModels, envVarToProvider, providerToEnvVar } from './discover.js'
export type { DiscoveryResult, DiscoveredTiers } from './discover.js'

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
      throw new Error(`Unknown provider: "${provider}". Check quorum.config.json auto_provider_selection.`)
  }
}

// Detect which providers are available based on env vars + Ollama check.
//
// explicitlyDisabled: providers where the key in quorum.config.json is ""
//   (empty string = user explicitly says "don't use this provider")
//   This takes priority over env vars so users can opt-out of system env keys.
export async function detectAvailableProviders(
  explicitlyDisabled?: Set<string>
): Promise<Set<string>> {
  const available = new Set<string>()
  const disabled = explicitlyDisabled ?? new Set<string>()

  function addIfEnabled(provider: string, envKey: string): void {
    if (disabled.has(provider)) return  // explicit empty key in config = disabled
    if (process.env[envKey]) available.add(provider)
  }

  addIfEnabled('anthropic', 'ANTHROPIC_API_KEY')
  addIfEnabled('openai',    'OPENAI_API_KEY')
  addIfEnabled('google',    'GOOGLE_AI_API_KEY')
  addIfEnabled('groq',      'GROQ_API_KEY')
  addIfEnabled('deepseek',  'DEEPSEEK_API_KEY')
  addIfEnabled('mistral',   'MISTRAL_API_KEY')
  addIfEnabled('v0',        'V0_API_KEY')
  addIfEnabled('lovable',   'LOVABLE_API_KEY')

  // Local Ollama — opt-in only (excluded from auto routing, but shown in status)
  if (!disabled.has('local')) {
    const ollamaEndpoint = process.env['LOCAL_OLLAMA_ENDPOINT'] ?? 'http://localhost:11434'
    try {
      const res = await fetch(`${ollamaEndpoint}/api/tags`, {
        signal: AbortSignal.timeout(2000)
      })
      if (res.ok) available.add('local')
    } catch {
      // Not running — skip silently
    }
  }

  return available
}

// ─── Agent tier definitions ───────────────────────────────────────────────────
// Each agent belongs to a quality tier: smart | balanced | fast
// QUORUM auto-routes agents to the best available model for their tier.

const AGENT_TIERS: Record<string, 'smart' | 'balanced' | 'fast'> = {
  'quorum-orchestrator':        'smart',
  'quorum-backend-architect':   'smart',
  'quorum-design-architect':    'smart',
  'quorum-planner':             'smart',

  'quorum-chat':                'balanced',
  'quorum-backend-builder':     'balanced',
  'quorum-frontend-builder':    'balanced',
  'quorum-integration':         'balanced',
  'quorum-testing':             'balanced',
  'quorum-nervous-system':      'balanced',
  'quorum-backend-validator':   'balanced',
  'quorum-design-validator':    'balanced',

  'quorum-coder':               'fast',
  'quorum-classifier':          'fast',
  'quorum-critic':              'fast',
  'quorum-scaling':             'fast',
  'quorum-task-manager':        'fast',
}

// ─── Default model names per provider per tier ────────────────────────────────
// These can all be overridden by model_preferences in quorum.config.json.

interface ProviderModels {
  smart: string
  balanced: string
  fast: string
}

const PROVIDER_DEFAULTS: Record<string, ProviderModels> = {
  google: {
    smart:    'gemini-2.5-pro',
    balanced: 'gemini-2.0-flash-001',
    fast:     'gemini-2.0-flash-001',
  },
  anthropic: {
    smart:    'claude-opus-4-6',
    balanced: 'claude-sonnet-4-6',
    fast:     'claude-haiku-4-5-20251001',
  },
  openai: {
    smart:    'gpt-4o',
    balanced: 'gpt-4o',
    fast:     'gpt-4o-mini',
  },
  groq: {
    smart:    'llama-3.3-70b-versatile',
    balanced: 'llama-3.3-70b-versatile',
    fast:     'llama-3.3-70b-versatile',
  },
  deepseek: {
    smart:    'deepseek-chat',
    balanced: 'deepseek-chat',
    fast:     'deepseek-chat',
  },
  local: {
    smart:    'llama3',
    balanced: 'llama3',
    fast:     'llama3',
  },
}

// ─── Provider preference order by tier ──────────────────────────────────────
// This is the ranking order when building a fallback chain.
// All available providers will be included — this just controls order.

const TIER_ORDER: Record<'smart' | 'balanced' | 'fast', string[]> = {
  smart:    ['anthropic', 'openai', 'google', 'groq', 'deepseek'],
  balanced: ['openai', 'google', 'anthropic', 'groq', 'deepseek'],
  fast:     ['groq', 'google', 'openai', 'anthropic', 'deepseek'],
}

// ─── Resolve model name for a provider at a given tier ───────────────────────

function resolveModel(
  provider: string,
  tier: 'smart' | 'balanced' | 'fast',
  prefs?: QUORUMConfig['model_preferences']
): string {
  // Check user overrides first
  if (prefs) {
    const key = `${provider}_${tier}` as keyof typeof prefs
    const override = prefs[key]
    if (override) return override
  }

  // Fall back to hardcoded defaults
  return PROVIDER_DEFAULTS[provider]?.[tier] ?? 'default'
}

// ─── Build routing table ─────────────────────────────────────────────────────

export async function buildRoutingTable(config: QUORUMConfig): Promise<RoutingTable> {
  // 1. Promote api_keys from config into process.env
  //    (env vars already set take priority — we never overwrite them)
  const keyMap: Record<string, string | undefined> = {
    'ANTHROPIC_API_KEY':    config.api_keys.ANTHROPIC_API_KEY,
    'OPENAI_API_KEY':       config.api_keys.OPENAI_API_KEY,
    'GOOGLE_AI_API_KEY':    config.api_keys.GOOGLE_AI_API_KEY,
    'GROQ_API_KEY':         config.api_keys.GROQ_API_KEY,
    'DEEPSEEK_API_KEY':     config.api_keys.DEEPSEEK_API_KEY,
    'LOCAL_OLLAMA_ENDPOINT': config.api_keys.LOCAL_OLLAMA_ENDPOINT,
    'V0_API_KEY':           config.api_keys.V0_API_KEY,
    'LOVABLE_API_KEY':      config.api_keys.LOVABLE_API_KEY,
  }
  for (const [envVar, configVal] of Object.entries(keyMap)) {
    // Only set from config if NOT already in environment
    if (configVal && !process.env[envVar]) {
      process.env[envVar] = configVal
    }
  }

  // 2. Build the "explicitly disabled" set:
  //    any provider whose key is set to "" in quorum.config.json is excluded,
  //    even if the env var is set (e.g. ANTHROPIC_API_KEY in system environment)
  const explicitlyDisabled = new Set<string>()
  const apiKeys = config.api_keys
  if (apiKeys.ANTHROPIC_API_KEY === '')    explicitlyDisabled.add('anthropic')
  if (apiKeys.OPENAI_API_KEY === '')       explicitlyDisabled.add('openai')
  if (apiKeys.GOOGLE_AI_API_KEY === '')    explicitlyDisabled.add('google')
  if (apiKeys.GROQ_API_KEY === '')         explicitlyDisabled.add('groq')
  if (apiKeys.DEEPSEEK_API_KEY === '')     explicitlyDisabled.add('deepseek')
  if (apiKeys.MISTRAL_API_KEY === '')      explicitlyDisabled.add('mistral')
  if (apiKeys.V0_API_KEY === '')           explicitlyDisabled.add('v0')
  if (apiKeys.LOVABLE_API_KEY === '')      explicitlyDisabled.add('lovable')

  // 3. Detect which providers are actually available
  const available = await detectAvailableProviders(explicitlyDisabled)

  if (available.size === 0) {
    const msg = config.fallback_strategy.on_hard_stop_message
    throw new Error(msg)
  }

  const table: Record<string, ResolvedModel> = {}
  const fallbacks: RoutingTable['fallbacks_triggered'] = []
  const notes: string[] = []
  const prefs = config.model_preferences

  // 3. Get all agent names: from AGENT_TIERS + any manual overrides
  const allAgentNames = new Set([
    ...Object.keys(AGENT_TIERS),
    ...Object.keys(config.auto_provider_selection ?? {}),
  ])

  for (const agentName of allAgentNames) {
    if (agentName.startsWith('_')) continue

    // 3a. Check if the user has a manual override for this agent
    const manualOverride = config.auto_provider_selection?.[agentName]
    if (manualOverride && !manualOverride._why?.includes('auto')) {
      // Use the manual priority list as-is
      let resolved: ResolvedModel | null = null
      const chain: Array<{ model: string; provider: string }> = []

      for (const entry of manualOverride.priority) {
        const slashIdx = entry.indexOf('/')
        const prov = slashIdx >= 0 ? entry.slice(0, slashIdx) : entry
        const mod  = slashIdx >= 0 ? entry.slice(slashIdx + 1) : entry
        if (available.has(prov)) {
          if (!resolved) {
            resolved = { model: mod, provider: prov, reason: `manual override in config` }
          } else {
            chain.push({ model: mod, provider: prov })
          }
        }
      }

      if (resolved) {
        resolved.fallback_chain = chain
        table[agentName] = resolved
        continue
      }
      // Manual override has no available providers — fall through to dynamic
    }

    // 3b. Dynamic routing: build priority list from all available providers
    const tier = AGENT_TIERS[agentName] ?? 'balanced'
    const orderedProviders = TIER_ORDER[tier]
      .filter(p => available.has(p))  // only providers user actually has

    if (orderedProviders.length === 0) {
      // Shouldn't happen since we checked available.size > 0, but guard anyway
      continue
    }

    const primary = orderedProviders[0]!
    const primaryModel = resolveModel(primary, tier, prefs)
    const resolved: ResolvedModel = {
      model: primaryModel,
      provider: primary,
      reason: `auto-routed: ${tier} tier, best available provider`,
      fallback_chain: orderedProviders.slice(1).map(p => ({
        provider: p,
        model: resolveModel(p, tier, prefs)
      }))
    }

    table[agentName] = resolved
  }

  // 4. Generate session notes
  const availableList = Array.from(available)
  notes.push(`Active providers: ${availableList.join(', ')}`)

  const smartProvider = table['quorum-orchestrator']
  if (smartProvider) {
    notes.push(`Smart tier (orchestrator/planner): ${smartProvider.provider}/${smartProvider.model}`)
  }
  const fastProvider = table['quorum-classifier']
  if (fastProvider) {
    notes.push(`Fast tier (classifier/critic): ${fastProvider.provider}/${fastProvider.model}`)
  }

  return {
    session_routing_table: table,
    providers_active: availableList,
    providers_unavailable: ['anthropic', 'openai', 'google', 'groq', 'deepseek', 'v0', 'lovable', 'local']
      .filter(p => !available.has(p)),
    fallbacks_triggered: fallbacks,
    session_notes: notes
  }
}
