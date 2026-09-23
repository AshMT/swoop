import { findActionType } from '../domain/classifications';
import { findCategory, PRIORITY_LABELS, isPriority } from '../domain/triage';
import type { AiClassification } from '../types';

/**
 * Renders the private internal note posted back to the ticket.
 *
 * The note is built once as a structure and then rendered into the format the
 * PSA actually displays. Whether SuperOps renders Markdown or HTML in a note
 * is not something that can be settled from outside a real instance, and
 * guessing wrong is visible to every technician on every ticket — a note full
 * of raw `**asterisks**` reads worse than plain text. So the format is an
 * operator setting that defaults to plain, and the structure is shared, so the
 * three renderers cannot drift apart.
 */

export type NoteFormat = 'plain' | 'markdown' | 'html';

export const NOTE_FORMATS: ReadonlyArray<{ id: NoteFormat; label: string; description: string }> = [
  {
    id: 'plain',
    label: 'Plain text',
    description: 'Safe everywhere. Reads correctly even if the PSA renders nothing.',
  },
  {
    id: 'markdown',
    label: 'Markdown',
    description: 'Bold headings and bullets, if your PSA renders Markdown in notes.',
  },
  {
    id: 'html',
    label: 'HTML',
    description: 'For a PSA whose notes are a rich-text field.',
  },
];

export function isNoteFormat(value: string | null | undefined): value is NoteFormat {
  return value === 'plain' || value === 'markdown' || value === 'html';
}

export interface NoteContext {
  mspName: string;
  /** Appended when Swoop is running without write-back enabled. */
  dryRun?: boolean;
  adjustments?: string[];
  /** Defaults to plain text. */
  format?: NoteFormat | null;
  /** What Swoop added to the model's verdict — omitted in previews. */
  triage?: NoteTriage | null;
}

export interface NoteTriage {
  priority: string;
  queue: string;
  signals: Array<{ label: string; detail: string; severity: string }>;
  related: Array<{ label: string; similarity: number }>;
  duplicateOf: string | null;
  approval: { state: string; required: number } | null;
  planBlockers: string[];
}

/** The note as structure, before it is rendered into a particular format. */
interface NoteModel {
  title: string;
  verdict: { label: string; emphasis: boolean };
  /** Short label/value pairs rendered inline. */
  facts: Array<{ label: string; value: string }>;
  /** Longer sections, each a heading and a paragraph. */
  sections: Array<{ heading: string; body: string }>;
  /** Bulleted lists, e.g. next steps and the extracted entities. */
  lists: Array<{ heading: string; items: string[] }>;
  /** The standing disclaimer, always last. */
  footer: string;
}

