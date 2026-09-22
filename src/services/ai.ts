import { z } from 'zod';
import { config } from '../config';
import { decrypt } from './crypto';
import { extractJsonObject } from '../lib/json-extract';
import { canonicaliseAction } from '../domain/classifications';
import { resolveSystemPrompt, buildTicketContent, type PromptContext, type TicketPromptInput } from '../prompts/system';
import { createLogger, describeError } from '../lib/logger';
import type { AiClassification, Tenant } from '../types';

const log = createLogger('AI');

/** Schema of the model's raw response, before normalisation. */
const rawClassificationSchema = z.object({
  classification: z.string().min(1),
  confidence: z.coerce.number(),
  sensitivity: z.string().optional().nullable(),
  entities: z
    .object({
      target_user_email: z.string().nullish(),
      target_user_display_name: z.string().nullish(),
      group_name: z.string().nullish(),
      license_sku: z.string().nullish(),
    })
    .partial()
    .optional()
    .nullable(),
  reasoning: z.string().nullish(),
  follow_up_question: z.string().nullish(),
  escalation_reason: z.string().nullish(),
  proposed_psa_note: z.string().nullish(),
});

export class AiError extends Error {
  readonly retryable: boolean;
  readonly rawResponse: string;
  constructor(message: string, options: { retryable?: boolean; rawResponse?: string } = {}) {
    super(message);
    this.name = 'AiError';
    this.retryable = options.retryable ?? true;
    this.rawResponse = options.rawResponse ?? '';
  }
}

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ClassificationResult {
  classification: AiClassification;
  rawResponse: string;
  model: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Set when the model's answer had to be corrected, for the audit trail. */
  adjustments: string[];
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
}

/** Appends /v1 so operators can paste a bare Ollama host and have it work. */
export function normaliseBaseUrl(url: string): string {
  const stripped = url.trim().replace(/\/+$/, '');
  if (!stripped) return 'http://localhost:11434/v1';
  // Leave an explicit non-OpenAI path alone (e.g. an Azure deployment route).
  if (/\/v\d+(?:$|\/)/.test(stripped) || /\/openai(?:$|\/)/.test(stripped)) return stripped;
  return `${stripped}/v1`;
}

export function resolveAiConfig(tenant: Pick<Tenant, 'aiBaseUrl' | 'aiApiKey' | 'aiModel'>): AiConfig {
  const cfg = config();
  const baseUrl = normaliseBaseUrl(tenant.aiBaseUrl || cfg.ai.baseUrl);
  const apiKey = tenant.aiApiKey
    ? cfg.encryptionEnabled
      ? decrypt(tenant.aiApiKey, cfg.encryptionKey)
      : tenant.aiApiKey
    : cfg.ai.apiKey;
  const model = tenant.aiModel || cfg.ai.model;
  return { baseUrl, apiKey, model };
}

/**
 * Classifies one ticket.
 *
 * Throws AiError on failure rather than returning a synthetic ESCALATE. The
 * caller needs to tell "the model says escalate this" apart from "the model is
 * down" — conflating the two made every outage look like a wave of tickets the
 * AI had correctly declined, which is exactly the signal Phase 1 exists to
 * measure.
 */
