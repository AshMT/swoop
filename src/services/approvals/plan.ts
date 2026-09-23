import { findActionType } from '../../domain/classifications';
import type { ClassificationEntities } from '../../types';
import type { TenancyAssessment } from '../triage/tenancy';
import type { UserEnrichment } from '../cipp/enrichment';
import type { IdentityAssessment } from '../triage/identity';

/**
 * The execution plan: exactly what would run in the client's tenant if this
 * proposal were carried out, as CIPP API calls.
 *
 * Never executed by Swoop today. It exists so an approver signs off on a
 * concrete, reviewable change — "POST ExecResetPass for sarah@acme.com in
 * acme.onmicrosoft.com" — rather than a paraphrase, and so a technician can
 * carry it out without re-deriving it. Endpoint names and body shapes follow
 * CIPP's own OpenAPI spec (Config/openapi.json in CIPP-API).
 */

export interface PlanStep {
  order: number;
  description: string;
  method: 'GET' | 'POST';
  endpoint: string;
  payload: Record<string, unknown> | Array<Record<string, unknown>> | null;
}

export interface PlanCheck {
  description: string;
  /** 'warn' is worth knowing but does not stop the change. */
  status: 'pass' | 'fail' | 'warn' | 'unknown';
  detail?: string;
}

export interface ExecutionPlan {
  action: string;
  actionLabel: string;
  backend: 'cipp';
  /** tenantFilter for CIPP — the client's default domain or tenant id. */
  tenant: string | null;
  target: string | null;
  steps: PlanStep[];
  prechecks: PlanCheck[];
  /** Anything that stops the plan being carried out as written. */
  blockers: string[];
  /** Who asked and whether they may — see triage/identity.ts. */
  identity: IdentityAssessment | null;
  reversible: boolean;
  rollback: string | null;
  /** Always false in this release: plans are for people to carry out. */
  executable: false;
  note: string;
}

