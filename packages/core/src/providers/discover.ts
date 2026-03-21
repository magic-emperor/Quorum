/**
 * Provider model discovery
 *
 * When a user adds an API key, ATLAS can call this module to:
 *  1. Validate the key works
 *  2. Discover what models are available
 *  3. Suggest the best model per quality tier (smart / balanced / fast)
 *
 * This removes any requirement for users to know model names/versions.
 */

export interface DiscoveredTiers {
  smart: string
  balanced: string
  fast: string
  allModels: string[]
}

export interface DiscoveryResult {
  provider: string
  success: boolean
  tiers?: DiscoveredTiers
  error?: string
  message: string
}

// ─── Google AI (Gemini) ───────────────────────────────────────────────────────

async function discoverGoogle(apiKey: string): Promise<DiscoveryResult> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText)
      return {
        provider: 'google',
        success: false,
        error: `${res.status} ${body}`,
        message: `Google AI key rejected (${res.status}) — check key at https://aistudio.google.com/app/apikey`
      }
    }

    const data = await res.json() as { models: Array<{ name: string; supportedGenerationMethods: string[] }> }
    const generateModels = (data.models ?? [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name.replace('models/', ''))

    // Tier assignment — best available from discovered models
    const smart    = pickFirst(generateModels, ['gemini-2.5-pro', 'gemini-2.0-flash-001', 'gemini-2.0-flash']) ?? generateModels[0] ?? 'gemini-2.0-flash-001'
    const balanced = pickFirst(generateModels, ['gemini-2.0-flash-001', 'gemini-2.0-flash', 'gemini-2.5-flash']) ?? generateModels[0] ?? 'gemini-2.0-flash-001'
    const fast     = pickFirst(generateModels, ['gemini-2.0-flash-001', 'gemini-2.0-flash', 'gemini-2.5-flash']) ?? generateModels[0] ?? 'gemini-2.0-flash-001'

    return {
      provider: 'google',
      success: true,
      tiers: { smart, balanced, fast, allModels: generateModels },
      message: `Google AI ready — smart: ${smart}, balanced: ${balanced}, fast: ${fast} (${generateModels.length} models available)`
    }
  } catch (err) {
    return {
      provider: 'google',
      success: false,
      error: err instanceof Error ? err.message : String(err),
      message: 'Google AI discovery failed — check your internet connection'
    }
  }
}

// ─── Anthropic (Claude) ───────────────────────────────────────────────────────
// Anthropic does not have a public /models endpoint — use known model list.

async function discoverAnthropic(apiKey: string): Promise<DiscoveryResult> {
  // Test the key with a minimal request
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      signal: AbortSignal.timeout(10000)
    })

    if (res.status === 401) {
      return {
        provider: 'anthropic',
        success: false,
        error: '401 Unauthorized',
        message: 'Anthropic key invalid — get a key at https://console.anthropic.com'
      }
    }

    if (res.status === 402 || res.status === 400) {
      // Key valid but no credits
      return {
        provider: 'anthropic',
        success: false,
        error: `${res.status} no credits`,
        message: 'Anthropic key valid but account has no credits — add credits at https://console.anthropic.com/settings/billing'
      }
    }

    // Use known Anthropic model list
    const smart    = 'claude-opus-4-6'
    const balanced = 'claude-sonnet-4-6'
    const fast     = 'claude-haiku-4-5-20251001'

    if (res.ok) {
      const data = await res.json() as { data?: Array<{ id: string }> }
      const modelIds = (data.data ?? []).map(m => m.id)
      const actualSmart    = pickFirst(modelIds, ['claude-opus-4-6', 'claude-3-opus-20240229']) ?? smart
      const actualBalanced = pickFirst(modelIds, ['claude-sonnet-4-6', 'claude-3-5-sonnet-20241022']) ?? balanced
      const actualFast     = pickFirst(modelIds, ['claude-haiku-4-5-20251001', 'claude-3-haiku-20240307']) ?? fast

      return {
        provider: 'anthropic',
        success: true,
        tiers: { smart: actualSmart, balanced: actualBalanced, fast: actualFast, allModels: modelIds },
        message: `Anthropic ready — smart: ${actualSmart}, balanced: ${actualBalanced}, fast: ${actualFast}`
      }
    }

    return {
      provider: 'anthropic',
      success: true,
      tiers: { smart, balanced, fast, allModels: [smart, balanced, fast] },
      message: `Anthropic ready — smart: ${smart}, balanced: ${balanced}, fast: ${fast}`
    }
  } catch (err) {
    return {
      provider: 'anthropic',
      success: false,
      error: err instanceof Error ? err.message : String(err),
      message: 'Anthropic discovery failed — check your internet connection'
    }
  }
}

// ─── OpenAI (GPT) ─────────────────────────────────────────────────────────────

async function discoverOpenAI(apiKey: string): Promise<DiscoveryResult> {
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000)
    })

    if (res.status === 401) {
      return {
        provider: 'openai',
        success: false,
        error: '401',
        message: 'OpenAI key invalid — get a key at https://platform.openai.com/api-keys'
      }
    }

    if (!res.ok) {
      return {
        provider: 'openai',
        success: false,
        error: `${res.status}`,
        message: `OpenAI rejected key (${res.status})`
      }
    }

    const data = await res.json() as { data: Array<{ id: string }> }
    const modelIds = data.data.map(m => m.id).filter(id =>
      id.startsWith('gpt-4') || id.startsWith('gpt-3')
    )

    const smart    = pickFirst(modelIds, ['gpt-4o', 'gpt-4-turbo', 'gpt-4'])     ?? 'gpt-4o'
    const balanced = pickFirst(modelIds, ['gpt-4o', 'gpt-4-turbo'])               ?? 'gpt-4o'
    const fast     = pickFirst(modelIds, ['gpt-4o-mini', 'gpt-3.5-turbo'])        ?? 'gpt-4o-mini'

    return {
      provider: 'openai',
      success: true,
      tiers: { smart, balanced, fast, allModels: modelIds },
      message: `OpenAI ready — smart: ${smart}, balanced: ${balanced}, fast: ${fast}`
    }
  } catch (err) {
    return {
      provider: 'openai',
      success: false,
      error: err instanceof Error ? err.message : String(err),
      message: 'OpenAI discovery failed — check your internet connection'
    }
  }
}

