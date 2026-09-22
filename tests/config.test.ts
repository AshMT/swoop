import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

const STRONG_JWT = 'f'.repeat(64);
const STRONG_KEY = 'e'.repeat(32);

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'production', JWT_SECRET: STRONG_JWT, ENCRYPTION_KEY: STRONG_KEY, ...overrides };
}

describe('loadConfig in production', () => {
  it('accepts a well-configured environment', () => {
    const cfg = loadConfig(env());
    expect(cfg.isProduction).toBe(true);
    expect(cfg.encryptionEnabled).toBe(true);
    expect(cfg.port).toBe(3000);
  });

  // Silently defaulting to 'change-me-in-production' meant anyone could mint a
  // valid session token for any Swoop install running with the default.
  it('refuses to boot without a JWT secret', () => {
    expect(() => loadConfig(env({ JWT_SECRET: undefined }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ JWT_SECRET: undefined }))).toThrow(/JWT_SECRET is required/);
  });

  it('refuses the placeholder secret shipped in .env.example', () => {
    expect(() => loadConfig(env({ JWT_SECRET: 'change_me_to_a_long_random_string_here' }))).toThrow(
      /placeholder/,
    );
    expect(() => loadConfig(env({ ENCRYPTION_KEY: 'change_me_32_chars_random_string_' }))).toThrow(
      /placeholder/,
    );
  });

  it('refuses a short JWT secret', () => {
    expect(() => loadConfig(env({ JWT_SECRET: 'tooshort' }))).toThrow(/at least 32 characters/);
  });

  it('refuses to store credentials in plaintext in production', () => {
    expect(() => loadConfig(env({ ENCRYPTION_KEY: undefined }))).toThrow(/ENCRYPTION_KEY is required/);
  });

  it('refuses a short encryption key', () => {
    expect(() => loadConfig(env({ ENCRYPTION_KEY: 'abc' }))).toThrow(/at least 16 characters/);
  });

  it('reports every problem at once rather than one per restart', () => {
    try {
      loadConfig({ NODE_ENV: 'production' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).problems).toHaveLength(2);
    }
  });
});

describe('loadConfig in development', () => {
  it('runs without secrets, but marks encryption as off', () => {
    const cfg = loadConfig({ NODE_ENV: 'development' });
    expect(cfg.jwtSecret).toBeTruthy();
    expect(cfg.encryptionEnabled).toBe(false);
  });

  it('still rejects a placeholder secret', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', JWT_SECRET: 'changeme' })).toThrow(ConfigError);
  });
});

describe('numeric and boolean settings', () => {
  it('clamps the poll interval into a sane range', () => {
    expect(loadConfig(env({ POLL_INTERVAL_SECONDS: '5' })).defaultPollIntervalSeconds).toBe(15);
    expect(loadConfig(env({ POLL_INTERVAL_SECONDS: '99999' })).defaultPollIntervalSeconds).toBe(3600);
    expect(loadConfig(env({ POLL_INTERVAL_SECONDS: '120' })).defaultPollIntervalSeconds).toBe(120);
  });

  it('falls back when a numeric setting is not a number', () => {
    expect(loadConfig(env({ PORT: 'not-a-port' })).port).toBe(3000);
  });

  it('parses the usual truthy spellings for TRUST_PROXY', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(loadConfig(env({ TRUST_PROXY: value })).trustProxy, value).toBe(true);
    }
    for (const value of ['0', 'false', 'no', '']) {
      expect(loadConfig(env({ TRUST_PROXY: value })).trustProxy, value).toBe(false);
    }
  });

  it('defaults TRUST_PROXY to off, so X-Forwarded-For cannot defeat rate limiting', () => {
    expect(loadConfig(env()).trustProxy).toBe(false);
  });

  it('leaves the SuperOps endpoint unset unless overridden', () => {
    expect(loadConfig(env()).superopsApiUrl).toBeNull();
    expect(loadConfig(env({ SUPEROPS_API_URL: 'http://localhost:4455/msp/' })).superopsApiUrl).toBe(
      'http://localhost:4455/msp',
    );
  });
});
