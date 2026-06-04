import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function normalizeKey(key: string): Buffer {
  // Pad or truncate to exactly 32 bytes
  return Buffer.from(key.padEnd(32, '0').slice(0, 32));
}

export function encrypt(text: string, key: string): string {
  const iv = randomBytes(16);
  const keyBuffer = normalizeKey(key);
  const cipher = createCipheriv(ALGORITHM, keyBuffer, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

export function decrypt(encryptedText: string, key: string): string {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    // Return as-is if not in encrypted format (migration safety)
    return encryptedText;
  }
  const [ivHex, authTagHex, encrypted] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const keyBuffer = normalizeKey(key);
  const decipher = createDecipheriv(ALGORITHM, keyBuffer, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
