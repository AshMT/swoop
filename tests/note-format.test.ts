import './setup-env';
import { describe, expect, it } from 'vitest';
import { formatProposalNote, isNoteFormat, NOTE_FORMATS } from '../src/services/note-format';
import type { AiClassification } from '../src/types';

const base: AiClassification = {
  classification: 'password_reset',
  confidence: 0.92,
  sensitivity: 'normal',
  entities: {
    target_user_email: 'sarah@acme.com',
    target_user_display_name: 'Sarah Jones',
    group_name: null,
    license_sku: null,
  },
  reasoning: 'Explicit request.',
  follow_up_question: null,
  escalation_reason: null,
  proposed_psa_note: 'Reset the password.',
};

const ctx = { mspName: 'MightyIT' };

describe('formatProposalNote — shared content', () => {
  // Whatever the format, the note must carry the same facts. Rendering from
  // one model is what stops the three renderers drifting apart.
  for (const format of ['plain', 'markdown', 'html'] as const) {
    it(`carries the verdict, confidence, entities and disclaimer in ${format}`, () => {
      const note = formatProposalNote(base, { ...ctx, format });
      expect(note).toContain('MightyIT');
      expect(note).toContain('Password reset');
      expect(note).toContain('92%');
      expect(note).toContain('sarah@acme.com');
      expect(note.toLowerCase()).toContain('no action has been taken');
    });

    it(`states preview mode in ${format}`, () => {
      const note = formatProposalNote(base, { ...ctx, format, dryRun: true });
      expect(note.toLowerCase()).toContain('read-only preview mode');
    });

    it(`leads with the question for a FOLLOW_UP in ${format}`, () => {
      const note = formatProposalNote(
        { ...base, classification: 'FOLLOW_UP', follow_up_question: 'Which mailbox?' },
        { ...ctx, format },
      );
      expect(note).toContain('Which mailbox?');
    });

    it(`flags high sensitivity in ${format}`, () => {
      const note = formatProposalNote({ ...base, sensitivity: 'high' }, { ...ctx, format });
      expect(note.toLowerCase()).toContain('high sensitivity');
    });
  }
});

describe('plain text', () => {
  it('is the default when no format is given', () => {
    expect(formatProposalNote(base, ctx)).toBe(formatProposalNote(base, { ...ctx, format: 'plain' }));
  });

  // The point of plain is that it reads correctly even where nothing renders.
  it('contains no markup', () => {
    const note = formatProposalNote(base, { ...ctx, format: 'plain' });
    expect(note).not.toMatch(/\*\*/);
    expect(note).not.toMatch(/<[a-z]+>/);
  });
});

describe('markdown', () => {
  it('uses bold and bullets', () => {
    const note = formatProposalNote(base, { ...ctx, format: 'markdown' });
    expect(note).toMatch(/\*\*/);
    expect(note).toMatch(/^- /m);
  });

  /**
   * A ticket subject or an extracted group name is attacker-influenced text.
   * Unescaped, a value containing `**` or a leading `#` restructures the note.
   */
  it('escapes emphasis and code syntax in ticket-derived values', () => {
    const note = formatProposalNote(
      {
        ...base,
        entities: { ...base.entities, group_name: '**Domain Admins** `whoami` [link](x)' },
      },
      { ...ctx, format: 'markdown' },
    );
    expect(note).toContain('\\*\\*Domain Admins\\*\\*');
    expect(note).toContain('\\`whoami\\`');
    expect(note).toContain('\\[link\\]');
  });

  it('escapes block constructs only at the start of a line', () => {
    const note = formatProposalNote(
      { ...base, reasoning: '# Heading attempt\n> quote attempt' },
      { ...ctx, format: 'markdown' },
    );
    expect(note).toContain('\\# Heading attempt');
    expect(note).toContain('\\> quote attempt');
  });

  /**
   * A blanket escape of every punctuation mark turns an email address into
   * `sarah\.jones@acme\.com`, which is valid Markdown and unreadable anywhere
   * that does not render it. Readability is the whole reason to offer plain.
   */
  it('leaves ordinary punctuation alone so addresses stay readable', () => {
    const note = formatProposalNote(
      {
        ...base,
        entities: { ...base.entities, target_user_email: 'sarah.jones@acme.co.uk' },
        reasoning: 'Locked out (again). Urgent!',
      },
      { ...ctx, format: 'markdown' },
    );
    expect(note).toContain('sarah.jones@acme.co.uk');
    expect(note).toContain('Locked out (again). Urgent!');
  });
});

describe('html', () => {
  it('uses real elements', () => {
    const note = formatProposalNote(base, { ...ctx, format: 'html' });
    expect(note).toContain('<p>');
    expect(note).toContain('<strong>');
    expect(note).toContain('<li>');
  });

  /**
   * The note is written into a page a technician reads, and entity values come
   * from the ticket, so an unescaped value is stored XSS against your own techs.
   */
  it('escapes HTML in ticket-derived values', () => {
    const note = formatProposalNote(
      {
        ...base,
        entities: {
          ...base.entities,
          group_name: '<script>alert(document.cookie)</script>',
          target_user_display_name: 'Bobby "Drop" O\'Brien & Co <b>',
        },
      },
      { ...ctx, format: 'html' },
    );
    expect(note).not.toContain('<script>');
    expect(note).toContain('&lt;script&gt;');
    expect(note).toContain('&amp;');
    expect(note).toContain('&quot;');
    expect(note).toContain('&#39;');
  });

  it('escapes the reasoning, which is model output', () => {
    const note = formatProposalNote(
      { ...base, reasoning: 'The user said <img src=x onerror=alert(1)>' },
      { ...ctx, format: 'html' },
    );
    expect(note).not.toContain('<img');
    expect(note).toContain('&lt;img');
  });
});

describe('isNoteFormat', () => {
  it('accepts the supported formats', () => {
    for (const format of NOTE_FORMATS) {
      expect(isNoteFormat(format.id)).toBe(true);
    }
  });

  it('rejects anything else, so a stray database value falls back to plain', () => {
    expect(isNoteFormat('rtf')).toBe(false);
    expect(isNoteFormat(null)).toBe(false);
    expect(isNoteFormat(undefined)).toBe(false);
    expect(isNoteFormat('')).toBe(false);
  });
});
