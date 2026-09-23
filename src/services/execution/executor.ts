import { and, desc, eq, lt } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config';
import { db } from '../../db';
import { actionLogs, approvals, clients, executions, tenants } from '../../db/schema';
import { findActionType } from '../../domain/classifications';
import { createLogger, describeError } from '../../lib/logger';
import type { ActionLog, Client, Execution, SessionUser, Tenant } from '../../types';
import { recordAudit } from '../audit';
import { cippCredentials, CippClient } from '../cipp/client';
import {
  DirectoryError,
  findGroups,
  getUser,
  getUserGroups,
  listLicences,
  type M365Group,
  type M365Licence,
  type M365User,
} from '../cipp/directory';
import { CippUncertainError, CippWriter } from '../cipp/writer';
import { decrypt, encrypt } from '../crypto';
import { createPsaClient } from '../psa/factory';
import type { TenancyAssessment } from '../triage/tenancy';
import { domainBelongsTo, domainOf, clientDomains } from '../triage/tenancy';
import { EXECUTION_TRAITS, needsAttestation } from './actions';
import { effectiveMode, readExecutionPolicy } from './policy';

const log = createLogger('Execution');

/**
 * Carries out an approved change in a client's Microsoft 365 tenant.
 *
 * The rules that make this safe to leave running:
 *
 * 1. Nothing the model wrote is sent. The executor resolves the target user,
 *    group and licence itself against the live tenant, and refuses anything
 *    ambiguous — "Finance" matching both "Finance" and "Finance-ReadOnly" is
 *    a question for a person, not a guess.
 * 2. State is re-read immediately before acting, so a proposal approved on
 *    Monday is checked against the tenant as it is on Tuesday.
 * 3. A change is only called done once Swoop has read it back. CIPP answers
 *    HTTP 200 for some failures, so its word alone is not proof.
 * 4. A live run happens at most once per proposal. A request that went out
 *    without an answer is recorded as *uncertain* and blocks any retry until
 *    a person has looked — resetting a password twice is worse than asking.
 * 5. Secrets — a temporary password — never reach a log, a note or the
 *    audit trail. They are encrypted, shown once to an approver, then wiped.
 */

export type ExecutionMode = 'dry_run' | 'live';

export interface ExecutionStep {
  order: number;
  description: string;
  method: 'GET' | 'POST';
  endpoint: string;
  /** What was (or would be) sent. Secrets redacted. */
  payload: unknown;
  status: 'ok' | 'failed' | 'skipped' | 'planned' | 'uncertain';
  /** CIPP's own words, secrets redacted. */
  result: string | null;
  durationMs: number | null;
}

export class ExecutionRefused extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = 'ExecutionRefused';
    this.status = status;
  }
}

/** A secret revealed from an execution is wiped after this long regardless. */
const SECRET_TTL_SECONDS = 24 * 60 * 60;
/** A live run requires a dry run of the same proposal at most this old. */
const DRY_RUN_FRESH_SECONDS = 24 * 60 * 60;
/** A run still "running" after this long was interrupted. */
const STALE_RUN_SECONDS = 10 * 60;

let verifyDelaysMs = [2_000, 5_000, 10_000];

/** For tests: read-back retries without real waiting. */
export function setVerifyDelaysForTesting(delays: number[]): void {
  verifyDelaysMs = delays;
}

// ─── Readiness ─────────────────────────────────────────────────────────────────

export interface ExecutionReadiness {
  mode: 'off' | 'dry_run' | 'live';
  canDryRun: boolean;
  canRunLive: boolean;
  /** Why a live run is not available right now, in the order to fix them. */
  reasons: string[];
  attestationRequired: boolean;
  attested: boolean;
  lastDryRunOk: boolean;
}

/**
 * Whether this proposal can be run, and if not, why. The same checks guard
 * the run itself; this just reports them for the UI.
 */
export async function executionReadiness(logId: string, user: SessionUser | null): Promise<ExecutionReadiness> {
  const ctx = await loadContext(logId);
  return readinessFor(ctx, user);
}

interface LoadedContext {
  row: ActionLog;
  tenant: Tenant;
  client: Client | null;
  tenancy: TenancyAssessment | null;
  planBlockers: string[];
  decisions: Array<{ decision: string; verificationMethod: string | null; userId: string | null }>;
  runs: Execution[];
}

async function loadContext(logId: string): Promise<LoadedContext> {
  const [row] = await db.select().from(actionLogs).where(eq(actionLogs.id, logId)).limit(1);
  if (!row) throw new ExecutionRefused('Proposal not found', 404);
  if (!row.tenantId) throw new ExecutionRefused('This proposal has no tenant', 400);
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, row.tenantId)).limit(1);
  if (!tenant) throw new ExecutionRefused('Tenant not found', 404);
  const [client] = row.clientId ? await db.select().from(clients).where(eq(clients.id, row.clientId)).limit(1) : [];
  const decisions = await db
    .select({ decision: approvals.decision, verificationMethod: approvals.verificationMethod, userId: approvals.userId })
    .from(approvals)
    .where(eq(approvals.actionLogId, logId));
  const runs = await db
    .select()
    .from(executions)
    .where(eq(executions.actionLogId, logId))
    .orderBy(desc(executions.startedAt));
  return {
    row,
    tenant,
    client: client ?? null,
    tenancy: parse<TenancyAssessment>(row.tenancy),
    planBlockers: parse<{ blockers?: string[] }>(row.executionPlan)?.blockers ?? [],
    decisions,
    runs,
  };
}

