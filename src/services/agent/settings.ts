import { z } from 'zod';

/**
 * The investigation agent: when it runs and with which model.
 *
 * Off by default. Investigating means several model calls and several CIPP
 * reads per ticket, and small local models are unreliable at choosing tools,
 * so it is something to turn on deliberately — usually with a stronger model
 * than triage uses.
 */
export const agentSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** 'actions' — only tickets proposing a change. 'all' — every ticket. 'manual' — only from the ticket page. */
  autoRun: z.enum(['actions', 'all', 'manual']).default('actions'),
  /** Model for investigations; empty uses the triage model. */
  model: z.string().max(200).nullable().default(null),
  /** Tool calls allowed before it must answer. */
  maxSteps: z.number().int().min(2).max(15).default(8),
});

export type AgentSettings = z.infer<typeof agentSettingsSchema>;
export const DEFAULT_AGENT_SETTINGS: AgentSettings = agentSettingsSchema.parse({});

export function readAgentSettings(raw: string | null | undefined): AgentSettings {
  if (!raw) return DEFAULT_AGENT_SETTINGS;
  try {
    const parsed = agentSettingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_AGENT_SETTINGS;
  } catch {
    return DEFAULT_AGENT_SETTINGS;
  }
}
