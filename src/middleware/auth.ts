import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db';
import { users } from '../db/schema';
import { roleAtLeast, type Role } from '../domain/roles';
import type { JwtPayload, SessionUser } from '../types';

const TOKEN_TTL = '7d';

export interface AuthRequest extends Request {
  user?: SessionUser;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, config().jwtSecret, { expiresIn: TOKEN_TTL, issuer: 'swoop' });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const payload = jwt.verify(token, config().jwtSecret, { issuer: 'swoop' });
    if (typeof payload === 'string') return null;
    const { userId, email, tv } = payload as Partial<JwtPayload>;
    if (!userId || !email) return null;
    return { userId, email, tv: typeof tv === 'number' ? tv : 0 };
  } catch {
    return null;
  }
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

/**
 * Loads the user behind a token, fresh from the database.
 *
 * A stateless token alone cannot be revoked and carries whatever role the
 * user had when it was issued. Reading the row on every request costs one
 * primary-key lookup against local SQLite, and in exchange a disabled user,
 * a demoted user and a changed password all take effect immediately.
 */
async function loadSessionUser(payload: JwtPayload): Promise<SessionUser | null> {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      displayName: users.displayName,
      disabled: users.disabled,
      tokenVersion: users.tokenVersion,
    })
    .from(users)
    .where(eq(users.id, payload.userId))
    .limit(1);
  if (!user || user.disabled) return null;
  if ((user.tokenVersion ?? 0) !== (payload.tv ?? 0)) return null;
  return { userId: user.id, email: user.email, role: user.role ?? 'viewer', displayName: user.displayName ?? null };
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Missing authorization token' });
    return;
  }
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  try {
    const user = await loadSessionUser(payload);
    if (!user) {
      res.status(401).json({ error: 'This session is no longer valid. Sign in again.' });
      return;
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Populates req.user when a valid token is present, without requiring one. */
export async function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction): Promise<void> {
  const token = bearerToken(req);
  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      try {
        const user = await loadSessionUser(payload);
        if (user) req.user = user;
      } catch {
        // Treated as anonymous.
      }
    }
  }
  next();
}

/** Rejects a signed-in user whose role is below `minimum`. Use after requireAuth. */
export function requireRole(minimum: Role) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Missing authorization token' });
      return;
    }
    if (!roleAtLeast(req.user.role, minimum)) {
      res.status(403).json({ error: `This needs the ${minimum} role or higher.` });
      return;
    }
    next();
  };
}

/**
 * Lets reads through for any signed-in user and requires `minimum` for
 * anything that changes state. Keeps a router's role rules in one line.
 */
export function requireRoleForWrites(minimum: Role) {
  const check = requireRole(minimum);
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }
    check(req, res, next);
  };
}
