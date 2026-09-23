import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { db } from '../db';
import { invites, users } from '../db/schema';
import { hashInviteToken } from './api/users';
import { recordAudit } from '../services/audit';
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
    if (user.disabled) {
      // Only said after a correct password, so it reveals nothing to a guesser.
      log.warn(`Sign-in refused for disabled account ${email}`);
      res.status(403).json({ error: 'This account has been disabled. Ask an admin to re-enable it.' });
      return;
    }

    await db
      .update(users)
      .set({ lastLoginAt: Math.floor(Date.now() / 1000) })
      .where(eq(users.id, user.id));

    res.json({
      token: signToken({ userId: user.id, email: user.email, tv: user.tokenVersion ?? 0 }),
      email: user.email,
      role: user.role,
    });
  },
);

router.get('/me', requireAuth, async (req: AuthRequest, res) => {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      displayName: users.displayName,
      lastLoginAt: users.lastLoginAt,
    })
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

  // Bumping the token version signs out every other session: a password is
  // usually changed because someone else might know it.
  const tokenVersion = (user.tokenVersion ?? 0) + 1;
  await db
    .update(users)
    .set({ passwordHash: await bcrypt.hash(parsed.data.newPassword, BCRYPT_ROUNDS), tokenVersion })
    .where(eq(users.id, user.id));

  log.info(`Password changed for ${user.email}`);
  await recordAudit({ user: req.user, action: 'user.password_change', targetType: 'user', targetId: user.id, req });
  res.json({
    ok: true,
    token: signToken({ userId: user.id, email: user.email, tv: tokenVersion }),
    note: 'Every other session has been signed out.',
  });
});

/** Signs out every session for this account, including this one. */
router.post('/logout-everywhere', requireAuth, async (req: AuthRequest, res) => {
  const [user] = await db.select({ tokenVersion: users.tokenVersion }).from(users).where(eq(users.id, req.user!.userId)).limit(1);
  await db
    .update(users)
    .set({ tokenVersion: (user?.tokenVersion ?? 0) + 1 })
    .where(eq(users.id, req.user!.userId));
  await recordAudit({ user: req.user, action: 'user.logout_everywhere', targetType: 'user', targetId: req.user!.userId, req });
  res.json({ ok: true });
});

router.post('/logout', (_req, res) => {
  // The client discards its token; use /logout-everywhere to revoke them all.
  res.json({ ok: true });
});

// ─── Invitations ───────────────────────────────────────────────────────────────

const inviteLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 20,
  keyPrefix: 'invite-accept',
  message: 'Too many attempts. Try again in a few minutes.',
});

async function findLiveInvite(token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const now = Math.floor(Date.now() / 1000);
  const [invite] = await db
    .select()
    .from(invites)
    .where(
      and(
        eq(invites.tokenHash, hashInviteToken(token)),
        isNull(invites.acceptedAt),
        isNull(invites.revokedAt),
        gt(invites.expiresAt, now),
      ),
    )
    .limit(1);
  return invite ?? null;
}

/** What the invitation page shows before the person sets a password. */
router.get('/invite/:token', inviteLimit, async (req, res) => {
  const invite = await findLiveInvite(req.params.token);
  if (!invite) {
    res.status(404).json({ error: 'This invitation link is invalid, expired or already used.' });
    return;
  }
  res.json({ email: invite.email, role: invite.role, expiresAt: invite.expiresAt });
});

const acceptSchema = z.object({
  token: z.string().min(20).max(100),
  password: z.string().min(12, 'Password must be at least 12 characters').max(200),
  displayName: z.string().max(120).optional(),
});

router.post('/accept-invite', inviteLimit, async (req, res) => {
  const parsed = acceptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    return;
  }
  const invite = await findLiveInvite(parsed.data.token);
  if (!invite) {
    res.status(404).json({ error: 'This invitation link is invalid, expired or already used.' });
    return;
  }

  const id = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  try {
    await db.insert(users).values({
      id,
      email: invite.email,
      passwordHash: await bcrypt.hash(parsed.data.password, BCRYPT_ROUNDS),
      role: invite.role,
      displayName: parsed.data.displayName?.trim() || null,
      invitedBy: invite.createdBy,
      lastLoginAt: now,
    });
  } catch {
    res.status(409).json({ error: `${invite.email} already has an account. Sign in instead.` });
    return;
  }
  await db.update(invites).set({ acceptedAt: now }).where(eq(invites.id, invite.id));

  const sessionUser = { userId: id, email: invite.email, role: invite.role, displayName: parsed.data.displayName ?? null };
  await recordAudit({ user: sessionUser, action: 'user.invite_accept', targetType: 'user', targetId: id, detail: { role: invite.role }, req });
  log.info(`${invite.email} accepted an invitation as ${invite.role}`);
  res.json({ token: signToken({ userId: id, email: invite.email, tv: 0 }), email: invite.email, role: invite.role });
});

export default router;