function readinessFor(ctx: LoadedContext, _user: SessionUser | null): ExecutionReadiness {
  const { row, tenant, client } = ctx;
  const policy = readExecutionPolicy(tenant.executionPolicy);
  const mode = effectiveMode(policy);
  const action = row.classification ?? '';
  const traits = EXECUTION_TRAITS[action];
  const shared: string[] = [];

  if (config().executionDisabled) shared.push('Execution is switched off for this whole install (SWOOP_DISABLE_EXECUTION).');
  else if (mode === 'off') shared.push('Execution is off. Turn it on under Settings → Execution.');
  if (!traits) shared.push('No change is proposed.');
  else if (!traits.executable) shared.push(`${findActionType(action)?.label ?? action} is plan-only: Swoop cannot yet prove it worked, so a technician does it.`);
  else if (!policy.actions.includes(action)) shared.push(`${findActionType(action)?.label} is not on the list of actions Swoop may run.`);
  if (!client) shared.push('The client this ticket belonged to no longer exists.');
  else if (!policy.clientIds.includes(client.id)) shared.push(`${client.name} is not on the list of clients Swoop may change.`);
  if (!cippCredentials(tenant)) shared.push('CIPP is not connected, or lookups are switched off.');
  if (row.crossTenant || ctx.tenancy?.crossTenant) shared.push('The request crosses clients. Swoop never acts on those.');
  if (row.supersededBy || row.approvalState === 'superseded') shared.push('A newer triage of this ticket replaced this proposal.');
  for (const blocker of ctx.planBlockers) shared.push(blocker);

  const dryReasons = [...shared];
  const liveReasons = [...shared];
  if (mode === 'dry_run') liveReasons.push('Execution is in dry-run mode: Swoop checks, but does not send.');

  if (row.approvalState !== 'approved' && row.approvalState !== 'auto_approved') {
    liveReasons.push(
      row.approvalState === 'pending'
        ? 'Waiting for approval.'
        : `The proposal is ${(row.approvalState ?? 'not approved').replace('_', ' ')}.`,
    );
  }

  const attestationRequired = needsAttestation(action);
  const attested = ctx.decisions.some((d) => d.decision === 'approved' && Boolean(d.verificationMethod));
  if (attestationRequired && !attested) {
    liveReasons.push('An approver must record how the requester’s identity was confirmed.');
  }
  // Auto-approval has no person to attest, so it can never carry an
  // identity-sensitive change on its own.
  if (attestationRequired && row.approvalState === 'auto_approved') {
    liveReasons.push('Identity-sensitive changes need a person’s approval, not auto-approval.');
  }

  const now = Math.floor(Date.now() / 1000);
  const lastDry = ctx.runs.find((r) => r.mode === 'dry_run');
  const lastDryRunOk = Boolean(lastDry && lastDry.status === 'dry_run_ok' && (lastDry.startedAt ?? 0) > now - DRY_RUN_FRESH_SECONDS);
  if (policy.requireDryRun && !lastDryRunOk) liveReasons.push('Run a dry run first — the policy requires one within the last 24 hours.');

  const blockingLive = ctx.runs.find(
    (r) => r.mode === 'live' && ['running', 'succeeded', 'noop', 'uncertain'].includes(r.status),
  );
  if (blockingLive) {
    liveReasons.push(
      blockingLive.status === 'uncertain'
        ? 'A previous run’s outcome is unknown. Check the tenant and record what happened before trying again.'
        : blockingLive.status === 'running'
          ? 'A run is already in progress.'
          : 'This change has already been made.',
    );
  }
  if (ctx.runs.some((r) => r.status === 'running')) dryReasons.push('A run is already in progress.');

  return {
    mode,
    canDryRun: mode !== 'off' && dryReasons.length === 0,
    canRunLive: mode === 'live' && liveReasons.length === 0,
    reasons: mode === 'live' ? liveReasons : dryReasons.length ? dryReasons : liveReasons,
    attestationRequired,
    attested,
    lastDryRunOk,
  };
}

// ─── Starting a run ────────────────────────────────────────────────────────────

/**
 * Validates and starts a run, returning its id at once. The work continues
 * in the background — a live change plus read-back can take a minute — and
 * the UI follows the execution row.
 */
export async function startExecution(
  logId: string,
  mode: ExecutionMode,
  user: SessionUser | null,
  options: { await?: boolean } = {},
): Promise<{ executionId: string; done: Promise<void> }> {
  const ctx = await loadContext(logId);
  const readiness = readinessFor(ctx, user);
  if (mode === 'dry_run' && !readiness.canDryRun) throw new ExecutionRefused(readiness.reasons[0] ?? 'Cannot dry-run this proposal');
  if (mode === 'live' && !readiness.canRunLive) throw new ExecutionRefused(readiness.reasons[0] ?? 'Cannot run this proposal');

  const executionId = uuidv4();
  const entities = parse<Record<string, string | null>>(ctx.row.entities) ?? {};
  const m365Tenant = ctx.tenancy?.m365?.defaultDomain || ctx.tenancy?.m365?.tenantId || ctx.client?.m365DefaultDomain || null;
  try {
    await db.insert(executions).values({
      id: executionId,
      actionLogId: logId,
      tenantId: ctx.tenant.id,
      clientId: ctx.client?.id ?? null,
      action: ctx.row.classification!,
      mode,
      status: 'running',
      startedBy: user?.email ?? 'policy',
      target: entities.target_user_email ?? null,
      m365Tenant,
    });
  } catch (err) {
    // The partial unique index: a second live run lost the race.
    if (/UNIQUE/i.test(describeError(err))) throw new ExecutionRefused('This change is already running or has already been made.');
    throw err;
  }
  // The proposal's execution state follows live runs only: a dry run after
  // the change was made must not hide that it was made.
  if (mode === 'live') await db.update(actionLogs).set({ executionState: 'running' }).where(eq(actionLogs.id, logId));
  await recordAudit({
    user,
    action: mode === 'live' ? 'execution.start' : 'execution.dry_run',
    targetType: 'action_log',
    targetId: logId,
    tenantId: ctx.tenant.id,
    detail: { executionId, action: ctx.row.classification, target: entities.target_user_email ?? null, m365Tenant },
  });

  const done = runExecution(executionId, ctx, mode, user).catch(async (err) => {
    log.error(`Execution ${executionId} crashed`, err);
    await finish(executionId, logId, {
      status: mode === 'live' ? 'uncertain' : 'failed',
      summary: `Swoop hit an internal error part-way through: ${describeError(err)}. Check the tenant before retrying.`,
      verification: 'skipped',
    });
  });
  if (options.await) await done;
  return { executionId, done };
}

