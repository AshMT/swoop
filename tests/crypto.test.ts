import './setup-env';
import { describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes } from 'crypto';
import { DecryptionError, decrypt, encrypt, isEncrypted, safeEqual } from '../src/services/crypto';

const KEY = 'a-reasonably-long-passphrase-for-tests';

describe('encrypt / decrypt', () => {
  it('round-trips a secret', () => {
    const secret = 'api-token-abc123';
    const sealed = encrypt(secret, KEY);
    expect(sealed).not.toContain(secret);
    expect(decrypt(sealed, KEY)).toBe(secret);
  });

  it('produces a different ciphertext each time (fresh nonce)', () => {
    expect(encrypt('same input', KEY)).not.toBe(encrypt('same input', KEY));
  });

  it('round-trips unicode and long values', () => {
    const secret = `${'x'.repeat(5000)} — émoji 🔐 — ${'y'.repeat(100)}`;
    expect(decrypt(encrypt(secret, KEY), KEY)).toBe(secret);
  });

  it('round-trips an empty-ish secret', () => {
    expect(decrypt(encrypt(' ', KEY), KEY)).toBe(' ');
  });

  it('uses a 96-bit nonce in the v2 envelope', () => {
    const [version, nonceHex] = encrypt('x', KEY).split(':');
    expect(version).toBe('v2');
    // 12 bytes = 24 hex characters.
    expect(nonceHex).toHaveLength(24);
  });

  it('rejects a wrong key with an actionable error rather than garbage', () => {
    const sealed = encrypt('secret', KEY);
    expect(() => decrypt(sealed, 'a-completely-different-passphrase')).toThrow(DecryptionError);
    expect(() => decrypt(sealed, 'a-completely-different-passphrase')).toThrow(/ENCRYPTION_KEY has changed/);
  });

  it('rejects a tampered ciphertext (GCM auth tag holds)', () => {
    const parts = encrypt('secret', KEY).split(':');
    // Flip the final ciphertext byte.
    const last = parts[3].slice(-2);
    parts[3] = parts[3].slice(0, -2) + (last === 'ff' ? '00' : 'ff');
    expect(() => decrypt(parts.join(':'), KEY)).toThrow(DecryptionError);
  });

  it('passes plaintext through unchanged, for installs that had no key', () => {
    expect(decrypt('plain-api-token', KEY)).toBe('plain-api-token');
    // A value with colons but not in envelope shape is still not encrypted.
    expect(decrypt('host:8080:path', KEY)).toBe('host:8080:path');
  });

  it('still decrypts the legacy zero-padded 16-byte-IV envelope', () => {
    // Reproduce exactly what the pre-v2 implementation wrote.
    const legacyKey = Buffer.from(KEY.padEnd(32, '0').slice(0, 32));
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', legacyKey, iv);
    let ciphertext = cipher.update('legacy-secret', 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    const legacy = `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext}`;

    expect(isEncrypted(legacy)).toBe(true);
    expect(decrypt(legacy, KEY)).toBe('legacy-secret');
  });

  it('identifies its own envelopes', () => {
    expect(isEncrypted(encrypt('x', KEY))).toBe(true);
    expect(isEncrypted('not-encrypted')).toBe(false);
    expect(isEncrypted('')).toBe(false);
  });
});

describe('safeEqual', () => {
  it('compares equal and unequal strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