// ─── Groq ─────────────────────────────────────────────────────────────────────

async function discoverGroq(apiKey: string): Promise<DiscoveryResult> {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000)
    })

    if (res.status === 401) {
      return {
        provider: 'groq',
        success: false,
        error: '401',
        message: 'Groq key invalid — get a free key at https://console.groq.com'
      }
    }

    if (!res.ok) {
      return {
        provider: 'groq',
        success: false,
        error: `${res.status}`,
        message: `Groq rejected key (${res.status})`
      }
    }

    const data = await res.json() as { data: Array<{ id: string }> }
    const modelIds = data.data.map(m => m.id)

    // Groq is for speed — no real "smart" tier difference, pick best available
    const fast     = pickFirst(modelIds, ['llama-3.3-70b-versatile', 'llama-3.1-70b-versatile', 'mixtral-8x7b-32768']) ?? 'llama-3.3-70b-versatile'
    const balanced = fast  // Groq models are all fast

    return {
      provider: 'groq',
      success: true,
      tiers: { smart: fast, balanced, fast, allModels: modelIds },
      message: `Groq ready — using: ${fast} (${modelIds.length} models available, all optimized for speed)`
    }
  } catch (err) {
    return {
      provider: 'groq',
      success: false,
      error: err instanceof Error ? err.message : String(err),
      message: 'Groq discovery failed — check your internet connection'
    }
  }
}

// ─── DeepSeek ─────────────────────────────────────────────────────────────────

async function discoverDeepSeek(apiKey: string): Promise<DiscoveryResult> {
  try {
    const res = await fetch('https://api.deepseek.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000)
    })

    if (res.status === 401) {
      return {
        provider: 'deepseek',
        success: false,
        error: '401',
        message: 'DeepSeek key invalid — get a key at https://platform.deepseek.com'
      }
    }

    const fast     = 'deepseek-chat'
    const balanced = 'deepseek-chat'
    const smart    = 'deepseek-reasoner'

    return {
      provider: 'deepseek',
      success: res.ok,
      tiers: { smart, balanced, fast, allModels: [smart, balanced] },
      message: res.ok
        ? `DeepSeek ready — smart: ${smart}, balanced/fast: ${fast}`
        : `DeepSeek key issue (${res.status})`
    }
  } catch (err) {
    return {
      provider: 'deepseek',
      success: false,
      error: err instanceof Error ? err.message : String(err),
      message: 'DeepSeek discovery failed'
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Map an env var name to a provider slug */
export function envVarToProvider(envVarName: string): string | null {
  const map: Record<string, string> = {
    'ANTHROPIC_API_KEY':    'anthropic',
    'OPENAI_API_KEY':       'openai',
    'GOOGLE_AI_API_KEY':    'google',
    'GROQ_API_KEY':         'groq',
    'DEEPSEEK_API_KEY':     'deepseek',
    'MISTRAL_API_KEY':      'mistral',
    'V0_API_KEY':           'v0',
    'LOVABLE_API_KEY':      'lovable',
    'LOCAL_OLLAMA_ENDPOINT':'local',
  }
  return map[envVarName.toUpperCase()] ?? null
}

/** Map a provider slug to its config api_keys field name */
export function providerToEnvVar(provider: string): string | null {
  const map: Record<string, string> = {
    'anthropic': 'ANTHROPIC_API_KEY',
    'openai':    'OPENAI_API_KEY',
    'google':    'GOOGLE_AI_API_KEY',
    'groq':      'GROQ_API_KEY',
    'deepseek':  'DEEPSEEK_API_KEY',
    'mistral':   'MISTRAL_API_KEY',
    'v0':        'V0_API_KEY',
    'lovable':   'LOVABLE_API_KEY',
    'local':     'LOCAL_OLLAMA_ENDPOINT',
  }
  return map[provider.toLowerCase()] ?? null
}

/** Discover available models for a provider given an API key */
export async function discoverProviderModels(
  provider: string,
  apiKey: string
): Promise<DiscoveryResult> {
  switch (provider.toLowerCase()) {
    case 'google':    return discoverGoogle(apiKey)
    case 'anthropic': return discoverAnthropic(apiKey)
    case 'openai':    return discoverOpenAI(apiKey)
    case 'groq':      return discoverGroq(apiKey)
    case 'deepseek':  return discoverDeepSeek(apiKey)
    default:
      return {
        provider,
        success: false,
        message: `No discovery available for provider "${provider}" — add model names manually in model_preferences`
      }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pickFirst(available: string[], preferred: string[]): string | undefined {
  for (const p of preferred) {
    if (available.includes(p)) return p
  }
  // Not found in exact list — try substring match
  for (const p of preferred) {
    const match = available.find(a => a.includes(p.split('-')[0]!))
    if (match) return match
  }
  // Return first available as last resort
  return available[0]
}
