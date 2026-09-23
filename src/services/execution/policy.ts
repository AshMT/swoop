import { z } from 'zod';
import { config } from '../../config';
import { createLogger } from '../../lib/logger';

const log = createLogger('Execution');

/**
 * Which approved changes Swoop may carry out itself, and how.
 *
 * Off by default, and every field is an allowlist: an action or a client not
 * named here is never executed, so a new client added next month is safe
 * until someone decides otherwise.
 */
export const executionPolicySchema = z.object({
  /** 'off' — plans only. 'dry_run' — resolve and check, never send. 'live' — carry out. */
  mode: z.enum(['off', 'dry_run', 'live']).default('off'),
  /** Action ids that may run. */
  actions: z.array(z.string()).default([]),
  /** Client ids that may have changes run. Empty means none. */
  clientIds: z.array(z.string()).default([]),
  /** A successful dry run of the same proposal must precede a live run. */
  requireDryRun: z.boolean().default(true),
  /** Start the run as soon as the last approval lands, instead of waiting for a click. */
  runOnApproval: z.boolean().default(false),
  /** Post the outcome to the ticket as a private note. */
  postResultNote: z.boolean().default(true),
  /** Post a short public reply to the requester once a change is verified. */
  replyToRequester: z.boolean().default(false),
});

export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;
export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = executionPolicySchema.parse({});

export function readExecutionPolicy(raw: string | null | undefined): ExecutionPolicy {
  if (!raw) return DEFAULT_EXECUTION_POLICY;
  try {
    const parsed = executionPolicySchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    log.warn(`Stored execution policy is invalid — treating execution as off: ${parsed.error.issues[0]?.message}`);
  } catch {
    log.warn('Stored execution policy is not valid JSON — treating execution as off');
  }
  return DEFAULT_EXECUTION_POLICY;
}

/** The mode actually in force, after the install-wide kill switch. */
export function effectiveMode(policy: ExecutionPolicy): ExecutionPolicy['mode'] {
  return config().executionDisabled ? 'off' : policy.mode;
}
