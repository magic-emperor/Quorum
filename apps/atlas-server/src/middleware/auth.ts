import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env['JWT_SECRET'] ?? 'atlas-dev-secret-change-in-production'

export interface AuthRequest extends Request {
  user?: { id: string; email: string }
}

export function signToken(userId: string, email: string): string {
  return jwt.sign({ id: userId, email }, JWT_SECRET, { expiresIn: '24h' })
}

export function verifyToken(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' })
    return
  }
  try {
    const token = header.slice(7)
    const payload = jwt.verify(token, JWT_SECRET) as { id: string; email: string }
    req.user = payload
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}