export function buildExecutionPlan(input: {
  classification: string;
  entities: ClassificationEntities;
  tenancy: TenancyAssessment | null;
  enrichment: UserEnrichment | null;
  identity?: IdentityAssessment | null;
}): ExecutionPlan | null {
  const action = findActionType(input.classification);
  if (!action || action.plannedBackend !== 'cipp') return null;

  const tenant = input.tenancy?.m365?.defaultDomain || input.tenancy?.m365?.tenantId || null;
  const upn = input.entities.target_user_email;
  const group = input.entities.group_name;
  const licence = input.entities.license_sku;
  const displayName = input.entities.target_user_display_name ?? upn;

  const blockers: string[] = [];
  if (!tenant) blockers.push('No Microsoft 365 tenant is mapped to this client — set it on the Clients page.');
  if (!upn) blockers.push('The ticket does not name the target user by email address.');
  if (input.tenancy?.crossTenant) {
    blockers.push('The request crosses clients. Confirm it with a known contact at the target client before anything is changed.');
  }
  if (input.tenancy?.flags.includes('target_unrecognised_domain')) {
    blockers.push(`The target address is not on a domain ${input.tenancy.clientName} owns.`);
  }
  if (input.identity?.blocker) blockers.push(input.identity.blocker);

  const T = tenant ?? '<tenant>';
  const U = upn ?? '<user>';
  const steps: PlanStep[] = [];
  let reversible = true;
  let rollback: string | null = null;

  const lookup: PlanStep = {
    order: 1,
    description: `Confirm ${U} exists in ${T} and read its current state`,
    method: 'GET',
    endpoint: '/api/ListUsers',
    payload: { tenantFilter: T, UserID: U },
  };

  switch (action.id) {
    case 'password_reset':
      steps.push(lookup, {
        order: 2,
        description: `Reset the password for ${U} and require a change at next sign-in`,
        method: 'POST',
        endpoint: '/api/ExecResetPass',
        payload: { tenantFilter: T, ID: U, displayName, MustChange: true },
      });
      reversible = false;
      rollback = 'A password reset cannot be undone; the user sets a new password at next sign-in.';
      break;

    case 'mfa_reset':
      steps.push(lookup, {
        order: 2,
        description: `Remove ${U}'s registered MFA methods so they re-register at next sign-in`,
        method: 'POST',
        endpoint: '/api/ExecResetMFA',
        payload: { tenantFilter: T, ID: U },
      });
      reversible = false;
      rollback = 'Removed methods cannot be restored; the user re-registers MFA.';
      break;

    case 'group_add':
    case 'group_remove': {
      if (!group) blockers.push('The ticket does not name the group.');
      const G = group ?? '<group>';
      // CIPP needs the member's object id in `value`; removal fails without it.
      const member = [{ value: '<user id from step 1>', label: U, addedFields: { userPrincipalName: U } }];
      steps.push(
        lookup,
        {
          order: 2,
          description: `Find the group "${G}" in ${T}`,
          method: 'GET',
          endpoint: '/api/ListGroups',
          payload: { tenantFilter: T },
        },
        {
          order: 3,
          description:
            action.id === 'group_add' ? `Add ${U} to "${G}"` : `Remove ${U} from "${G}"`,
          method: 'POST',
          endpoint: '/api/EditGroup',
          payload: {
            tenantFilter: T,
            groupId: { value: '<group id from step 2>', label: G, addedFields: { groupName: G, groupType: '<from step 2>' } },
            [action.id === 'group_add' ? 'AddMember' : 'RemoveMember']: member,
          },
        },
      );
      rollback =
        action.id === 'group_add' ? `Remove ${U} from "${G}" with EditGroup RemoveMember.` : `Add ${U} back to "${G}" with EditGroup AddMember.`;
      break;
    }

    case 'license_assign':
    case 'license_remove': {
      if (!licence) blockers.push('The ticket does not name the licence.');
      const L = licence ?? '<licence>';
      steps.push(
        lookup,
        {
          order: 2,
          description: `Check ${T} has a free "${L}" licence and find its SKU id`,
          method: 'GET',
          endpoint: '/api/ListLicenses',
          payload: { tenantFilter: T },
        },
        {
          order: 3,
          description: action.id === 'license_assign' ? `Assign "${L}" to ${U}` : `Remove "${L}" from ${U}`,
          method: 'POST',
          endpoint: '/api/ExecBulkLicense',
          payload: [
            {
              tenantFilter: T,
              userIds: ['<user id from step 1>'],
              ...(action.id === 'license_assign'
                ? { LicenseOperation: 'Add', Licenses: [{ label: L, value: '<sku id from step 2>' }] }
                : // Removal reads LicensesToRemove; sending Licenses removes nothing.
                  {
                    LicenseOperation: 'Remove',
                    RemoveAllLicenses: false,
                    LicensesToRemove: [{ label: L, value: '<sku id from step 2>' }],
                  }),
            },
          ],
        },
      );
      rollback =
        action.id === 'license_assign'
          ? `Remove "${L}" from ${U}.`
          : `Re-assign "${L}" to ${U}. Removing a licence can start mailbox and OneDrive retention clocks — check before removing.`;
      break;
    }

    case 'account_disable':
      steps.push(
        lookup,
        {
          order: 2,
          description: `Block sign-in for ${U}`,
          method: 'POST',
          endpoint: '/api/ExecDisableUser',
          payload: { tenantFilter: T, ID: U, Enable: false },
        },
        {
          order: 3,
          description: `Revoke ${U}'s active sessions so the block takes effect now`,
          method: 'POST',
          endpoint: '/api/ExecRevokeSessions',
          payload: { tenantFilter: T, id: U, Username: U },
        },
      );
      rollback = `Re-enable with ExecDisableUser and Enable: true.`;
      break;

    case 'account_enable':
      steps.push(lookup, {
        order: 2,
        description: `Allow sign-in for ${U}`,
        method: 'POST',
        endpoint: '/api/ExecDisableUser',
        payload: { tenantFilter: T, ID: U, Enable: true },
      });
      rollback = `Block sign-in again with ExecDisableUser and Enable: false.`;
      break;

    case 'mailbox_permission': {
      const mailbox = group ?? '<shared mailbox>';
      if (!group) blockers.push('The ticket does not name the mailbox.');
      steps.push(lookup, {
        order: 2,
        description: `Give ${U} full access to ${mailbox} (confirm the exact rights with the requester)`,
        method: 'POST',
        endpoint: '/api/ExecEditMailboxPermissions',
        // CIPP reads these as React-Select objects; a bare string silently does nothing.
        payload: { tenantfilter: T, userID: mailbox, AddFullAccess: [{ value: U }] },
      });
      rollback = `Remove with ExecEditMailboxPermissions RemoveFullAccess: [{ value: "${U}" }].`;
      break;
    }

    default:
      return null;
  }

  return {
    action: action.id,
    actionLabel: action.label,
    backend: 'cipp',
    tenant,
    target: upn,
    steps,
    prechecks: buildPrechecks(action.id, input.enrichment, licence, group),
    blockers,
    identity: input.identity ?? null,
    reversible,
    rollback,
    executable: false,
    note: 'Swoop does not carry out plans in this release. A technician runs these steps in CIPP after approval.',
  };
}

