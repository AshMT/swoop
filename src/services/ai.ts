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

function getAiConfig(tenant: Tenant): { baseUrl: string; apiKey: string; model: string } {
  const baseUrl = tenant.aiBaseUrl || process.env.AI_BASE_URL || 'http://localhost:11434/v1';
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
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.1,
        max_tokens: 1024,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`AI API error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as OpenAIResponse;
    rawResponse = data.choices?.[0]?.message?.content || '';

    // Strip markdown code fences if present
    const cleaned = rawResponse
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    const parsed = JSON.parse(cleaned) as AiClassification;

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
    console.error('[AI] Classification error:', err);
    return { classification: { ...FALLBACK_CLASSIFICATION }, rawResponse };
  }
}

export async function testAiConnection(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
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
