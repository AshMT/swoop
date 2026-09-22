import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

/**
 * Envelope encryption for secrets at rest (SuperOps tokens, AI provider keys).
 *
 * Format v2:  v2:<nonce-hex>:<tag-hex>:<ciphertext-hex>
 *   - AES-256-GCM with a 96-bit nonce (the size the GCM spec is optimised for).
 *   - The 256-bit key is derived from ENCRYPTION_KEY with scrypt, so a short or
 *     low-entropy passphrase still yields a full-width key. The previous
 *     implementation zero-padded the passphrase to 32 bytes, which meant a
 *     16-character key left half the key space as literal '0' bytes.
 *
 * Legacy format (no version prefix): <iv-hex>:<tag-hex>:<ciphertext-hex> with a
 * 128-bit IV and the zero-padded key. Still decryptable so existing databases
 * keep working; anything re-saved is written back as v2.
 */

const ALGORITHM = 'aes-256-gcm';
const V2_PREFIX = 'v2';
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Fixed salt. A random per-secret salt would be stronger, but the key is a
 * long-lived operator-supplied passphrase rather than a user password, and a
 * stored salt would have to travel with every ciphertext. scrypt's cost
 * parameters do the heavy lifting here.
 */
const SCRYPT_SALT = Buffer.from('swoop.secret.envelope.v2');
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const derivedKeyCache = new Map<string, Buffer>();

function deriveKey(passphrase: string): Buffer {
  // scrypt is intentionally slow, so cache per passphrase. Keyed by a hash so
  // the raw passphrase is not retained as a map key.
  const cacheKey = createHash('sha256').update(passphrase).digest('hex');
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) return cached;
  const key = scryptSync(passphrase, SCRYPT_SALT, KEY_BYTES, SCRYPT_OPTIONS);
  derivedKeyCache.set(cacheKey, key);
  return key;
}

/** The pre-v2 derivation: pad or truncate the passphrase to 32 bytes. */
function legacyKey(passphrase: string): Buffer {
  return Buffer.from(passphrase.padEnd(KEY_BYTES, '0').slice(0, KEY_BYTES));
}

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

export function encrypt(plaintext: string, passphrase: string): string {
  if (!passphrase) throw new Error('encrypt() requires a passphrase');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveKey(passphrase), nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [V2_PREFIX, nonce.toString('hex'), tag.toString('hex'), ciphertext.toString('hex')].join(':');
}

/** True when `value` looks like something this module produced. */
export function isEncrypted(value: string): boolean {
  if (!value) return false;
  const parts = value.split(':');
  if (parts.length === 4) return parts[0] === V2_PREFIX;
  if (parts.length === 3) return /^[0-9a-f]{32}$/i.test(parts[0]) && /^[0-9a-f]{32}$/i.test(parts[1]);
  return false;
}

/**
 * Decrypts a v2 or legacy envelope.
 *
 * A value that is not in either envelope format is returned unchanged: secrets
 * written while ENCRYPTION_KEY was unset are stored as plaintext, and silently
 * passing them through is what lets an operator add a key to an existing
 * install without hand-editing the database.
 */
export function decrypt(value: string, passphrase: string): string {
  if (!value) return value;
  const parts = value.split(':');

  if (parts.length === 4 && parts[0] === V2_PREFIX) {
    const [, nonceHex, tagHex, ciphertextHex] = parts;
    return openEnvelope(nonceHex, tagHex, ciphertextHex, deriveKey(passphrase), 'v2');
  }

  if (parts.length === 3 && isEncrypted(value)) {
    const [ivHex, tagHex, ciphertextHex] = parts;
    return openEnvelope(ivHex, tagHex, ciphertextHex, legacyKey(passphrase), 'legacy');
  }

  return value;
}

function openEnvelope(
  nonceHex: string,
  tagHex: string,
  ciphertextHex: string,
  key: Buffer,
  label: string,
): string {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(nonceHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(ciphertextHex, 'hex', 'utf8') + decipher.final('utf8');
  } catch {
    // The GCM tag check failed. Overwhelmingly this means ENCRYPTION_KEY
    // changed, so say that rather than leaking the raw OpenSSL error.
    throw new DecryptionError(
      `Could not decrypt a stored secret (${label} envelope). This usually means ENCRYPTION_KEY has changed since the secret was saved — restore the original key, or re-enter the credential in Settings.`,
    );
  }
}

/** Constant-time string compare for tokens that are not hashed. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
