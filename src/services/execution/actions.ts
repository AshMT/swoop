/**
 * Execution properties of each action, kept beside the executor rather than
 * in the shared action list so the rules that gate a live change sit in one
 * reviewable place.
 */
export interface ExecutionTraits {
  /** Swoop can carry it out and prove it worked. */
  executable: boolean;
  /**
   * An approver must record how they confirmed the requester's identity. These
   * are the changes a help-desk impersonation attack is after: a new password,
   * new MFA, a re-enabled account, access to someone else's mail.
   */
  attestation: boolean;
  /** Reversible by Swoop's own counterpart action. */
  reversible: boolean;
}

export const EXECUTION_TRAITS: Record<string, ExecutionTraits> = {
  password_reset: { executable: true, attestation: true, reversible: false },
  mfa_reset: { executable: true, attestation: true, reversible: false },
  group_add: { executable: true, attestation: false, reversible: true },
  group_remove: { executable: true, attestation: false, reversible: true },
  license_assign: { executable: true, attestation: false, reversible: true },
  license_remove: { executable: true, attestation: false, reversible: true },
  account_disable: { executable: true, attestation: false, reversible: true },
  account_enable: { executable: true, attestation: true, reversible: true },
  // Plan-only for now: CIPP's mailbox permission endpoint reports success
  // without a cheap way to read the result back, and an unverifiable grant
  // of mailbox access is not something to automate.
  mailbox_permission: { executable: false, attestation: true, reversible: true },
};

export const EXECUTABLE_ACTIONS = Object.entries(EXECUTION_TRAITS)
  .filter(([, t]) => t.executable)
  .map(([id]) => id);

export const VERIFICATION_METHODS = [
  { id: 'callback_known_number', label: 'Called them back on the number we hold' },
  { id: 'authorised_contact_confirmed', label: 'An authorised contact confirmed it' },
  { id: 'in_person_or_video', label: 'In person or on video' },
  { id: 'verified_channel', label: 'Verified channel (e.g. their Teams account)' },
  { id: 'other', label: 'Other — explained in the note' },
] as const;

export type VerificationMethod = (typeof VERIFICATION_METHODS)[number]['id'];

export function needsAttestation(action: string | null | undefined): boolean {
  return Boolean(action && EXECUTION_TRAITS[action]?.attestation);
}
