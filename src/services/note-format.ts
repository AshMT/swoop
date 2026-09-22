import { findActionType } from '../domain/classifications';
import type { AiClassification } from '../types';

export interface NoteContext {
  mspName: string;
  /** Appended when Swoop is running without write-back enabled. */
  dryRun?: boolean;
  adjustments?: string[];
}

/**
 * Renders the private internal note posted back to the ticket.
 *
 * Written for a technician skimming a ticket timeline: the verdict first, the
 * evidence second, and an unambiguous statement that nothing was executed.
 */
export function formatProposalNote(classification: AiClassification, context: NoteContext): string {
  const action = findActionType(classification.classification);
  const confidencePct = Math.round(classification.confidence * 100);

  const lines: string[] = [];

  lines.push(`Swoop AI triage — ${context.mspName}`);
  lines.push('');

  if (classification.classification === 'ESCALATE') {
    lines.push('Verdict: escalate to a human.');
    if (classification.escalation_reason) lines.push(`Reason: ${classification.escalation_reason}`);
  } else if (classification.classification === 'FOLLOW_UP') {
    lines.push('Verdict: more information needed from the requester.');
    if (classification.follow_up_question) {
      lines.push('');
      lines.push(`Suggested question: ${classification.follow_up_question}`);
    }
  } else {
    lines.push(`Proposed action: ${action?.label ?? classification.classification}`);
  }

  lines.push('');
  lines.push(`Confidence: ${confidencePct}%   Sensitivity: ${classification.sensitivity}`);

  if (classification.sensitivity === 'high') {
    lines.push('Flagged high sensitivity — requires human approval regardless of confidence.');
  }

  lines.push('');
  lines.push(`Reasoning: ${classification.reasoning}`);

  const entityLines = describeEntities(classification);
  if (entityLines.length > 0) {
    lines.push('');
    lines.push('Details extracted from the ticket:');
    lines.push(...entityLines);
  }

  if (classification.classification !== 'ESCALATE' && classification.classification !== 'FOLLOW_UP') {
    lines.push('');
    lines.push(`Suggested next step: ${classification.proposed_psa_note}`);
  }

  if (context.adjustments && context.adjustments.length > 0) {
    lines.push('');
    lines.push(`Notes on this classification: ${context.adjustments.join('; ')}.`);
  }

  lines.push('');
  lines.push('---');
  lines.push(
    context.dryRun
      ? 'Swoop is in read-only preview mode. Nothing has been changed and no action has been taken.'
      : 'Swoop proposes actions only. Nothing has been changed and no action has been taken.',
  );

  return lines.join('\n');
}

function describeEntities(classification: AiClassification): string[] {
  const { entities } = classification;
  const out: string[] = [];
  if (entities.target_user_email) out.push(`  User: ${entities.target_user_email}`);
  if (entities.target_user_display_name) out.push(`  Name: ${entities.target_user_display_name}`);
  if (entities.group_name) out.push(`  Group: ${entities.group_name}`);
  if (entities.license_sku) out.push(`  Licence: ${entities.license_sku}`);
  return out;
}
