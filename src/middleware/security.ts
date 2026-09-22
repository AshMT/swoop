import type { NextFunction, Request, Response } from 'express';
import { createLogger } from '../lib/logger';

const log = createLogger('HTTP');

/**
 * Security response headers.
 *
 * Hand-rolled rather than pulling in helmet: Swoop serves one self-hosted SPA
 * from one origin, so the useful subset is short and an explicit list is easier
 * to reason about than a dependency's defaults.
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.removeHeader('X-Powered-By');

  // The SPA is built by Vite with hashed asset names and no inline scripts, so
  // a script-src of 'self' holds. 'unsafe-inline' remains for styles only,
  // which Tailwind's runtime-injected styles and React's style prop need.
  if (!req.path.startsWith('/api/')) {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        // The browser only ever talks to Swoop's own origin; the SuperOps and
        // AI calls are made server-side.
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ].join('; '),
    );
  }
  next();
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window rate limiter, in memory.
 *
 * Swoop is a single process with a single SQLite file, so a shared store would
 * be extra infrastructure for no benefit. This exists to stop password
 * guessing and to keep the AI/PSA connection-test endpoints from being used as
 * a scanning tool, not to shape production traffic.
 */
export function rateLimit(options: {
  windowMs: number;
  max: number;
  keyPrefix: string;
  message?: string;
}) {
  const buckets = new Map<string, Bucket>();
  let lastSweep = Date.now();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();

    // Opportunistic sweep so the map cannot grow without bound.
    if (now - lastSweep > options.windowMs) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
      lastSweep = now;
    }

    const key = `${options.keyPrefix}:${clientIp(req)}`;
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    bucket.count++;
    if (bucket.count > options.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      log.warn(`Rate limit hit on ${options.keyPrefix} from ${clientIp(req)}`);
      res.status(429).json({
        error: options.message ?? `Too many requests. Try again in ${retryAfter} seconds.`,
      });
      return;
    }
    next();
  };
}

function clientIp(req: Request): string {
  // req.ip already honours the app's trust-proxy setting.
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/** Concise access log; skips static assets to keep the output readable. */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith('/api/') && req.path !== '/health') {
    next();
    return;
  }
  const started = Date.now();
  // Capture the path now: Express rewrites req.url when it enters a mounted
  // router, so reading it from the 'finish' handler logs only the tail of the
  // path and loses which endpoint was actually called.
  const path = req.path;
  const method = req.method;

  res.on('finish', () => {
    const duration = Date.now() - started;
    const line = `${method} ${path} ${res.statusCode} ${duration}ms`;
    if (res.statusCode >= 500) log.error(line);
    else if (res.statusCode >= 400) log.warn(line);
    else log.debug(line);
  });
  next();
}

/** Terminal error handler — never leaks a stack trace to the client. */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // A malformed JSON body surfaces here as a SyntaxError from body-parser.
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'Request body is not valid JSON' });
    return;
  }
  if (typeof err === 'object' && err && (err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large' });
    return;
  }

  log.error(`Unhandled error on ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
}