function buildPrechecks(
  action: string,
  enrichment: UserEnrichment | null,
  licence: string | null,
  group: string | null,
): PlanCheck[] {
  if (!enrichment) {
    return [{ description: 'Look the user up in CIPP', status: 'unknown', detail: 'CIPP lookups are not configured' }];
  }
  if (!enrichment.found) {
    return [
      {
        description: 'User exists in the tenant',
        status: 'fail',
        detail: enrichment.error ?? 'No user with that address',
      },
    ];
  }

  const checks: PlanCheck[] = [{ description: 'User exists in the tenant', status: 'pass', detail: enrichment.displayName ?? undefined }];

  if (enrichment.onPremisesSync) {
    checks.push({
      description: 'Cloud-managed account',
      // A reset goes through password writeback and works, asynchronously;
      // sign-in changes are undone by the next sync.
      status: action === 'account_disable' || action === 'account_enable' ? 'fail' : action === 'password_reset' ? 'warn' : 'pass',
      detail:
        action === 'password_reset'
          ? 'Synced from on-premises AD — the reset uses password writeback and completes asynchronously'
          : 'Synced from on-premises AD — change it there, or the next sync reverts it',
    });
  }

  if (action === 'account_enable') {
    checks.push({
      description: 'Account is currently disabled',
      status: enrichment.accountEnabled === false ? 'pass' : 'fail',
      detail: enrichment.accountEnabled ? 'Already enabled' : undefined,
    });
  }
  if (action === 'account_disable' || action === 'password_reset' || action === 'mfa_reset') {
    checks.push({
      description: 'Account is enabled',
      status: enrichment.accountEnabled === false ? 'fail' : enrichment.accountEnabled ? 'pass' : 'unknown',
      detail: enrichment.accountEnabled === false ? 'Already disabled' : undefined,
    });
  }
  if (action === 'mfa_reset') {
    checks.push({
      description: 'User has MFA methods registered',
      status: enrichment.mfa?.registered === false ? 'fail' : enrichment.mfa?.registered ? 'pass' : 'unknown',
      detail: enrichment.mfa?.methods.length ? enrichment.mfa.methods.join(', ') : undefined,
    });
  }
  if ((action === 'license_assign' || action === 'license_remove') && licence) {
    const has = enrichment.licences.some((l) => l.toLowerCase().includes(licence.toLowerCase()));
    checks.push({
      description: action === 'license_assign' ? 'User does not already have the licence' : 'User has the licence',
      status: action === 'license_assign' ? (has ? 'fail' : 'pass') : has ? 'pass' : 'fail',
      detail: enrichment.licences.join(', ') || 'No licences',
    });
  }
  if ((action === 'group_add' || action === 'group_remove') && group && enrichment.groups) {
    const member = enrichment.groups.some((g) => g.toLowerCase() === group.toLowerCase());
    checks.push({
      description: action === 'group_add' ? 'User is not already a member' : 'User is a member',
      status: action === 'group_add' ? (member ? 'fail' : 'pass') : member ? 'pass' : 'fail',
    });
  }
  return checks;
}
