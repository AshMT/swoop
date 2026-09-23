import { Router } from 'express';
import { createHash, randomBytes } from 'crypto';
import { and, desc, eq, isNull, gt, lt, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { db } from '../../db';
import { auditLog, invites, users } from '../../db/schema';
import { ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS } from '../../domain/roles';
import { requireAuth, requireRole, type AuthRequest } from '../../middleware/auth';
import { rateLimit } from '../../middleware/security';
import { recordAudit } from '../../services/audit';

/**
 * People: who can sign in, with what role, and the invitations outstanding.
 *
 * Invitations are one-time links rather than emails — Swoop has no mail
 * server, and a link an admin pastes into Teams is simpler than asking every
 * install to configure SMTP. Only the SHA-256 of the token is stored, so a
 * copy of the database does not hand out working invitations.
 */
const router = Router();
router.use(requireAuth);

export const INVITE_TTL_HOURS = 72;

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

router.get('/roles', (_req, res) => {
  res.json(ROLES.map((id) => ({ id, label: ROLE_LABELS[id], description: ROLE_DESCRIPTIONS[id] })));
});

router.get('/', requireRole('admin'), async (_req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const [people, pending] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        disabled: users.disabled,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
        invitedBy: users.invitedBy,
      })
      .from(users)
      .orderBy(users.email),
    db
      .select({
        id: invites.id,
        email: invites.email,
        role: invites.role,
        createdBy: invites.createdBy,
        expiresAt: invites.expiresAt,
        createdAt: invites.createdAt,
      })
      .from(invites)
      .where(and(isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, now)))
      .orderBy(desc(invites.createdAt)),
  ]);
  res.json({ users: people, invites: pending });
});

const inviteSchema = z.object({
  email: z.string().email().max(254),
  role: z.enum(ROLES),
});

router.post(
  '/invites',
  requireRole('admin'),
  rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'invite' }),
  async (req: AuthRequest, res) => {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
      return;
    }
    const email = parsed.data.email.trim().toLowerCase();
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) {
      res.status(409).json({ error: `${email} already has an account.` });
      return;
    }

    // Re-inviting the same address replaces the old link rather than leaving
    // two working ones in circulation.
    const now = Math.floor(Date.now() / 1000);
    await db
      .update(invites)
      .set({ revokedAt: now })
      .where(and(eq(invites.email, email), isNull(invites.acceptedAt), isNull(invites.revokedAt)));

    const token = randomBytes(32).toString('base64url');
    const id = uuidv4();
    const expiresAt = now + INVITE_TTL_HOURS * 3600;
    await db.insert(invites).values({
      id,
      email,
      role: parsed.data.role,
      tokenHash: hashInviteToken(token),
      createdBy: req.user!.email,
      expiresAt,
    });
    await recordAudit({
      user: req.user,
      action: 'user.invite',
      targetType: 'invite',
      targetId: id,
      detail: { email, role: parsed.data.role },
      req,
    });
    // The token is returned once, here, and never again.
    res.status(201).json({ id, email, role: parsed.data.role, token, expiresAt, path: `/invite/${token}` });
  },
);

router.delete('/invites/:id', requireRole('admin'), async (req: AuthRequest, res) => {
  const result = await db
    .update(invites)
    .set({ revokedAt: Math.floor(Date.now() / 1000) })
    .where(and(eq(invites.id, req.params.id), isNull(invites.acceptedAt)))
    .returning({ email: invites.email });
  if (result.length === 0) {
    res.status(404).json({ error: 'Invitation not found' });
    return;
  }
  await recordAudit({ user: req.user, action: 'user.invite_revoke', targetType: 'invite', targetId: req.params.id, detail: { email: result[0].email }, req });
  res.json({ ok: true });
});

const updateSchema = z.object({
  role: z.enum(ROLES).optional(),
  disabled: z.boolean().optional(),
  displayName: z.string().max(120).nullable().optional(),
});