export async function classifyTicket(
  ticket: TicketPromptInput,
  context: PromptContext,
  tenant: Pick<Tenant, 'aiBaseUrl' | 'aiApiKey' | 'aiModel' | 'systemPromptOverride'>,
): Promise<ClassificationResult> {
  const aiConfig = resolveAiConfig(tenant);
  const systemPrompt = resolveSystemPrompt(context, tenant.systemPromptOverride);
  const userPrompt = buildTicketContent(ticket);

  const started = Date.now();
  let lastError: AiError | null = null;

  // Two attempts: the first asks for JSON mode, and if the provider rejects it
  // or the model returns unparseable text, the retry drops JSON mode and adds
  // an explicit correction. One retry is the right budget — a third attempt on
  // a model that cannot produce JSON just delays the escalation.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const useJsonMode = attempt === 1;
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userPrompt },
    ];
    if (attempt === 2 && lastError) {
      messages.push({
        role: 'user' as const,
        content:
          'Your previous response could not be parsed as JSON. Respond again with only the JSON object described above — no reasoning, no code fence, no explanation.',
      });
    }

    let raw: string;
    let usage: ChatCompletionResponse['usage'];
    try {
      const response = await callChatCompletions(aiConfig, messages, useJsonMode);
      raw = response.content;
      usage = response.usage;
    } catch (err) {
      lastError = err instanceof AiError ? err : new AiError(describeError(err));
      if (!lastError.retryable || attempt === 2) throw lastError;
      log.warn(`AI request failed (attempt ${attempt}), retrying: ${lastError.message}`);
      continue;
    }

    const parsed = parseClassification(raw);
    if (parsed.ok) {
      return {
        classification: parsed.value,
        rawResponse: raw,
        model: aiConfig.model,
        latencyMs: Date.now() - started,
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
        adjustments: parsed.adjustments,
      };
    }

    lastError = new AiError(parsed.error, { rawResponse: raw });
    if (attempt === 2) throw lastError;
    log.warn(`Could not parse the model response (attempt ${attempt}): ${parsed.error}`);
  }

  throw lastError ?? new AiError('Classification failed for an unknown reason');
}

