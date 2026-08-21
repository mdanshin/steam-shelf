import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v2';

function requireKey(masterKey) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    throw new TypeError('Encryption master key must be exactly 32 bytes');
  }
}

export function encryptSecret(plaintext, masterKey, context = '') {
  requireKey(masterKey);
  if (typeof plaintext !== 'string' || plaintext.length === 0) throw new TypeError('Secret is required');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(Buffer.from(String(context), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSecret(payload, masterKey, context = '') {
  requireKey(masterKey);
  const [version, ivText, tagText, ciphertextText, extra] = String(payload).split('.');
  if (version !== VERSION || extra !== undefined || !ivText || !tagText || !ciphertextText) throw new Error('Invalid encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(ivText, 'base64url'));
  decipher.setAAD(Buffer.from(String(context), 'utf8'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8');
}

export function maskSecret(secret) {
  return secret ? `••••••••${String(secret).slice(-4)}` : 'Не задан';
}