/** Refuses any change that would leave nobody able to administer Swoop. */
async function wouldRemoveLastAdmin(userId: string, change: { role?: string; disabled?: boolean; deleting?: boolean }) {
  const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!target || target.role !== 'admin' || target.disabled) return false;
  const losingAdmin = change.deleting || change.disabled === true || (change.role !== undefined && change.role !== 'admin');
  if (!losingAdmin) return false;
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(and(eq(users.role, 'admin'), sql`coalesce(${users.disabled}, 0) = 0`));
  return Number(row?.n ?? 0) <= 1;
}

router.patch('/:id', requireRole('admin'), async (req: AuthRequest, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    return;
  }
  const [target] = await db.select().from(users).where(eq(users.id, req.params.id)).limit(1);
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (target.id === req.user!.userId && (parsed.data.disabled || (parsed.data.role && parsed.data.role !== 'admin'))) {
    res.status(400).json({ error: 'You cannot disable or demote your own account. Ask another admin.' });
    return;
  }
  if (await wouldRemoveLastAdmin(target.id, parsed.data)) {
    res.status(400).json({ error: 'That would leave Swoop with no admin. Make someone else an admin first.' });
    return;
  }

  const updates: Partial<typeof users.$inferInsert> = {};
  if (parsed.data.role !== undefined) updates.role = parsed.data.role;
  if (parsed.data.displayName !== undefined) updates.displayName = parsed.data.displayName?.trim() || null;
  if (parsed.data.disabled !== undefined) {
    updates.disabled = parsed.data.disabled;
    // Disabling revokes every session immediately.
    if (parsed.data.disabled) updates.tokenVersion = (target.tokenVersion ?? 0) + 1;
  }
  await db.update(users).set(updates).where(eq(users.id, target.id));
  await recordAudit({
    user: req.user,
    action: 'user.update',
    targetType: 'user',
    targetId: target.id,
    detail: { email: target.email, ...parsed.data },
    req,
  });
  res.json({ ok: true });
});

router.delete('/:id', requireRole('admin'), async (req: AuthRequest, res) => {
  const [target] = await db.select().from(users).where(eq(users.id, req.params.id)).limit(1);
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (target.id === req.user!.userId) {
    res.status(400).json({ error: 'You cannot delete your own account.' });
    return;
  }
  if (await wouldRemoveLastAdmin(target.id, { deleting: true })) {
    res.status(400).json({ error: 'That would leave Swoop with no admin.' });
    return;
  }
  // Their reviews and approvals keep the email they were made under.
  await db.delete(users).where(eq(users.id, target.id));
  await recordAudit({ user: req.user, action: 'user.delete', targetType: 'user', targetId: target.id, detail: { email: target.email }, req });
  res.json({ ok: true });
});

// ─── Audit log ─────────────────────────────────────────────────────────────────

router.get('/audit', requireRole('admin'), async (req, res) => {
  const parsed = z
    .object({
      limit: z.coerce.number().int().min(1).max(500).optional(),
      before: z.coerce.number().int().optional(),
      action: z.string().max(60).optional(),
      targetId: z.string().max(64).optional(),
    })
    .safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query parameters' });
    return;
  }
  const { limit = 100, before, action, targetId } = parsed.data;
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      and(
        before ? lt(auditLog.createdAt, before) : undefined,
        action ? sql`${auditLog.action} LIKE ${`${action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`} ESCAPE '\\'` : undefined,
        targetId ? eq(auditLog.targetId, targetId) : undefined,
      ),
    )
    .orderBy(desc(auditLog.createdAt), sql`rowid DESC`)
    .limit(limit);
  res.json(
    rows.map((row) => {
      let detail: unknown = null;
      try {
        detail = row.detail ? JSON.parse(row.detail) : null;
      } catch {
        detail = row.detail;
      }
      return { ...row, detail };
    }),
  );
});

export default router;
