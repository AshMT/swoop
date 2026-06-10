import type { AiClassification } from '../types';
import { buildSystemPrompt, buildTicketContent } from '../prompts/system';
import type { Tenant } from '../types';
import { decrypt } from './crypto';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';

const FALLBACK_CLASSIFICATION: AiClassification = {
  classification: 'ESCALATE',
  confidence: 0,
  sensitivity: 'normal',
  entities: {
    target_user_email: null,
    target_user_display_name: null,
    group_name: null,
    license_sku: null,
  },
  reasoning: 'AI classification failed — manual review required',
  follow_up_question: null,
  escalation_reason: 'Classification error',
  proposed_psa_note: '🤖 Swoop: Classification failed. Please review this ticket manually.',
};

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

function normaliseBaseUrl(url: string): string {
  // Strip trailing slash and ensure /v1 is present so callers can always append /chat/completions
  const stripped = url.replace(/\/+$/, '');
  return stripped.endsWith('/v1') ? stripped : `${stripped}/v1`;
}

// Pull the JSON object out of a raw model reply. Handles the common ways models
// wrap their answer: reasoning <think>…</think> blocks (qwen3, deepseek-r1, etc.),
// markdown code fences, and leading/trailing prose.
function extractJsonObject(raw: string): string {
  let s = raw;
  // Reasoning models emit their chain-of-thought first; the real answer follows the
  // final </think>. Take everything after it.
  const thinkClose = s.lastIndexOf('</think>');
  if (thinkClose !== -1) s = s.slice(thinkClose + '</think>'.length);
  // Drop any markdown code fences.
  s = s.replace(/```(?:json)?/gi, '');
  // Grab the outermost { … } — ignores any surrounding prose.
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) return s.slice(start, end + 1).trim();
  return s.trim();
}

function getAiConfig(tenant: Tenant): { baseUrl: string; apiKey: string; model: string } {
  const raw = tenant.aiBaseUrl || process.env.AI_BASE_URL || 'http://localhost:11434/v1';
  const baseUrl = normaliseBaseUrl(raw);
  const rawKey = tenant.aiApiKey
    ? (ENCRYPTION_KEY ? decrypt(tenant.aiApiKey, ENCRYPTION_KEY) : tenant.aiApiKey)
    : (process.env.AI_API_KEY || 'ollama');
  const model = tenant.aiModel || process.env.AI_MODEL || 'qwen3:8b';
  return { baseUrl, apiKey: rawKey, model };
}

export async function classifyTicket(
  ticket: { subject: string; description: string; requesterEmail: string },
  context: { mspName: string; clientName: string },
  tenant: Tenant,
): Promise<{ classification: AiClassification; rawResponse: string }> {
  const { baseUrl, apiKey, model } = getAiConfig(tenant);

  const messages: OpenAIMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt(context),
    },
    {
      role: 'user',
      content: buildTicketContent(ticket.subject, ticket.description, ticket.requesterEmail),
    },
  ];

  let rawResponse = '';

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(600_000), // 10 min — local models load from disk on cold start
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.1,
        // Generous budget: reasoning models (qwen3, deepseek-r1) spend tokens on a
        // <think> block before the JSON; too low a cap truncates the answer.
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`AI API error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as OpenAIResponse;
    rawResponse = data.choices?.[0]?.message?.content || '';

    const cleaned = extractJsonObject(rawResponse);
    if (!cleaned) throw new Error('AI returned an empty response');

    let parsed: AiClassification;
    try {
      parsed = JSON.parse(cleaned) as AiClassification;
    } catch {
      throw new Error(`AI response was not valid JSON (got: "${rawResponse.slice(0, 120).replace(/\s+/g, ' ')}…")`);
    }

    // Validate required fields
    if (!parsed.classification || typeof parsed.confidence !== 'number') {
      throw new Error('Invalid AI response structure');
    }

    // Enforce confidence threshold
    if (parsed.confidence < 0.75 && parsed.classification !== 'ESCALATE' && parsed.classification !== 'FOLLOW_UP') {
      parsed.classification = 'ESCALATE';
      parsed.escalation_reason = parsed.escalation_reason || `Low confidence: ${parsed.confidence}`;
    }

    return { classification: parsed, rawResponse };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[AI] Classification error:', msg);
    if (rawResponse) console.error('[AI] Raw response (first 500 chars):', rawResponse.slice(0, 500));
    return {
      classification: {
        ...FALLBACK_CLASSIFICATION,
        reasoning: `AI classification failed: ${msg} — manual review required`,
        escalation_reason: `Classification error: ${msg}`,
      },
      rawResponse,
    };
  }
}

// Sends a minimal prompt to force the model to load into GPU/CPU memory before
// a real ticket arrives. Called once at poller startup. Fire-and-forget.
export async function warmupAi(tenant: Tenant): Promise<void> {
  const { baseUrl, apiKey, model } = getAiConfig(tenant);
  try {
    console.log(`[AI] Warming up model "${model}" at ${baseUrl}…`);
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(600_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
        max_tokens: 10,
        temperature: 0,
      }),
    });
    if (res.ok) {
      console.log(`[AI] Model "${model}" is warm and ready`);
    } else {
      console.warn(`[AI] Warmup responded with HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn('[AI] Warmup failed (model will cold-start on first ticket):', err instanceof Error ? err.message : err);
  }
}

export async function testAiConnection(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${normaliseBaseUrl(baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with just the word: OK' }],
        max_tokens: 10,
        temperature: 0,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