function buildModel(classification: AiClassification, context: NoteContext): NoteModel {
  const action = findActionType(classification.classification);
  const isEscalation = classification.classification === 'ESCALATE';
  const isFollowUp = classification.classification === 'FOLLOW_UP';
  const triage = classification.triage;
  const extra = context.triage ?? null;

  const sections: NoteModel['sections'] = [];
  const lists: NoteModel['lists'] = [];
  let verdictLabel: string;

  if (isEscalation) {
    verdictLabel = 'For a technician';
  } else if (isFollowUp) {
    verdictLabel = 'More information needed from the requester';
  } else {
    verdictLabel = `Proposed action: ${action?.label ?? classification.classification}`;
  }

  if (triage?.summary) sections.push({ heading: 'Summary', body: triage.summary });

  if (isEscalation && classification.escalation_reason) {
    sections.push({ heading: 'Why a technician', body: classification.escalation_reason });
  }
  if (isFollowUp && classification.follow_up_question) {
    sections.push({ heading: 'Suggested question', body: classification.follow_up_question });
  }

  if (extra && extra.signals.length > 0) {
    lists.push({
      heading: 'Flags',
      items: extra.signals.map((signal) => `${signal.label}: ${signal.detail}`),
    });
  }

  sections.push({ heading: 'Reasoning', body: classification.reasoning });

  if (triage && triage.next_steps.length > 0) {
    lists.push({ heading: 'Next steps', items: triage.next_steps });
  } else if (!isEscalation && !isFollowUp) {
    sections.push({ heading: 'Suggested next step', body: classification.proposed_psa_note });
  }

  if (triage?.first_response) {
    sections.push({ heading: 'Suggested reply to the requester', body: triage.first_response });
  }

  if (extra?.approval && extra.approval.state !== 'not_required') {
    const approvalText =
      extra.approval.state === 'auto_approved'
        ? 'Auto-approved under this tenant\'s policy. A technician carries out the plan; Swoop does not.'
        : extra.approval.state === 'pending'
          ? `Waiting for ${extra.approval.required === 2 ? 'two approvals' : 'one approval'} in Swoop before anyone acts on it.`
          : `Approval ${extra.approval.state.replace('_', ' ')}.`;
    sections.push({ heading: 'Approval', body: approvalText });
  }
  if (extra && extra.planBlockers.length > 0) {
    lists.push({ heading: 'Before this can be done', items: extra.planBlockers });
  }

  if (extra && (extra.duplicateOf || extra.related.length > 0)) {
    const items = extra.related.map((r) => `${r.label} (${Math.round(r.similarity * 100)}% similar)`);
    lists.push({ heading: extra.duplicateOf ? `Possible duplicate of ${extra.duplicateOf}` : 'Related tickets', items });
  }

  if (context.adjustments && context.adjustments.length > 0) {
    sections.push({
      heading: 'Notes on this triage',
      body: `${context.adjustments.join('; ')}.`,
    });
  }

  const facts: NoteModel['facts'] = [];
  if (extra && isPriority(extra.priority)) {
    facts.push({ label: 'Priority', value: `${extra.priority} ${PRIORITY_LABELS[extra.priority]}` });
  }
  if (triage) {
    const category = findCategory(triage.category)?.label ?? triage.category;
    facts.push({
      label: 'Category',
      value: triage.subcategory ? `${category} / ${triage.subcategory}` : category,
    });
  }
  if (extra?.queue) facts.push({ label: 'Queue', value: extra.queue });
  facts.push(
    { label: 'Confidence', value: `${Math.round(classification.confidence * 100)}%` },
    { label: 'Sensitivity', value: classification.sensitivity },
  );
  if (triage && triage.sentiment !== 'neutral') facts.push({ label: 'Tone', value: triage.sentiment });
  if (classification.sensitivity === 'high') {
    facts.push({
      label: 'Approval',
      value: 'Required regardless of confidence — flagged high sensitivity',
    });
  }

  const items = describeEntities(classification);
  if (items.length > 0) lists.push({ heading: 'Details extracted from the ticket', items });

  return {
    title: `Swoop triage — ${context.mspName}`,
    verdict: {
      label: verdictLabel,
      emphasis:
        classification.sensitivity === 'high' ||
        (extra ? extra.priority === 'P1' || extra.priority === 'P2' : isEscalation),
    },
    facts,
    sections,
    lists,
    footer: context.dryRun
      ? 'Swoop is in read-only preview mode. Nothing has been changed and no action has been taken.'
      : 'Swoop proposes actions only. Nothing has been changed and no action has been taken.',
  };
}

export function formatProposalNote(classification: AiClassification, context: NoteContext): string {
  const model = buildModel(classification, context);
  switch (context.format) {
    case 'markdown':
      return renderMarkdown(model);
    case 'html':
      return renderHtml(model);
    default:
      return renderPlain(model);
  }
}

function renderPlain(model: NoteModel): string {
  const lines: string[] = [model.title, '', model.verdict.label, ''];

  lines.push(model.facts.map((fact) => `${fact.label}: ${fact.value}`).join('   '));

  for (const section of model.sections) {
    lines.push('', `${section.heading}: ${section.body}`);
  }

  for (const list of model.lists) {
    lines.push('', `${list.heading}:`);
    lines.push(...list.items.map((item) => `  - ${item}`));
  }

  lines.push('', '---', model.footer);
  return lines.join('\n');
}

