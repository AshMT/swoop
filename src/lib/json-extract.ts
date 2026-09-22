/**
 * Pulls a JSON object out of an LLM response.
 *
 * Small local models — including qwen3, which this project recommends by
 * default — routinely wrap their answer in reasoning traces, code fences and
 * apologetic preamble. The previous implementation only stripped a fence at the
 * very start and end of the string, so a single `<think>` block made every
 * classification fall back to ESCALATE.
 */

export interface ExtractResult<T> {
  value: T | null;
  /** The substring that was parsed, useful for debugging a bad response. */
  json: string | null;
  error: string | null;
}

/** Reasoning-trace wrappers emitted by common open-weight models. */
const REASONING_BLOCKS = [
  /<think>[\s\S]*?<\/think>/gi,
  /<thinking>[\s\S]*?<\/thinking>/gi,
  /<reasoning>[\s\S]*?<\/reasoning>/gi,
  /<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi,
];

export function stripReasoning(input: string): string {
  let out = input;
  for (const pattern of REASONING_BLOCKS) out = out.replace(pattern, ' ');
  // An unterminated block means the model ran out of tokens mid-thought; drop
  // everything up to the opening tag so any JSON that follows is still found.
  out = out.replace(/<\/(?:think|thinking|reasoning)>/gi, ' ');
  return out;
}

/**
 * Finds the first balanced top-level `{...}` run, respecting string literals
 * and escapes so a brace inside a value cannot end the scan early.
 */
export function findJsonObject(input: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (char === '}') {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start !== -1) return input.slice(start, i + 1);
    }
  }

  // Unbalanced: a truncated response. Return what we have so the repair pass
  // below gets a chance at it.
  return start !== -1 ? input.slice(start) : null;
}

/**
 * Best-effort repairs for the ways model JSON is commonly malformed.
 * Applied only after a strict parse has already failed.
 */
export function repairJson(input: string): string {
  let out = input.trim();

  // Trailing commas before a close.
  out = out.replace(/,(\s*[}\]])/g, '$1');
  // Python/JS literals.
  out = out.replace(/:\s*None\b/g, ': null').replace(/:\s*True\b/g, ': true').replace(/:\s*False\b/g, ': false');
  // Single-quoted keys — only safe when the value side has no stray quotes.
  out = out.replace(/([{,]\s*)'([A-Za-z_][\w-]*)'(\s*:)/g, '$1"$2"$3');
  // Unquoted keys.
  out = out.replace(/([{,]\s*)([A-Za-z_][\w-]*)(\s*:)/g, '$1"$2"$3');
  // Re-quoting may have double-quoted an already-quoted key.
  out = out.replace(/""([A-Za-z_][\w-]*)""(\s*:)/g, '"$1"$2');

  // Close a truncated object: balance braces and brackets, dropping a dangling
  // key or comma first so the result is still valid.
  const balanced = balance(out);
  return balanced;
}

function balance(input: string): string {
  let out = input;
  let depthCurly = 0;
  let depthSquare = 0;
  let inString = false;
  let escaped = false;

  for (const char of out) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depthCurly++;
    else if (char === '}') depthCurly--;
    else if (char === '[') depthSquare++;
    else if (char === ']') depthSquare--;
  }

  if (inString) out += '"';
  // Drop a dangling `"key":` or trailing comma left by truncation.
  out = out.replace(/,\s*$/, '').replace(/"[^"]*"\s*:\s*$/, '').replace(/,\s*$/, '');
  out += ']'.repeat(Math.max(0, depthSquare));
  out += '}'.repeat(Math.max(0, depthCurly));
  return out;
}

/**
 * Extracts and parses the JSON object from a model response.
 * Tries, in order: the raw string, the reasoning-stripped string, the first
 * balanced object within it, and finally a repaired version of that object.
 */
export function extractJsonObject<T = unknown>(raw: string): ExtractResult<T> {
  if (!raw || !raw.trim()) {
    return { value: null, json: null, error: 'The model returned an empty response' };
  }

  const candidates: string[] = [];
  const push = (value: string | null) => {
    const trimmed = value?.trim();
    if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
  };

  const fenceStripped = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  push(fenceStripped);

  const withoutReasoning = stripReasoning(fenceStripped);
  push(withoutReasoning);
  push(findJsonObject(withoutReasoning));
  push(findJsonObject(raw));

  let lastError = 'No JSON object found in the model response';

  for (const candidate of candidates) {
    const direct = tryParse<T>(candidate);
    if (direct.ok) return { value: direct.value, json: candidate, error: null };
    lastError = direct.error;

    const repaired = repairJson(candidate);
    if (repaired !== candidate) {
      const fixed = tryParse<T>(repaired);
      if (fixed.ok) return { value: fixed.value, json: repaired, error: null };
    }
  }

  return { value: null, json: candidates[0] ?? null, error: lastError };
}

function tryParse<T>(input: string): { ok: true; value: T } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Parsed value is not a JSON object' };
    }
    return { ok: true, value: parsed as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'JSON parse failed' };
  }
}
