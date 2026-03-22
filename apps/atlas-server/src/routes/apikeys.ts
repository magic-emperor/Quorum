import { Router } from 'express'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { db } from '../db/schema.js'
import { encryptKey, decryptKey } from '../db/crypto.js'
import { verifyToken, type AuthRequest } from '../middleware/auth.js'

export const apiKeysRouter = Router()

const AddKeySchema = z.object({
  provider: z.enum([
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_AI_API_KEY',
    'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY'
  ]),
  key: z.string().min(10)
})

// GET /api/keys — list user's configured providers (masked)
apiKeysRouter.get('/', verifyToken, (req: AuthRequest, res) => {
  const keys = db.prepare(`
    SELECT id, provider, created_at FROM api_keys WHERE user_id = ?
  `).all(req.user!.id) as Array<{ id: string; provider: string; created_at: string }>

  res.json({
    keys: keys.map(k => ({
      id: k.id,
      provider: k.provider,
      masked: `****${k.provider.slice(-4)}`, // shows last 4 chars of provider name
      created_at: k.created_at
    }))
  })
})

// POST /api/keys — add or update an API key
apiKeysRouter.post('/', verifyToken, (req: AuthRequest, res) => {
  const parsed = AddKeySchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() })
    return
  }

  const { provider, key } = parsed.data
  const encrypted = encryptKey(key)
  const id = nanoid()

  db.prepare(`
    INSERT INTO api_keys (id, user_id, provider, encrypted_key)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      encrypted_key = excluded.encrypted_key,
      created_at = datetime('now')
  `).run(id, req.user!.id, provider, encrypted)

  res.json({ ok: true, provider })
})

// DELETE /api/keys/:provider — remove a key
apiKeysRouter.delete('/:provider', verifyToken, (req: AuthRequest, res) => {
  const result = db.prepare(
    'DELETE FROM api_keys WHERE user_id = ? AND provider = ?'
  ).run(req.user!.id, req.params['provider'])

  if (result.changes === 0) {
    res.status(404).json({ error: 'Key not found' })
    return
  }
  res.json({ ok: true })
})

/** Helper used by session-runner to get all decrypted keys for a user */
export function getUserApiKeys(userId: string): Record<string, string> {
  const keys = db.prepare(
    'SELECT provider, encrypted_key FROM api_keys WHERE user_id = ?'
  ).all(userId) as Array<{ provider: string; encrypted_key: string }>

  return Object.fromEntries(
    keys.map(k => [k.provider, decryptKey(k.encrypted_key)])
  )
}
