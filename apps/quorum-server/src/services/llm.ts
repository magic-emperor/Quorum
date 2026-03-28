/**
 * Shared LLM caller for quorum-server routes.
 *
 * Priority order: Groq → Google → OpenAI → Anthropic → DeepSeek
 * - Checks user's stored keys first (api_keys table)
 * - Falls back to process.env (populated from quorum.config.json at startup)
 * - Supports any provider the user has configured — no hardcoding
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { buildRoutingTable } from '@quorum/core'
import type { QUORUMConfig } from '@quorum/core'
import { db } from '../db/schema.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Walk up from compiled dist/ to find quorum.config.json at repo root
function loadAtlasConfig(): QUORUMConfig | null {
  const candidates = [
    resolve(__dirname, '..', '..', '..', '..', 'quorum.config.json'),  // apps/quorum-server/dist/services → repo root
    resolve(__dirname, '..', '..', '..', '..', '..', 'quorum.config.json'),
    resolve(process.cwd(), 'quorum.config.json'),
    resolve(process.cwd(), '..', '..', 'quorum.config.json'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf-8')) as QUORUMConfig } catch { /* ignore */ }
    }
  }
  return null
}

let keysPromoted = false

/**
 * Called once at server startup.
 * Reads quorum.config.json and promotes all API keys into process.env
 * so every subsequent request can find them via process.env.
 */
export async function promoteAtlasKeys(): Promise<void> {
  if (keysPromoted) return
  const cfg = loadAtlasConfig()
  if (cfg) {
    try {
      await buildRoutingTable(cfg)   // side-effect: sets process.env keys from config
    } catch { /* no providers available yet — fine, user will add keys */ }
  }
  keysPromoted = true
}

// ── Provider priority ─────────────────────────────────────────────────────────

const PROVIDER_PRIORITY = [
  { provider: 'groq',      envVar: 'GROQ_API_KEY',      model: 'llama-3.3-70b-versatile' },
  { provider: 'google',    envVar: 'GOOGLE_AI_API_KEY',  model: 'gemini-2.0-flash-001'    },
  { provider: 'openai',    envVar: 'OPENAI_API_KEY',     model: 'gpt-4o-mini'             },
  { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY',  model: 'claude-haiku-4-5-20251001'},
  { provider: 'deepseek',  envVar: 'DEEPSEEK_API_KEY',   model: 'deepseek-chat'           },
] as const

/**
 * Call any available LLM with a plain prompt.
 * Checks the user's stored keys first, then falls back to env vars set
 * from quorum.config.json.
 */
export async function callLLM(userId: string, prompt: string): Promise<string> {
  await promoteAtlasKeys()

  // User's stored keys (keyed by provider name)
  const rows = db.prepare(
    'SELECT provider, encrypted_key FROM api_keys WHERE user_id = ?'
  ).all(userId) as Array<{ provider: string; encrypted_key: string }>

  const userKeys: Record<string, string> = {}
  for (const row of rows) {
    if (row.encrypted_key) userKeys[row.provider] = row.encrypted_key
  }

  for (const { provider, envVar, model } of PROVIDER_PRIORITY) {
    const apiKey = userKeys[provider] ?? process.env[envVar]
    if (!apiKey) continue
    return callProvider(provider, model, apiKey, prompt)
  }

  throw new Error(
    'No API key available. Add a key in Settings or configure quorum.config.json.'
  )
}

// ── Per-provider call implementations ────────────────────────────────────────

async function callProvider(
  provider: string,
  model: string,
  apiKey: string,
  prompt: string
): Promise<string> {

  // OpenAI-compatible: Groq, OpenAI, DeepSeek
  if (provider === 'groq' || provider === 'openai' || provider === 'deepseek') {
    const baseURL =
      provider === 'groq'     ? 'https://api.groq.com/openai/v1' :
      provider === 'deepseek' ? 'https://api.deepseek.com/v1'    :
                                'https://api.openai.com/v1'

    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1024
      })
    })
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>
      error?: { message: string }
    }
    if (data.error) throw new Error(`${provider}: ${data.error.message}`)
    return data.choices?.[0]?.message?.content ?? ''
  }

  // Google Gemini
  if (provider === 'google') {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      }
    )
    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      error?: { message: string }
    }
    if (data.error) throw new Error(`google: ${data.error.message}`)
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  }

  // Anthropic
  if (provider === 'anthropic') {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey })
    const msg = await client.messages.create({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    })
    const block = msg.content[0]
    return block && block.type === 'text' ? block.text : ''
  }

  throw new Error(`Unsupported provider: ${provider}`)
}