function renderMarkdown(model: NoteModel): string {
  const lines: string[] = [`**${escapeMarkdown(model.title)}**`, ''];

  lines.push(
    model.verdict.emphasis
      ? `> **${escapeMarkdown(model.verdict.label)}**`
      : `**${escapeMarkdown(model.verdict.label)}**`,
  );
  lines.push('');

  lines.push(
    model.facts
      .map((fact) => `**${escapeMarkdown(fact.label)}:** ${escapeMarkdown(fact.value)}`)
      .join(' · '),
  );

  for (const section of model.sections) {
    lines.push('', `**${escapeMarkdown(section.heading)}**`, '', escapeMarkdown(section.body));
  }

  for (const list of model.lists) {
    lines.push('', `**${escapeMarkdown(list.heading)}**`, '');
    lines.push(...list.items.map((item) => `- ${escapeMarkdown(item)}`));
  }

  lines.push('', '---', '', `_${escapeMarkdown(model.footer)}_`);
  return lines.join('\n');
}

function renderHtml(model: NoteModel): string {
  const parts: string[] = [`<p><strong>${escapeHtml(model.title)}</strong></p>`];

  parts.push(
    model.verdict.emphasis
      ? `<p><strong>${escapeHtml(model.verdict.label)}</strong></p>`
      : `<p>${escapeHtml(model.verdict.label)}</p>`,
  );

  parts.push(
    `<p>${model.facts
      .map((fact) => `<strong>${escapeHtml(fact.label)}:</strong> ${escapeHtml(fact.value)}`)
      .join(' &middot; ')}</p>`,
  );

  for (const section of model.sections) {
    parts.push(`<p><strong>${escapeHtml(section.heading)}</strong><br>${escapeHtml(section.body)}</p>`);
  }

  for (const list of model.lists) {
    parts.push(`<p><strong>${escapeHtml(list.heading)}</strong></p>`);
    parts.push(`<ul>${list.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`);
  }

  parts.push('<hr>');
  parts.push(`<p><em>${escapeHtml(model.footer)}</em></p>`);
  return parts.join('\n');
}

/**
 * Entity values come from the ticket, so they are attacker-influenced text
 * being written into a page a technician will read. Escaping is not optional.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Neutralises Markdown in ticket-derived text.
 *
 * Deliberately surgical rather than escaping every punctuation mark: a blanket
 * escape turns `sarah.jones@acme.com` into `sarah\.jones@acme\.com`, which is
 * valid Markdown and unreadable in a PSA that renders nothing. Only the
 * characters that can actually restructure the note are escaped — emphasis,
 * code and link syntax inline, and block constructs at the start of a line.
 */
function escapeMarkdown(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      // Inline: emphasis, code spans and links.
      const inline = line.replace(/([\\`*_[\]])/g, '\\$1');
      // Block: a heading, quote, list marker or ordered-list number only has
      // meaning at the start of a line.
      return inline
        .replace(/^(\s*)([#>+])/, '$1\\$2')
        .replace(/^(\s*)-(\s)/, '$1\\-$2')
        .replace(/^(\s*)(\d+)\.(\s)/, '$1$2\\.$3');
    })
    .join('\n');
}

function describeEntities(classification: AiClassification): string[] {
  const { entities } = classification;
  const out: string[] = [];
  if (entities.target_user_email) out.push(`User: ${entities.target_user_email}`);
  if (entities.target_user_display_name) out.push(`Name: ${entities.target_user_display_name}`);
  if (entities.group_name) out.push(`Group: ${entities.group_name}`);
  if (entities.license_sku) out.push(`Licence: ${entities.license_sku}`);
  return out;
}