// ─── The run ───────────────────────────────────────────────────────────────────

interface Resolved {
  user: M365User;
  group?: M365Group;
  licence?: M365Licence;
  /** Set when the change is already in place. */
  noop?: string;
  /** Set when the change must not go ahead. */
  blocked?: string;
  warnings: string[];
}

interface PlannedRequest {
  description: string;
  endpoint: string;
  payload: unknown;
  /** Later steps are best-effort: their failure is a warning, not a failed change. */
  bestEffort?: boolean;
}

async function runExecution(executionId: string, ctx: LoadedContext, mode: ExecutionMode, user: SessionUser | null): Promise<void> {
  const creds = cippCredentials(ctx.tenant);
  if (!creds) throw new Error('CIPP credentials disappeared');
  const reader = new CippClient(creds);
  const action = ctx.row.classification!;
  const entities = parse<Record<string, string | null>>(ctx.row.entities) ?? {};
  const upn = entities.target_user_email?.toLowerCase() ?? null;
  const tenantFilter =
    ctx.tenancy?.m365?.defaultDomain || ctx.tenancy?.m365?.tenantId || ctx.client?.m365DefaultDomain || ctx.client?.m365TenantId || null;
  const steps: ExecutionStep[] = [];

  const stop = (status: string, summary: string, verification = 'skipped') =>
    finish(executionId, ctx.row.id, { status, summary, verification, steps });

  // The target must be named, and must be on a domain this client owns. The
  // plan already checked; this is the last line, against a changed config.
  if (!upn) return stop('blocked', 'The ticket does not name the user by email address.');
  if (!tenantFilter) return stop('blocked', 'No Microsoft 365 tenant is mapped to this client.');
  if (ctx.client) {
    const owned = clientDomains(ctx.client);
    const domain = domainOf(upn);
    if (owned.length > 0 && (!domain || !domainBelongsTo(domain, owned))) {
      return stop('blocked', `${upn} is not on a domain ${ctx.client.name} owns. Swoop only changes a client’s own users.`);
    }
  }

  // ─── Resolve against the live tenant ────────────────────────────────────
  const started = Date.now();
  let resolved: Resolved;
  try {
    resolved = await resolve(reader, tenantFilter, action, upn, entities);
  } catch (err) {
    if (err instanceof DirectoryError && err.notFound) return stop('blocked', `${upn} does not exist in ${tenantFilter}.`);
    return stop('failed', `Could not read the tenant before acting: ${describeError(err)}`);
  }
  steps.push({
    order: 1,
    description: `Read ${upn} and the current state in ${tenantFilter}`,
    method: 'GET',
    endpoint: '/api/ListUsers',
    payload: { tenantFilter, UserID: upn },
    status: 'ok',
    result: describeUser(resolved),
    durationMs: Date.now() - started,
  });

  if (resolved.blocked) return stop('blocked', resolved.blocked);
  if (resolved.noop) {
    await finish(executionId, ctx.row.id, {
      status: mode === 'live' ? 'noop' : 'dry_run_ok',
      summary: `Nothing to do: ${resolved.noop}`,
      verification: 'verified',
      steps,
    });
    return;
  }

  const requests = buildRequests(action, tenantFilter, resolved);

  if (mode === 'dry_run') {
    requests.forEach((r, i) =>
      steps.push({ order: i + 2, description: r.description, method: 'POST', endpoint: `/api/${r.endpoint}`, payload: r.payload, status: 'planned', result: null, durationMs: null }),
    );
    await finish(executionId, ctx.row.id, {
      status: 'dry_run_ok',
      summary: `Checked. Ready to ${describeChange(action, resolved)}.${resolved.warnings.length ? ` Note: ${resolved.warnings.join(' ')}` : ''}`,
      verification: 'skipped',
      steps,
    });
    return;
  }

  // ─── Live ──────────────────────────────────────────────────────────────
  const writer = new CippWriter(creds);
  const actionStartedAt = new Date(Date.now() - 60_000);
  let secret: string | null = null;
  const warnings = [...resolved.warnings];

  for (const [i, request] of requests.entries()) {
    const stepStart = Date.now();
    const step: ExecutionStep = {
      order: i + 2,
      description: request.description,
      method: 'POST',
      endpoint: `/api/${request.endpoint}`,
      payload: request.payload,
      status: 'ok',
      result: null,
      durationMs: null,
    };
    steps.push(step);
    try {
      const response = await writer.post(request.endpoint, request.payload);
      const outcome = interpret(action, request.endpoint, response.status, response.body);
      if (outcome.secret) secret = outcome.secret;
      step.result = redact(outcome.message, secret);
      step.durationMs = Date.now() - stepStart;
      if (!outcome.ok) {
        step.status = 'failed';
        if (request.bestEffort) {
          warnings.push(`${request.description} did not complete: ${step.result}`);
          continue;
        }
        return stop(i === 0 ? 'failed' : 'uncertain', `CIPP reported a failure: ${step.result}`);
      }
    } catch (err) {
      step.durationMs = Date.now() - stepStart;
      if (err instanceof CippUncertainError) {
        step.status = 'uncertain';
        step.result = err.message;
        return stop('uncertain', `${err.message}. The change may or may not have been made — check the tenant, then record the outcome.`);
      }
      step.status = 'failed';
      step.result = describeError(err);
      return stop('failed', `The request to CIPP failed before anything changed: ${step.result}`);
    }
  }

  // ─── Read it back ──────────────────────────────────────────────────────
  const verification = await verify(reader, tenantFilter, action, resolved, actionStartedAt);
  steps.push({
    order: steps.length + 1,
    description: 'Read the change back from the tenant',
    method: 'GET',
    endpoint: verification.endpoint,
    payload: null,
    status: verification.level === 'failed' ? 'failed' : 'ok',
    result: verification.detail,
    durationMs: null,
  });

  const summary =
    verification.level === 'failed'
      ? `CIPP accepted the request, but the change is not visible in the tenant: ${verification.detail}`
      : `${capitalise(describeChange(action, resolved))} — ${verification.detail}${warnings.length ? ` Note: ${warnings.join(' ')}` : ''}`;

  await finish(executionId, ctx.row.id, {
    status: verification.level === 'failed' ? 'uncertain' : 'succeeded',
    summary,
    verification: verification.level,
    steps,
    secret,
    rollback: rollbackFor(action, resolved),
  });

  if (verification.level !== 'failed') {
    await afterSuccess(ctx, executionId, action, resolved, summary, user).catch((err) =>
      log.warn(`Execution ${executionId}: could not post the outcome to the ticket — ${describeError(err)}`),
    );
  }
}

