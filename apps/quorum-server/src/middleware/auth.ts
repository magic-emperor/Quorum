import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env['JWT_SECRET'] ?? 'atlas-dev-secret-change-in-production'

// Access token: 1h — short-lived, used for API calls
// Refresh token: 7d — long-lived, used only to get a new access token
const ACCESS_TOKEN_TTL = '1h'
const REFRESH_TOKEN_TTL = '7d'

export interface AuthRequest extends Request {
  user?: { id: string; email: string }
}

/** Sign a short-lived access token (1h) */
export function signToken(userId: string, email: string): string {
  return jwt.sign({ id: userId, email, type: 'access' }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL })
}

/** Sign a long-lived refresh token (7d) — contains only userId, no email */
export function signRefreshToken(userId: string): string {
  return jwt.sign({ id: userId, type: 'refresh' }, JWT_SECRET, { expiresIn: REFRESH_TOKEN_TTL })
}

/** Verify a refresh token — returns payload or null if invalid/expired */
export function verifyRefreshToken(token: string): { id: string } | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { id: string; type: string }
    if (payload.type !== 'refresh') return null
    return { id: payload.id }
  } catch {
    return null
  }
}

/** Express middleware — verifies the Bearer access token on incoming requests */
export function verifyToken(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' })
    return
  }
  try {
    const token = header.slice(7)
    const payload = jwt.verify(token, JWT_SECRET) as { id: string; email: string; type?: string }
    // Reject refresh tokens used as access tokens
    if (payload.type === 'refresh') {
      res.status(401).json({ error: 'Invalid token type' })
      return
    }
    req.user = { id: payload.id, email: payload.email }
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}
