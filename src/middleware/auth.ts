import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import type { JwtPayload } from '../types';

const TOKEN_TTL = '7d';

export interface AuthRequest extends Request {
  user?: JwtPayload;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, config().jwtSecret, { expiresIn: TOKEN_TTL, issuer: 'swoop' });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const payload = jwt.verify(token, config().jwtSecret, { issuer: 'swoop' });
    if (typeof payload === 'string') return null;
    const { userId, email } = payload as Partial<JwtPayload>;
    if (!userId || !email) return null;
    return { userId, email };
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

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
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
  req.user = payload;
  next();
}

/** Populates req.user when a valid token is present, without requiring one. */
export function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction): void {
  const token = bearerToken(req);
  if (token) {
    const payload = verifyToken(token);
    if (payload) req.user = payload;
  }
  next();
}