async function resolve(
  reader: CippClient,
  tenant: string,
  action: string,
  upn: string,
  entities: Record<string, string | null>,
): Promise<Resolved> {
  const user = await getUser(reader, tenant, upn);
  const r: Resolved = { user, warnings: [] };
  const guest = user.userType?.toLowerCase() === 'guest';

  const resolveGroup = async (): Promise<M365Group | null> => {
    const name = entities.group_name?.trim();
    if (!name) {
      r.blocked = 'The ticket does not name the group.';
      return null;
    }
    const matches = await findGroups(reader, tenant, name);
    const exact = matches.filter((g) => g.displayName.toLowerCase() === name.toLowerCase() || g.mail?.toLowerCase() === name.toLowerCase());
    if (exact.length === 0) {
      r.blocked = matches.length
        ? `No group is called exactly "${name}". Close matches: ${matches.slice(0, 5).map((g) => g.displayName).join(', ')}. Correct the group and re-run.`
        : `No group called "${name}" exists in ${tenant}.`;
      return null;
    }
    if (exact.length > 1) {
      r.blocked = `${exact.length} groups are called "${name}" (${exact.map((g) => g.kind).join(', ')}). Swoop will not guess which.`;
      return null;
    }
    const group = exact[0];
    if (group.dynamic) r.blocked = `"${group.displayName}" is a dynamic group — membership follows its rule, so it cannot be changed by hand.`;
    else if (group.onPremisesSync) r.blocked = `"${group.displayName}" is synced from on-premises AD. Change it there.`;
    else if (group.roleAssignable) r.blocked = `"${group.displayName}" can hold admin roles. Privileged access is never granted automatically.`;
    return group;
  };

  const resolveLicence = async (): Promise<M365Licence | null> => {
    const wanted = entities.license_sku?.trim().toLowerCase();
    if (!wanted) {
      r.blocked = 'The ticket does not name the licence.';
      return null;
    }
    const licences = await listLicences(reader, tenant);
    const exact = licences.filter((l) => l.name.toLowerCase() === wanted || l.skuId === wanted);
    const partial = exact.length ? exact : licences.filter((l) => l.name.toLowerCase().includes(wanted));
    if (partial.length === 0) {
      r.blocked = `${tenant} has no licence matching "${entities.license_sku}". It has: ${licences.map((l) => l.name).join(', ') || 'none'}.`;
      return null;
    }
    if (partial.length > 1) {
      r.blocked = `"${entities.license_sku}" matches ${partial.map((l) => l.name).join(', ')}. Say which one.`;
      return null;
    }
    return partial[0];
  };

  switch (action) {
    case 'password_reset':
      if (guest) r.blocked = `${upn} is a guest account; its password is managed by its home organisation.`;
      else if (user.accountEnabled === false) r.blocked = `${upn} is disabled. Re-enabling it is a separate decision.`;
      else if (user.onPremisesSync) r.warnings.push('The account syncs from on-premises AD, so the reset goes through password writeback and completes asynchronously.');
      break;
    case 'mfa_reset':
      if (guest) r.blocked = `${upn} is a guest account; its MFA is managed by its home organisation.`;
      else if (user.accountEnabled === false) r.blocked = `${upn} is disabled.`;
      break;
    case 'account_disable':
    case 'account_enable':
      if (user.onPremisesSync) r.blocked = `${upn} syncs from on-premises AD. Change sign-in there, or the next sync undoes it.`;
      else if (action === 'account_disable' && user.accountEnabled === false) r.noop = `${upn} is already disabled.`;
      else if (action === 'account_enable' && user.accountEnabled === true) r.noop = `${upn} is already enabled.`;
      break;
    case 'group_add':
    case 'group_remove': {
      const group = await resolveGroup();
      if (!group || r.blocked) break;
      r.group = group;
      const memberOf = await getUserGroups(reader, tenant, user.id);
      const isMember = memberOf.some((g) => g.id === group.id);
      if (action === 'group_add' && isMember) r.noop = `${upn} is already in "${group.displayName}".`;
      if (action === 'group_remove' && !isMember) r.noop = `${upn} is not in "${group.displayName}".`;
      break;
    }
    case 'license_assign':
    case 'license_remove': {
      const licence = await resolveLicence();
      if (!licence || r.blocked) break;
      r.licence = licence;
      const has = user.assignedSkuIds.includes(licence.skuId);
      if (action === 'license_assign') {
        if (has) r.noop = `${upn} already has ${licence.name}.`;
        else if (licence.available <= 0) r.blocked = `No free ${licence.name} licences (${licence.used} of ${licence.total} in use). Buy another first.`;
      } else if (!has) {
        r.noop = `${upn} does not have ${licence.name}.`;
      } else {
        r.warnings.push('Removing a licence can start mailbox and OneDrive retention clocks.');
      }
      break;
    }
    default:
      r.blocked = `${action} cannot be executed.`;
  }
  return r;
}