async function callChatCompletions(
  aiConfig: AiConfig,
  messages: Array<{ role: string; content: string }>,
  useJsonMode: boolean,
): Promise<{ content: string; usage: ChatCompletionResponse['usage'] }> {
  const cfg = config();
  const body: Record<string, unknown> = {
    model: aiConfig.model,
    messages,
    temperature: 0.1,
    max_tokens: 1200,
  };
  // Supported by OpenAI, Groq and recent Ollama. Providers that do not support
  // it generally 400, which the retry handles by dropping the field.
  if (useJsonMode) body.response_format = { type: 'json_object' };

  let response: Response;
  try {
    response = await fetch(`${aiConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(cfg.ai.timeoutMs),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aiConfig.apiKey || 'none'}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = describeError(err);
    if (/abort|timeout/i.test(message)) {
      throw new AiError(
        `The AI provider did not respond within ${Math.round(cfg.ai.timeoutMs / 1000)}s. Raise AI_TIMEOUT_MS, or use a smaller model.`,
      );
    }
    throw new AiError(`Cannot reach the AI provider at ${aiConfig.baseUrl}: ${message}`);
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    if (response.status === 400 && useJsonMode && /response_format|json_object/i.test(detail)) {
      throw new AiError('The provider rejected JSON mode', { retryable: true });
    }
    if (response.status === 401 || response.status === 403) {
      throw new AiError(`The AI provider rejected the API key (HTTP ${response.status}).`, { retryable: false });
    }
    if (response.status === 404) {
      throw new AiError(
        `The AI provider returned HTTP 404 for ${aiConfig.baseUrl}/chat/completions. Check the base URL, and that the model "${aiConfig.model}" is pulled.`,
        { retryable: false },
      );
    }
    if (response.status === 429) {
      throw new AiError('The AI provider rate limit was reached (HTTP 429).', { retryable: true });
    }
    throw new AiError(`AI provider error HTTP ${response.status}${detail ? ` — ${detail}` : ''}.`);
  }

  const data = (await response.json().catch(() => null)) as ChatCompletionResponse | null;
  if (!data) throw new AiError('The AI provider returned a response that was not JSON.');
  if (data.error?.message) throw new AiError(`AI provider error: ${data.error.message}`);

  const content = data.choices?.[0]?.message?.content ?? '';
  if (!content.trim()) {
    const reason = data.choices?.[0]?.finish_reason;
    throw new AiError(
      `The model returned an empty response${reason ? ` (finish_reason: ${reason})` : ''}.` +
        (reason === 'length' ? ' The response was cut off — the reply exceeded max_tokens.' : ''),
    );
  }

  return { content, usage: data.usage };
}

type ParseOutcome =
  | { ok: true; value: AiClassification; adjustments: string[] }
  | { ok: false; error: string };

/**
 * Parses, validates and normalises a model response into an AiClassification.
 * Exported so the test suite can exercise it against real messy model output.
 */
export function parseClassification(raw: string): ParseOutcome {
  const extracted = extractJsonObject(raw);
  if (!extracted.value) {
    return { ok: false, error: extracted.error ?? 'Could not find a JSON object in the response' };
  }

  const validated = rawClassificationSchema.safeParse(extracted.value);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    return {
      ok: false,
      error: `The model response is missing or malformed at "${issue?.path.join('.') || 'root'}": ${issue?.message ?? 'invalid'}`,
    };
  }

  const data = validated.data;
  const adjustments: string[] = [];

  // Label: accept case and separator drift, escalate anything genuinely unknown.
  let classification = canonicaliseAction(data.classification);
  if (!classification) {
    adjustments.push(`Unknown classification "${data.classification}" — escalated instead`);
    classification = 'ESCALATE';
  } else if (classification !== data.classification) {
    adjustments.push(`Normalised classification "${data.classification}" to "${classification}"`);
  }

  // Confidence: some models emit 0-100 rather than 0-1.
  let confidence = Number.isFinite(data.confidence) ? data.confidence : 0;
  if (confidence > 1 && confidence <= 100) {
    confidence = confidence / 100;
    adjustments.push('Rescaled a percentage confidence to 0-1');
  }
  confidence = Math.min(Math.max(confidence, 0), 1);

  const sensitivity = data.sensitivity?.toLowerCase() === 'high' ? 'high' : 'normal';

  const entities = {
    target_user_email: cleanEmail(data.entities?.target_user_email),
    target_user_display_name: cleanString(data.entities?.target_user_display_name),
    group_name: cleanString(data.entities?.group_name),
    license_sku: cleanString(data.entities?.license_sku),
  };

  if (data.entities?.target_user_email && !entities.target_user_email) {
    adjustments.push(`Discarded an invalid target_user_email "${data.entities.target_user_email}"`);
  }

  const classificationIsTerminal = classification === 'ESCALATE' || classification === 'FOLLOW_UP';

  // A FOLLOW_UP with no question is useless — it would post a note asking
  // nothing. Downgrade to ESCALATE so a human picks it up.
  let followUpQuestion = cleanString(data.follow_up_question);
  if (classification === 'FOLLOW_UP' && !followUpQuestion) {
    adjustments.push('FOLLOW_UP had no question — escalated instead');
    classification = 'ESCALATE';
    followUpQuestion = null;
  }
  if (classification !== 'FOLLOW_UP') followUpQuestion = null;

  const reasoning = cleanString(data.reasoning) ?? 'The model gave no reasoning.';
  const proposedNote = cleanString(data.proposed_psa_note) ?? fallbackNote(classification, reasoning);
  if (!cleanString(data.proposed_psa_note)) {
    adjustments.push('The model omitted proposed_psa_note — generated one from the reasoning');
  }

  return {
    ok: true,
    adjustments,
    value: {
      classification,
      confidence,
      sensitivity,
      entities,
      reasoning,
      follow_up_question: followUpQuestion,
      escalation_reason: classificationIsTerminal ? cleanString(data.escalation_reason) : null,
      proposed_psa_note: proposedNote,
    },
  };
}

/**
 * Applies the tenant's policy to a parsed classification.
 *
 * Kept separate from parsing so the stored log holds what the model actually
 * said, and the policy applied to it is explicit and testable.
 */
export function applyPolicy(
  classification: AiClassification,
  options: {
    confidenceThreshold: number;
    /**
     * The ticket text the classification came from. When supplied, an extracted
     * email that does not appear in it is discarded — see groundEntities below.
     */
    sourceText?: string;
  },
): { classification: AiClassification; adjustments: string[] } {
  const adjustments: string[] = [];
  const next = { ...classification, entities: { ...classification.entities } };

  // ─── Grounding ──────────────────────────────────────────────────────────────
  if (options.sourceText !== undefined) {
    const grounded = groundEntities(next, options.sourceText);
    adjustments.push(...grounded.adjustments);
  }

  // ─── Confidence floor ───────────────────────────────────────────────────────
  const isTerminal = next.classification === 'ESCALATE' || next.classification === 'FOLLOW_UP';
  if (!isTerminal && next.confidence < options.confidenceThreshold) {
    adjustments.push(
      `Confidence ${next.confidence.toFixed(2)} is below the ${options.confidenceThreshold.toFixed(2)} threshold`,
    );
    next.escalation_reason =
      next.escalation_reason ||
      `Confidence ${next.confidence.toFixed(2)} below the configured threshold of ${options.confidenceThreshold.toFixed(2)}`;
    next.classification = 'ESCALATE';
  }

  return { classification: next, adjustments };
}

/**
 * Discards an extracted email address that does not appear in the ticket.
 *
 * The prompt tells the model never to invent an address, and a capable model
 * obeys — but the prompt also carries worked examples, and a small model can
 * copy an address out of one of them. Since the whole value of the entity is
 * that a technician can act on it, an address that was never in the ticket is
 * worse than none at all: it names a real user who did not ask for anything.
 *
 * Mutates `classification` in place and returns what it changed.
 */
export function groundEntities(
  classification: AiClassification,
  sourceText: string,
): { adjustments: string[] } {
  const adjustments: string[] = [];
  const haystack = sourceText.toLowerCase();
  const email = classification.entities.target_user_email;

  if (email && !haystack.includes(email.toLowerCase())) {
    adjustments.push(
      `Discarded target_user_email "${email}" — it does not appear anywhere in the ticket, so the model did not read it from the request`,
    );
    classification.entities.target_user_email = null;

    // Without a target, an action classification cannot be carried out as
    // written. Asking the requester is the honest next step.
    const isTerminal =
      classification.classification === 'ESCALATE' || classification.classification === 'FOLLOW_UP';
    if (!isTerminal) {
      classification.classification = 'FOLLOW_UP';
      classification.follow_up_question =
        classification.follow_up_question ||
        'Could you confirm the full name and email address of the user this request is for?';
      adjustments.push('Changed to FOLLOW_UP because the target user could not be confirmed from the ticket');
    }
  }

  return { adjustments };
}

function cleanString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Models emit these as stand-ins for a real null.
  if (/^(null|none|n\/a|na|unknown|undefined|not specified|not provided|-)$/i.test(trimmed)) return null;
  return trimmed;
}

/** Rejects the placeholder addresses models invent when told not to guess. */
function cleanEmail(value: string | null | undefined): string | null {
  const cleaned = cleanString(value);
  if (!cleaned) return null;
  const match = /[^\s<>()[\],;:]+@[^\s<>()[\],;:]+\.[a-z]{2,}/i.exec(cleaned);
  if (!match) return null;
  const email = match[0].toLowerCase();
  if (/@(example|test|domain|company|yourcompany|email)\.(com|org|net|local)$/i.test(email)) return null;
  if (/^(user|username|email|name|someone|firstname\.lastname)@/i.test(email)) return null;
  return email;
}

function fallbackNote(classification: string, reasoning: string): string {
  if (classification === 'ESCALATE') {
    return `Escalating for human review. ${reasoning}`;
  }
  return `Proposed action: ${classification}. ${reasoning}`;
}

/** Connection test used by the setup wizard and Settings page. */
export async function testAiConnection(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<{ ok: boolean; error?: string; reply?: string; latencyMs?: number }> {
  const started = Date.now();
  try {
    const { content } = await callChatCompletions(
      { baseUrl: normaliseBaseUrl(baseUrl), apiKey, model },
      [
        {
          role: 'user',
          content: 'Reply with this exact JSON and nothing else: {"ok":true}',
        },
      ],
      false,
    );
    return { ok: true, reply: content.slice(0, 200).trim(), latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, error: describeError(err), latencyMs: Date.now() - started };
  }
}
