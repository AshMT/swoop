/**
 * Minimal levelled logger with a stable prefix format.
 *
 * Deliberately dependency-free: Swoop is a single-container self-hosted app and
 * `docker logs` is the primary observability surface, so readable lines matter
 * more than structured sinks. Set LOG_FORMAT=json for shipping to a collector.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const jsonOutput = /^(1|true|json)$/i.test(process.env.LOG_FORMAT ?? '');

function activeLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? '').toLowerCase();
  if (raw in LEVELS) return raw as LogLevel;
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

/** Keys whose values are redacted before a log line is emitted. */
const SENSITIVE_KEY = /(api[-_]?key|token|secret|password|authorization|passwordhash)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(val, depth + 1);
  }
  return out;
}

function formatMeta(meta: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) return ` ${meta.stack || meta.message}`;
  if (typeof meta === 'string') return ` ${meta}`;
  try {
    return ` ${JSON.stringify(redact(meta))}`;
  } catch {
    return ' [unserialisable meta]';
  }
}

function emit(level: LogLevel, scope: string, message: string, meta?: unknown): void {
  if (LEVELS[level] < LEVELS[activeLevel()]) return;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

  if (jsonOutput) {
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      scope,
      message,
    };
    if (meta !== undefined) {
      record.meta = meta instanceof Error ? { message: meta.message, stack: meta.stack } : redact(meta);
    }
    sink(JSON.stringify(record));
    return;
  }

  sink(`[${scope}] ${message}${formatMeta(meta)}`);
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child(childScope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, meta) => emit('debug', scope, message, meta),
    info: (message, meta) => emit('info', scope, message, meta),
    warn: (message, meta) => emit('warn', scope, message, meta),
    error: (message, meta) => emit('error', scope, message, meta),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}

/**
 * Turns an unknown thrown value into a single readable line, unwrapping the
 * shapes `graphql-request` and `fetch` throw so the cause is not buried.
 */
export function describeError(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeText = cause && cause !== err ? ` (cause: ${describeError(cause)})` : '';
    return `${err.message}${causeText}`;
  }
  if (typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.message === 'string') return e.message;
    try {
      return JSON.stringify(redact(e));
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}