/** Every request body follows CIPP's own handlers, checked against CIPP-API's source. */
function buildRequests(action: string, tenant: string, r: Resolved): PlannedRequest[] {
  const u = r.user;
  // EditGroup reads the member's object id from `value` and falls back to a
  // lookup only when it is empty; removal needs the id outright.
  const member = [{ value: u.id, label: u.upn, addedFields: { userPrincipalName: u.upn } }];
  switch (action) {
    case 'password_reset':
      return [
        {
          description: `Reset the password for ${u.upn}; they must change it at next sign-in`,
          endpoint: 'ExecResetPass',
          payload: { tenantFilter: tenant, ID: u.upn, displayName: u.displayName ?? u.upn, MustChange: true },
        },
      ];
    case 'mfa_reset':
      return [{ description: `Remove ${u.upn}'s MFA methods so they re-register`, endpoint: 'ExecResetMFA', payload: { tenantFilter: tenant, ID: u.upn } }];
    case 'group_add':
    case 'group_remove':
      return [
        {
          description: action === 'group_add' ? `Add ${u.upn} to "${r.group!.displayName}"` : `Remove ${u.upn} from "${r.group!.displayName}"`,
          endpoint: 'EditGroup',
          payload: {
            tenantFilter: tenant,
            groupId: { value: r.group!.id, label: r.group!.displayName, addedFields: { groupName: r.group!.displayName, groupType: r.group!.kind } },
            groupName: r.group!.displayName,
            groupType: r.group!.kind,
            [action === 'group_add' ? 'AddMember' : 'RemoveMember']: member,
          },
        },
      ];
    case 'license_assign':
      return [
        {
          description: `Assign ${r.licence!.name} to ${u.upn}`,
          endpoint: 'ExecBulkLicense',
          payload: [{ tenantFilter: tenant, userIds: [u.id], LicenseOperation: 'Add', Licenses: [{ label: r.licence!.name, value: r.licence!.skuId }] }],
        },
      ];
    case 'license_remove':
      return [
        {
          description: `Remove ${r.licence!.name} from ${u.upn}`,
          endpoint: 'ExecBulkLicense',
          // Removal reads LicensesToRemove — sending Licenses removes nothing.
          payload: [
            {
              tenantFilter: tenant,
              userIds: [u.id],
              LicenseOperation: 'Remove',
              RemoveAllLicenses: false,
              LicensesToRemove: [{ label: r.licence!.name, value: r.licence!.skuId }],
            },
          ],
        },
      ];
    case 'account_disable':
      return [
        { description: `Block sign-in for ${u.upn}`, endpoint: 'ExecDisableUser', payload: { tenantFilter: tenant, ID: u.upn, Enable: false } },
        {
          description: `Sign ${u.upn} out of every session so the block takes effect now`,
          endpoint: 'ExecRevokeSessions',
          payload: { tenantFilter: tenant, id: u.id, Username: u.upn },
          bestEffort: true,
        },
      ];
    case 'account_enable':
      return [{ description: `Allow sign-in for ${u.upn}`, endpoint: 'ExecDisableUser', payload: { tenantFilter: tenant, ID: u.upn, Enable: true } }];
    default:
      return [];
  }
}

interface Outcome {
  ok: boolean;
  message: string;
  secret?: string | null;
}

/**
 * Reads CIPP's answer. Its handlers wrap everything in `{ Results }` — a
 * string, a list of "Success - …" / "Error - …" lines, or for a password
 * reset an object carrying the new password in `copyField`.
 */
export function interpret(action: string, endpoint: string, status: number, body: unknown): Outcome {
  const results = (body && typeof body === 'object' && 'Results' in (body as Record<string, unknown>)
    ? (body as Record<string, unknown>).Results
    : body) as unknown;

  if (endpoint === 'ExecResetPass' && results && typeof results === 'object' && !Array.isArray(results)) {
    const r = results as Record<string, unknown>;
    const secret = typeof r.copyField === 'string' && r.copyField ? r.copyField : null;
    const text = typeof r.resultText === 'string' ? r.resultText : 'Password reset';
    const ok = status >= 200 && status < 300 && r.state === 'success' && Boolean(secret);
    return { ok, message: ok ? text : `CIPP did not confirm the reset: ${text}`, secret };
  }

  const lines = (Array.isArray(results) ? results : [results])
    .map((l) => (typeof l === 'string' ? l : l && typeof l === 'object' ? JSON.stringify(l) : String(l ?? '')))
    .filter(Boolean);
  const message = lines.join(' ').slice(0, 1000) || `HTTP ${status}`;
  if (status < 200 || status >= 300) return { ok: false, message };
  if (lines.some((l) => /^(error|failed)\b/i.test(l.trim()) || /\bfailed to\b/i.test(l))) return { ok: false, message };
  return { ok: true, message };
}

interface Verification {
  level: 'verified' | 'reported' | 'pending' | 'failed';
  detail: string;
  endpoint: string;
}

