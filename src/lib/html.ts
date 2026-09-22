/**
 * HTML → plain text for ticket bodies.
 *
 * PSA ticket bodies arrive as rich text, and feeding raw markup to a model
 * wastes context on tags and confuses small local models. This is deliberately
 * a text cleaner, not a sanitiser — output is only ever sent to the AI provider
 * and rendered as text, never injected into a page as HTML.
 */

const BLOCK_TAGS = /<\/?(?:p|div|br|tr|li|h[1-6]|blockquote|section|article|pre|table)\b[^>]*>/gi;

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&ldquo;': '“',
  '&rdquo;': '”',
};

export function htmlToText(input: string | null | undefined): string {
  if (!input) return '';

  let text = input;

  // Drop content that is never part of the message.
  text = text.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');

  // Preserve paragraph structure before stripping the rest of the markup.
  text = text.replace(BLOCK_TAGS, '\n');
  text = text.replace(/<[^>]+>/g, '');

  // Named and numeric entities.
  text = text.replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, (match) => {
    const named = ENTITIES[match.toLowerCase()];
    if (named) return named;
    const decimal = /^&#(\d+);$/.exec(match);
    if (decimal) return safeCodePoint(Number.parseInt(decimal[1], 10));
    const hex = /^&#x([0-9a-f]+);$/i.exec(match);
    if (hex) return safeCodePoint(Number.parseInt(hex[1], 16));
    return match;
  });

  // Collapse the whitespace the markup left behind.
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/[ \t\u00a0]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 9 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Trims a ticket body to a sane prompt size, keeping the head (where the actual
 * request almost always is) and the tail (where a signature or a late "actually,
 * make that X" tends to live).
 */
export function truncateForPrompt(text: string, maxChars = 6000): string {
  if (text.length <= maxChars) return text;
  const headSize = Math.floor(maxChars * 0.75);
  const tailSize = maxChars - headSize;
  const omitted = text.length - maxChars;
  return `${text.slice(0, headSize)}\n\n[... ${omitted} characters omitted ...]\n\n${text.slice(-tailSize)}`;
}
