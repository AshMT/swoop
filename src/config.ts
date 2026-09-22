import 'dotenv/config';

/**
 * Centralised, validated configuration.
 *
 * Swoop holds MSP-wide SuperOps credentials and AI provider keys, so a weak
 * secret is not a cosmetic problem. In production we refuse to boot rather
 * than silently fall back to a default — a container that exits loudly is far
 * safer than one that runs with `change-me-in-production` as its JWT secret.
 */

export type NodeEnv = 'development' | 'production' | 'test';

export interface Config {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  port: number;
  sqlitePath: string;
  jwtSecret: string;
  encryptionKey: string;
  /** Secrets are encrypted at rest only when a usable key was supplied. */
  encryptionEnabled: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Default poll interval for tenants that have not overridden it. */
  defaultPollIntervalSeconds: number;
  ai: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
  };
  /** Trust X-Forwarded-For — enable only when actually behind a reverse proxy. */
  trustProxy: boolean;
  /**
   * Overrides the SuperOps API endpoint. Set it to develop against a mock, or
   * to route through an egress proxy that fronts the real API. Leave unset to
   * pick the endpoint from the tenant's configured data centre.
   */
  superopsApiUrl: string | null;
}

const INSECURE_SECRETS = new Set([
  'change-me-in-production',
  'change_me_to_a_long_random_string_here',
  'change_me_32_chars_random_string_',
  'changeme',
  'secret',
  'password',
]);

const MIN_JWT_SECRET_LENGTH = 32;
const MIN_ENCRYPTION_KEY_LENGTH = 16;

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function parseIntEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function parseBoolEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function normaliseNodeEnv(raw: string | undefined): NodeEnv {
  if (raw === 'production' || raw === 'test') return raw;
  return 'development';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = normaliseNodeEnv(env.NODE_ENV);
  const isProduction = nodeEnv === 'production';
  const problems: string[] = [];

  const jwtSecretRaw = (env.JWT_SECRET ?? '').trim();
  const encryptionKeyRaw = (env.ENCRYPTION_KEY ?? '').trim();

  // ─── JWT secret ─────────────────────────────────────────────────────────────
  let jwtSecret = jwtSecretRaw;
  if (!jwtSecret) {
    if (isProduction) {
      problems.push('JWT_SECRET is required in production. Generate one with: openssl rand -hex 32');
    } else {
      jwtSecret = 'swoop-development-only-secret-do-not-use-in-production';
    }
  } else if (INSECURE_SECRETS.has(jwtSecret.toLowerCase())) {
    problems.push('JWT_SECRET is still set to a placeholder value. Generate one with: openssl rand -hex 32');
  } else if (jwtSecret.length < MIN_JWT_SECRET_LENGTH && isProduction) {
    problems.push(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters (got ${jwtSecret.length}). Generate one with: openssl rand -hex 32`,
    );
  }

  // ─── Encryption key ─────────────────────────────────────────────────────────
  const encryptionKey = encryptionKeyRaw;
  let encryptionEnabled = true;
  if (!encryptionKey) {
    if (isProduction) {
      problems.push(
        'ENCRYPTION_KEY is required in production — without it, SuperOps and AI API keys are written to SQLite in plaintext. Generate one with: openssl rand -hex 32',
      );
    } else {
      encryptionEnabled = false;
    }
  } else if (INSECURE_SECRETS.has(encryptionKey.toLowerCase())) {
    problems.push('ENCRYPTION_KEY is still set to a placeholder value. Generate one with: openssl rand -hex 32');
  } else if (encryptionKey.length < MIN_ENCRYPTION_KEY_LENGTH) {
    problems.push(
      `ENCRYPTION_KEY must be at least ${MIN_ENCRYPTION_KEY_LENGTH} characters (got ${encryptionKey.length}). Generate one with: openssl rand -hex 32`,
    );
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const logLevel = (['debug', 'info', 'warn', 'error'] as const).includes(
    (env.LOG_LEVEL ?? '') as 'debug',
  )
    ? (env.LOG_LEVEL as Config['logLevel'])
    : isProduction
      ? 'info'
      : 'debug';

  return {
    nodeEnv,
    isProduction,
    port: parseIntEnv(env.PORT, 3000, 1, 65535),
    sqlitePath: env.SQLITE_PATH?.trim() || './data/swoop.db',
    jwtSecret,
    encryptionKey,
    encryptionEnabled,
    logLevel,
    defaultPollIntervalSeconds: parseIntEnv(env.POLL_INTERVAL_SECONDS, 60, 15, 3600),
    ai: {
      baseUrl: env.AI_BASE_URL?.trim() || 'http://localhost:11434/v1',
      apiKey: env.AI_API_KEY?.trim() || 'ollama',
      model: env.AI_MODEL?.trim() || 'qwen3:8b',
      timeoutMs: parseIntEnv(env.AI_TIMEOUT_MS, 300_000, 5_000, 1_800_000),
    },
    trustProxy: parseBoolEnv(env.TRUST_PROXY, false),
    superopsApiUrl: env.SUPEROPS_API_URL?.trim().replace(/\/+$/, '') || null,
  };
}

let cached: Config | null = null;

/** Lazily loaded singleton so importing a module never throws at import time. */
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test seam — lets suites install a config without touching process.env. */
export function setConfigForTesting(next: Config | null): void {
  cached = next;
}