async function verify(reader: CippClient, tenant: string, action: string, r: Resolved, since: Date): Promise<Verification> {
  const upn = r.user.upn;
  // Directory changes take a few seconds to show; Exchange-backed ones longer.
  const attempt = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T | null> => {
    let last: T | null = null;
    for (const delay of [0, ...verifyDelaysMs]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        last = await read();
        if (done(last)) return last;
      } catch (err) {
        log.debug(`Read-back failed, retrying: ${describeError(err)}`);
      }
    }
    return last;
  };

  switch (action) {
    case 'password_reset': {
      if (r.user.onPremisesSync) {
        return { level: 'pending', detail: 'Accepted for password writeback; on-premises AD applies it asynchronously.', endpoint: '/api/ListUsers' };
      }
      const user = await attempt(
        () => getUser(reader, tenant, upn),
        (u) => Boolean(u.lastPasswordChange && new Date(u.lastPasswordChange) >= since),
      );
      if (user?.lastPasswordChange && new Date(user.lastPasswordChange) >= since) {
        return { level: 'verified', detail: `Password last changed ${user.lastPasswordChange}.`, endpoint: '/api/ListUsers' };
      }
      return { level: 'reported', detail: 'CIPP confirmed the reset; the change time has not shown yet.', endpoint: '/api/ListUsers' };
    }
    case 'mfa_reset':
      // CIPP's MFA report is cached for hours, so reading it back proves nothing.
      return { level: 'reported', detail: 'CIPP confirmed the MFA methods were removed. The user re-registers at next sign-in.', endpoint: '/api/ListMFAUsers' };
    case 'account_disable':
    case 'account_enable': {
      const want = action === 'account_enable';
      const user = await attempt(() => getUser(reader, tenant, upn), (u) => u.accountEnabled === want);
      return user?.accountEnabled === want
        ? { level: 'verified', detail: `Sign-in is now ${want ? 'allowed' : 'blocked'}.`, endpoint: '/api/ListUsers' }
        : { level: 'failed', detail: `Sign-in still shows as ${user?.accountEnabled ? 'allowed' : 'blocked'}.`, endpoint: '/api/ListUsers' };
    }
    case 'group_add':
    case 'group_remove': {
      const want = action === 'group_add';
      const groups = await attempt(
        () => getUserGroups(reader, tenant, r.user.id),
        (gs) => gs.some((g) => g.id === r.group!.id) === want,
      );
      const present = groups?.some((g) => g.id === r.group!.id) ?? false;
      if (present === want) {
        return { level: 'verified', detail: `${upn} is ${want ? 'now a member of' : 'no longer in'} "${r.group!.displayName}".`, endpoint: '/api/ListUserGroups' };
      }
      // Exchange applies distribution-list changes on its own schedule.
      if (r.group!.kind === 'Distribution List' || r.group!.kind === 'Mail-Enabled Security') {
        return { level: 'pending', detail: 'Exchange accepted the change; distribution list membership can take a few minutes to show.', endpoint: '/api/ListUserGroups' };
      }
      return { level: 'failed', detail: `Membership of "${r.group!.displayName}" has not changed.`, endpoint: '/api/ListUserGroups' };
    }
    case 'license_assign':
    case 'license_remove': {
      const want = action === 'license_assign';
      const user = await attempt(() => getUser(reader, tenant, upn), (u) => u.assignedSkuIds.includes(r.licence!.skuId) === want);
      const has = user?.assignedSkuIds.includes(r.licence!.skuId) ?? !want;
      return has === want
        ? { level: 'verified', detail: `${upn} ${want ? 'now has' : 'no longer has'} ${r.licence!.name}.`, endpoint: '/api/ListUsers' }
        : { level: 'failed', detail: `${r.licence!.name} is ${has ? 'still' : 'not'} assigned.`, endpoint: '/api/ListUsers' };
    }
    default:
      return { level: 'reported', detail: 'No read-back available.', endpoint: '' };
  }
}

function rollbackFor(action: string, r: Resolved): string | null {
  switch (action) {
    case 'group_add':
      return `Remove ${r.user.upn} from "${r.group?.displayName}".`;
    case 'group_remove':
      return `Add ${r.user.upn} back to "${r.group?.displayName}".`;
    case 'license_assign':
      return `Remove ${r.licence?.name} from ${r.user.upn}.`;
    case 'license_remove':
      return `Re-assign ${r.licence?.name} to ${r.user.upn}.`;
    case 'account_disable':
      return `Re-enable sign-in for ${r.user.upn}.`;
    case 'account_enable':
      return `Block sign-in for ${r.user.upn} again.`;
    default:
      return null;
  }
}

function describeChange(action: string, r: Resolved): string {
  const u = r.user.upn;
  switch (action) {
    case 'password_reset':
      return `reset the password for ${u}`;
    case 'mfa_reset':
      return `reset MFA for ${u}`;
    case 'group_add':
      return `add ${u} to "${r.group?.displayName}"`;
    case 'group_remove':
      return `remove ${u} from "${r.group?.displayName}"`;
    case 'license_assign':
      return `assign ${r.licence?.name} to ${u} (${r.licence?.available} free)`;
    case 'license_remove':
      return `remove ${r.licence?.name} from ${u}`;
    case 'account_disable':
      return `block sign-in for ${u} and end their sessions`;
    case 'account_enable':
      return `allow sign-in for ${u}`;
    default:
      return action;
  }
}

function describeUser(r: Resolved): string {
  const u = r.user;
  const parts = [
    u.displayName ?? u.upn,
    u.accountEnabled === false ? 'sign-in blocked' : 'sign-in allowed',
    u.onPremisesSync ? 'synced from AD' : 'cloud account',
  ];
  if (r.group) parts.push(`group "${r.group.displayName}" (${r.group.kind})`);
  if (r.licence) parts.push(`${r.licence.name}: ${r.licence.available} free`);
  return parts.join(' · ');
}

// ─── Finishing ─────────────────────────────────────────────────────────────────

