import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptSecret, encryptSecret, maskSecret } from '../lib/secrets.js';

const masterKey = Buffer.alloc(32, 7);

test('Steam API keys are encrypted with randomized authenticated ciphertext', () => {
  const first = encryptSecret('ABCDEF0123456789ABCDEF0123456789', masterKey);
  const second = encryptSecret('ABCDEF0123456789ABCDEF0123456789', masterKey);
  assert.notEqual(first, second);
  assert.equal(decryptSecret(first, masterKey), 'ABCDEF0123456789ABCDEF0123456789');
  assert.equal(decryptSecret(second, masterKey), 'ABCDEF0123456789ABCDEF0123456789');
});

test('tampered encrypted API keys fail closed', () => {
  const payload = encryptSecret('ABCDEF0123456789ABCDEF0123456789', masterKey);
  const parts = payload.split('.');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  ciphertext[0] ^= 1;
  parts[3] = ciphertext.toString('base64url');
  const tampered = parts.join('.');
  assert.throws(() => decryptSecret(tampered, masterKey));
});

test('API key masking never reveals the stored key', () => {
  assert.equal(maskSecret('ABCDEF0123456789ABCDEF0123456789'), '••••••••6789');
  assert.equal(maskSecret(''), 'Не задан');
});

test('encrypted API keys are bound to their user context', () => {
  const payload = encryptSecret('ABCDEF0123456789ABCDEF0123456789', masterKey, 'steam-api-key:user:1');
  assert.equal(decryptSecret(payload, masterKey, 'steam-api-key:user:1'), 'ABCDEF0123456789ABCDEF0123456789');
  assert.throws(() => decryptSecret(payload, masterKey, 'steam-api-key:user:2'));
});
