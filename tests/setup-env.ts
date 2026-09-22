/**
 * Shared test environment.
 *
 * Imported for its side effects before anything that reads config, so every
 * suite gets a throwaway in-memory database and deterministic secrets.
 */
process.env.NODE_ENV = 'test';
process.env.SQLITE_PATH = ':memory:';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-to-pass-validation';
process.env.ENCRYPTION_KEY = 'test-encryption-key-0123456789abcdef';
process.env.LOG_LEVEL = 'error';