async function finish(
  executionId: string,
  logId: string,
  outcome: {
    status: string;
    summary: string;
    verification: string;
    steps?: ExecutionStep[];
    secret?: string | null;
    rollback?: string | null;
  },
): Promise<void> {
  const cfg = config();
  const secret = outcome.secret
    ? cfg.encryptionEnabled
      ? encrypt(outcome.secret, cfg.encryptionKey)
      : outcome.secret
    : null;
  const secretValue = outcome.secret ?? null;
  await db
    .update(executions)
    .set({
      status: outcome.status,
      summary: redact(outcome.summary, secretValue),
      verification: outcome.verification,
      steps: outcome.steps ? JSON.stringify(outcome.steps.map((s) => ({ ...s, result: redact(s.result, secretValue) }))) : undefined,
      secret,
      secretExpiresAt: secret ? Math.floor(Date.now() / 1000) + SECRET_TTL_SECONDS : null,
      rollback: outcome.rollback ?? null,
      finishedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(executions.id, executionId));
  const [finished] = await db.select({ mode: executions.mode }).from(executions).where(eq(executions.id, executionId)).limit(1);
  if (finished?.mode === 'live') await db.update(actionLogs).set({ executionState: outcome.status }).where(eq(actionLogs.id, logId));
  log.info(`Execution ${executionId}: ${outcome.status} — ${redact(outcome.summary, secretValue)}`);
  if (finished?.mode === 'live' && ['failed', 'uncertain', 'blocked'].includes(outcome.status)) {
    await afterProblem(logId, executionId, outcome.status, redact(outcome.summary, secretValue) ?? '').catch((err) =>
      log.warn(`Execution ${executionId}: could not record the problem on the ticket — ${describeError(err)}`),
    );
  }
}

/**
 * A live run that failed, stopped, or ended with an unknown outcome is
 * audited and noted on the ticket, so the technician who picks it up knows
 * Swoop already tried — and whether the tenant may have changed.
 */
async function afterProblem(logId: string, executionId: string, status: string, summary: string): Promise<void> {
  const [row] = await db.select().from(actionLogs).where(eq(actionLogs.id, logId)).limit(1);
  if (!row?.tenantId) return;
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, row.tenantId)).limit(1);
  if (!tenant) return;
  await recordAudit({
    user: null,
    action: `execution.${status}`,
    targetType: 'action_log',
    targetId: logId,
    tenantId: tenant.id,
    detail: { executionId, action: row.classification, ticketId: row.ticketId, summary: summary.slice(0, 300) },
  });
  if (tenant.dryRun || !readExecutionPolicy(tenant.executionPolicy).postResultNote) return;
  const heading =
    status === 'uncertain'
      ? 'Swoop — change sent, outcome unknown'
      : status === 'blocked'
        ? 'Swoop — change stopped before sending'
        : 'Swoop — change failed';
  const advice =
    status === 'uncertain'
      ? 'The request reached CIPP but Swoop could not confirm the result. Check the user in CIPP or the admin centre and record what you find on the ticket in Swoop before anyone retries.'
      : status === 'blocked'
        ? 'Nothing was sent to the tenant.'
        : 'CIPP reported an error. Nothing is known to have changed; a technician should take it from here.';
  await createPsaClient(tenant).addTicketNote(
    row.ticketId,
    [heading, '', summary, '', advice, '', '---', `Execution ${executionId}.`].join('\n'),
    true,
  );
  await db.update(executions).set({ notePosted: true }).where(eq(executions.id, executionId));
}

async function afterSuccess(
  ctx: LoadedContext,
  executionId: string,
  action: string,
  r: Resolved,
  summary: string,
  user: SessionUser | null,
): Promise<void> {
  const policy = readExecutionPolicy(ctx.tenant.executionPolicy);
  await recordAudit({
    user,
    action: 'execution.succeeded',
    targetType: 'action_log',
    targetId: ctx.row.id,
    tenantId: ctx.tenant.id,
    detail: { executionId, action, target: r.user.upn },
  });
  if (ctx.tenant.dryRun) return;
  const psa = createPsaClient(ctx.tenant);
  if (policy.postResultNote) {
    const lines = [
      `Swoop — change made`,
      '',
      summary,
      action === 'password_reset'
        ? 'The temporary password is held in Swoop for 24 hours and can be revealed once by an approver. It is not written to this ticket.'
        : null,
      rollbackFor(action, r) ? `To undo: ${rollbackFor(action, r)}` : null,
      '',
      '---',
      `Run by Swoop after approval. Execution ${executionId}.`,
    ].filter((l): l is string => l !== null);
    await psa.addTicketNote(ctx.row.ticketId, lines.join('\n'), true);
    await db.update(executions).set({ notePosted: true }).where(eq(executions.id, executionId));
  }
  if (policy.replyToRequester) {
    const reply = requesterReply(action, r);
    if (reply) {
      await psa.addTicketNote(ctx.row.ticketId, reply, false);
      await db.update(executions).set({ replyPosted: true }).where(eq(executions.id, executionId));
    }
  }
}

/** Short, secret-free confirmations. Never a password, never internal detail. */
function requesterReply(action: string, r: Resolved): string | null {
  const name = r.user.displayName ?? r.user.upn;
  switch (action) {
    case 'password_reset':
      return `Hi — we've reset the password for ${name}. We'll get the temporary password to you through our usual secure channel; it must be changed at first sign-in.`;
    case 'mfa_reset':
      return `Hi — ${name}'s multi-factor sign-in has been reset. At their next sign-in they'll be asked to set it up again.`;
    case 'group_add':
      return `Hi — ${name} now has access to ${r.group?.displayName}. It can take a few minutes to appear.`;
    case 'group_remove':
      return `Hi — ${name} has been removed from ${r.group?.displayName}.`;
    case 'license_assign':
      return `Hi — ${name} has been given a ${r.licence?.name} licence. Apps can take up to an hour to recognise it.`;
    case 'license_remove':
      return `Hi — the ${r.licence?.name} licence has been removed from ${name}.`;
    case 'account_disable':
      return `Hi — ${name}'s account has been disabled and signed out everywhere.`;
    case 'account_enable':
      return `Hi — ${name}'s account has been re-enabled.`;
    default:
      return null;
  }
}

