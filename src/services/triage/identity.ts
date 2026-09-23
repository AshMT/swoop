import type { Client } from '../../types';
import { parseEmailList } from './tenancy';

/**
 * Who is asking, and are they allowed to?
 *
 * MSPs agree with each client who may request changes — usually the owner,
 * the office manager and HR. A new staff member cannot ask for someone else
 * to be added to the finance group, and a leaver's manager's personal Gmail
 * cannot ask for the leaver's account to be re-enabled. Tenant recognition
 * says which company a request belongs to; this says whether the person is
 * entitled to make it.
 */

/** Changes that act on someone else and so need an authorised requester. */
const ON_BEHALF_ACTIONS = new Set([
  'password_reset',
  'mfa_reset',
  'group_add',
  'group_remove',
  'license_assign',
  'license_remove',
  'account_disable',
  'account_enable',
  'mailbox_permission',
]);

/** Self-service requests any staff member may make for their own account. */
const SELF_SERVICE_ACTIONS = new Set(['password_reset', 'mfa_reset']);

export interface IdentityAssessment {
  /** The client has an authorised-contact list at all. */
  configured: boolean;
  requesterIsTarget: boolean;
  requesterAuthorised: boolean;
  /** Set when the request must not go ahead as it stands. */
  blocker: string | null;
  /** Shown to approvers as context. */
  note: string;
}

export function assessIdentity(input: {
  client: Pick<Client, 'authorisedContacts' | 'name'>;
  action: string;
  requesterEmail: string | null;
  targetEmail: string | null;
}): IdentityAssessment {
  const authorised = parseEmailList(input.client.authorisedContacts);
  const requester = input.requesterEmail?.trim().toLowerCase() ?? null;
  const target = input.targetEmail?.trim().toLowerCase() ?? null;
  const requesterIsTarget = Boolean(requester && target && requester === target);
  const requesterAuthorised = Boolean(requester && authorised.includes(requester));
  const configured = authorised.length > 0;

  let blocker: string | null = null;
  let note: string;

  if (!ON_BEHALF_ACTIONS.has(input.action)) {
    note = 'No change to anyone’s account is proposed.';
  } else if (requesterIsTarget && SELF_SERVICE_ACTIONS.has(input.action)) {
    // A self-service reset is normal — and also exactly what an attacker in
    // control of the mailbox would ask for, which is why it still needs an
    // approver to confirm identity out of band.
    note = 'The requester is asking about their own account. Confirm it is really them before resetting.';
  } else if (requesterAuthorised) {
    note = `${requester} is an authorised contact for ${input.client.name}.`;
  } else if (!configured) {
    note = `${input.client.name} has no authorised contacts set, so Swoop cannot check whether the requester may ask for this.`;
  } else {
    blocker = `${requester ?? 'The requester'} is not an authorised contact for ${input.client.name}. Confirm the request with one of: ${authorised.join(', ')}.`;
    note = blocker;
  }

  return { configured, requesterIsTarget, requesterAuthorised, blocker, note };
}
