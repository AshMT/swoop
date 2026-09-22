import './setup-env';
import { describe, expect, it } from 'vitest';
import { extractJsonObject, findJsonObject, repairJson, stripReasoning } from '../src/lib/json-extract';

const VALID = {
  classification: 'password_reset',
  confidence: 0.9,
  sensitivity: 'normal',
  entities: { target_user_email: 'a@b.com', target_user_display_name: null, group_name: null, license_sku: null },
  reasoning: 'Clear request.',
  follow_up_question: null,
  escalation_reason: null,
  proposed_psa_note: 'Reset the password.',
};

describe('stripReasoning', () => {
  it('removes a <think> block', () => {
    const input = '<think>Let me consider this carefully.</think>{"a":1}';
    expect(stripReasoning(input)).not.toContain('consider');
  });

  it('removes multi-line and multiple reasoning blocks', () => {
    const input = '<thinking>\nline one\nline two\n</thinking> text <reasoning>more</reasoning>{"a":1}';
    const out = stripReasoning(input);
    expect(out).not.toContain('line one');
    expect(out).not.toContain('more');
  });
});

describe('findJsonObject', () => {
  it('finds an object surrounded by prose', () => {
    expect(findJsonObject('Here you go: {"a":1} — hope that helps!')).toBe('{"a":1}');
  });

  it('does not stop at a brace inside a string value', () => {
    const input = 'x {"note":"use the {placeholder} syntax","b":2} y';
    expect(findJsonObject(input)).toBe('{"note":"use the {placeholder} syntax","b":2}');
  });

  it('handles escaped quotes inside strings', () => {
    const input = '{"note":"they said \\"hello\\" loudly"}';
    expect(findJsonObject(input)).toBe(input);
  });

  it('handles nested objects', () => {
    const input = '{"a":{"b":{"c":1}},"d":2}';
    expect(findJsonObject(input)).toBe(input);
  });

  it('returns null when there is no object at all', () => {
    expect(findJsonObject('no json here')).toBeNull();
  });
});

describe('repairJson', () => {
  it('drops trailing commas', () => {
    expect(JSON.parse(repairJson('{"a":1,"b":2,}'))).toEqual({ a: 1, b: 2 });
  });

  it('converts Python literals', () => {
    expect(JSON.parse(repairJson('{"a": None, "b": True, "c": False}'))).toEqual({ a: null, b: true, c: false });
  });

  it('quotes bare keys', () => {
    expect(JSON.parse(repairJson('{classification: "ESCALATE"}'))).toEqual({ classification: 'ESCALATE' });
  });

  it('closes a truncated object', () => {
    expect(JSON.parse(repairJson('{"a":1,"b":{"c":2'))).toEqual({ a: 1, b: { c: 2 } });
  });
});

describe('extractJsonObject', () => {
  it('parses a clean response', () => {
    expect(extractJsonObject(JSON.stringify(VALID)).value).toEqual(VALID);
  });

  it('parses a fenced response', () => {
    const raw = '```json\n' + JSON.stringify(VALID) + '\n```';
    expect(extractJsonObject(raw).value).toEqual(VALID);
  });

  // The regression that mattered: qwen3 is this project's default recommended
  // model and always emits a reasoning trace, which the old parser could not
  // handle, so every classification fell back to ESCALATE.
  it('parses a response wrapped in a qwen-style <think> block', () => {
    const raw = `<think>\nThe user is asking about a password. That maps to password_reset.\n</think>\n\n${JSON.stringify(VALID)}`;
    expect(extractJsonObject(raw).value).toEqual(VALID);
  });

  it('parses a reasoning block followed by a fenced object', () => {
    const raw = `<think>reasoning {with braces}</think>\nHere is the result:\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``;
    expect(extractJsonObject(raw).value).toEqual(VALID);
  });

  it('parses an object preceded by conversational preamble', () => {
    const raw = `Sure! Based on the ticket, here is the classification:\n\n${JSON.stringify(VALID)}\n\nLet me know if you need anything else.`;
    expect(extractJsonObject(raw).value).toEqual(VALID);
  });

  it('recovers a truncated response by balancing braces', () => {
    const raw = '{"classification":"ESCALATE","confidence":0.4,"reasoning":"cut off here';
    const result = extractJsonObject<Record<string, unknown>>(raw);
    expect(result.value?.classification).toBe('ESCALATE');
    expect(result.value?.confidence).toBe(0.4);
  });

  it('reports an error for an empty response', () => {
    const result = extractJsonObject('');
    expect(result.value).toBeNull();
    expect(result.error).toMatch(/empty/i);
  });

  it('reports an error when the response has no object', () => {
    const result = extractJsonObject('I cannot classify this ticket.');
    expect(result.value).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it('rejects a bare array, which is not a classification object', () => {
    expect(extractJsonObject('[1,2,3]').value).toBeNull();
  });
});