// ─── Secrets, stale runs and human resolution ──────────────────────────────────

/** Returns a run's secret once, then wipes it. */
export async function revealSecret(executionId: string, user: SessionUser): Promise<string> {
  const [row] = await db.select().from(executions).where(eq(executions.id, executionId)).limit(1);
  if (!row) throw new ExecutionRefused('Execution not found', 404);
  if (!row.secret) {
    throw new ExecutionRefused(
      row.secretRevealedBy ? `Already revealed by ${row.secretRevealedBy}. Secrets are shown once.` : 'There is no secret to reveal, or it has expired.',
      410,
    );
  }
  if ((row.secretExpiresAt ?? 0) < Math.floor(Date.now() / 1000)) {
    await db.update(executions).set({ secret: null }).where(eq(executions.id, executionId));
    throw new ExecutionRefused('The secret expired and was wiped.', 410);
  }
  const cfg = config();
  const value = cfg.encryptionEnabled ? decrypt(row.secret, cfg.encryptionKey) : row.secret;
  await db
    .update(executions)
    .set({ secret: null, secretRevealedBy: user.email, secretRevealedAt: Math.floor(Date.now() / 1000) })
    .where(eq(executions.id, executionId));
  await recordAudit({
    user,
    action: 'execution.secret_reveal',
    targetType: 'execution',
    targetId: executionId,
    tenantId: row.tenantId,
    detail: { action: row.action, target: row.target },
  });
  return value;
}

/**
 * A person records what really happened to an uncertain run, after checking
 * the tenant. Marking it failed allows a fresh run; succeeded closes it.
 */
export async function resolveUncertain(
  executionId: string,
  outcome: 'succeeded' | 'failed',
  note: string | null,
  user: SessionUser,
): Promise<void> {
  const [row] = await db.select().from(executions).where(eq(executions.id, executionId)).limit(1);
  if (!row) throw new ExecutionRefused('Execution not found', 404);
  if (row.status !== 'uncertain') throw new ExecutionRefused('Only an uncertain run can be resolved by hand.');
  const summary = `${row.summary ?? ''} — Resolved by ${user.email} as ${outcome}${note ? `: ${note}` : ''}.`;
  await db
    .update(executions)
    .set({ status: outcome === 'succeeded' ? 'succeeded' : 'failed', verification: outcome === 'succeeded' ? 'reported' : 'failed', summary })
    .where(eq(executions.id, executionId));
  await db.update(actionLogs).set({ executionState: outcome === 'succeeded' ? 'succeeded' : 'failed' }).where(eq(actionLogs.id, row.actionLogId));
  await recordAudit({
    user,
    action: 'execution.resolve',
    targetType: 'execution',
    targetId: executionId,
    tenantId: row.tenantId,
    detail: { outcome, note },
  });
}

/**
 * Housekeeping: a run left "running" by a crash becomes uncertain (a person
 * must check), and secrets past their expiry are wiped.
 */
export async function sweepExecutions(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const stale = await db
    .select({ id: executions.id, actionLogId: executions.actionLogId, mode: executions.mode })
    .from(executions)
    .where(and(eq(executions.status, 'running'), lt(executions.startedAt, now - STALE_RUN_SECONDS)));
  for (const run of stale) {
    const status = run.mode === 'live' ? 'uncertain' : 'failed';
    await db
      .update(executions)
      .set({ status, summary: 'Interrupted — Swoop stopped before this run finished. Check the tenant before retrying.', finishedAt: now })
      .where(eq(executions.id, run.id));
    if (run.mode === 'live') await db.update(actionLogs).set({ executionState: status }).where(eq(actionLogs.id, run.actionLogId));
  }
  await db.update(executions).set({ secret: null }).where(lt(executions.secretExpiresAt, now));
}

export async function listExecutions(
  logId: string,
): Promise<Array<Omit<Execution, 'secret' | 'steps'> & { hasSecret: boolean; steps: ExecutionStep[] }>> {
  const rows = await db
    .select()
    .from(executions)
    .where(eq(executions.actionLogId, logId))
    .orderBy(desc(executions.startedAt));
  return rows.map(({ secret, steps, ...rest }) => ({
    ...rest,
    hasSecret: Boolean(secret),
    steps: parse<ExecutionStep[]>(steps) ?? [],
  }));
}

/** Runs a policy-driven execution once the last approval lands. */
export async function maybeRunOnApproval(logId: string, user: SessionUser | null): Promise<void> {
  const [row] = await db.select({ tenantId: actionLogs.tenantId }).from(actionLogs).where(eq(actionLogs.id, logId)).limit(1);
  if (!row?.tenantId) return;
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, row.tenantId)).limit(1);
  if (!tenant) return;
  const policy = readExecutionPolicy(tenant.executionPolicy);
  if (!policy.runOnApproval || effectiveMode(policy) !== 'live') return;
  try {
    if (policy.requireDryRun) {
      const dry = await startExecution(logId, 'dry_run', user, { await: true });
      await dry.done;
    }
    await startExecution(logId, 'live', user);
  } catch (err) {
    // Not ready is not an error: the reasons are on the ticket page.
    log.info(`Ticket ${logId}: not run on approval — ${describeError(err)}`);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function redact(text: string | null, secret: string | null): string | null {
  if (!text) return text;
  return secret ? text.split(secret).join('••••••••') : text;
}

function parse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const _internals = { resolve, buildRequests, verify, readinessFor };
