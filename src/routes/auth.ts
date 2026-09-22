import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { users } from '../db/schema';
import { requireAuth, signToken, type AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/security';
import { createLogger } from '../lib/logger';

const router = Router();
const log = createLogger('Auth');

const BCRYPT_ROUNDS = 12;
/** Compared against when no user matches, so a miss costs the same as a hit. */
const DUMMY_HASH = '$2a$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012';

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

router.post(
  '/login',
  rateLimit({
    windowMs: 15 * 60_000,
    max: 10,
    keyPrefix: 'login',
    message: 'Too many sign-in attempts. Try again in a few minutes.',
  }),
  async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const email = parsed.data.email.toLowerCase().trim();
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    // Always run a comparison so response time does not reveal whether the
    // address exists.
    const valid = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? DUMMY_HASH);

    if (!user || !valid) {
      log.warn(`Failed sign-in for ${email}`);
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    await db
      .update(users)
      .set({ lastLoginAt: Math.floor(Date.now() / 1000) })
      .where(eq(users.id, user.id));

    res.json({ token: signToken({ userId: user.id, email: user.email }), email: user.email });
  },
);

router.get('/me', requireAuth, async (req: AuthRequest, res) => {
  const [user] = await db
    .select({ id: users.id, email: users.email, role: users.role, lastLoginAt: users.lastLoginAt })
    .from(users)
    .where(eq(users.id, req.user!.userId))
    .limit(1);

  if (!user) {
    // The account was deleted while the token was still valid.
    res.status(401).json({ error: 'Account no longer exists' });
    return;
  }
  res.json(user);
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(12, 'New password must be at least 12 characters').max(200),
});

router.post('/change-password', requireAuth, async (req: AuthRequest, res) => {
  const parsed = passwordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.id, req.user!.userId)).limit(1);
  if (!user) {
    res.status(401).json({ error: 'Account no longer exists' });
    return;
  }

  if (!(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }

  await db
    .update(users)
    .set({ passwordHash: await bcrypt.hash(parsed.data.newPassword, BCRYPT_ROUNDS) })
    .where(eq(users.id, user.id));

  log.info(`Password changed for ${user.email}`);
  // Tokens are stateless, so existing ones stay valid until they expire. Say so
  // rather than implying every session was revoked.
  res.json({ ok: true, note: 'Existing sessions remain valid until their tokens expire.' });
});

router.post('/logout', (_req, res) => {
  // Stateless JWTs: the client discards the token. Kept so the SPA has a
  // single place to call, and so revocation can be added here later.
  res.json({ ok: true });
});

export default router;
