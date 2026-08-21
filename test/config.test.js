import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.js';

const encryptionSecret = Buffer.alloc(32, 3).toString('base64url');

test('loopback server can start in setup mode before Google OAuth is configured', () => {
  const config = loadConfig({ STEAM_KEY_ENCRYPTION_SECRET: encryptionSecret });
  assert.equal(config.origin, 'http://127.0.0.1:4180');
  assert.equal(config.googleConfigured, false);
});

test('configured Google OAuth is reported explicitly', () => {
  const config = loadConfig({ STEAM_KEY_ENCRYPTION_SECRET: encryptionSecret, GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret' });
  assert.equal(config.googleConfigured, true);
});

test('encryption key remains mandatory even in setup mode', () => {
  assert.throws(() => loadConfig({}), /STEAM_KEY_ENCRYPTION_SECRET/);
});

test('APP_ORIGIN must be a pure origin without credentials, paths, queries or fragments', () => {
  const invalid = ['https://example.com/app', 'https://example.com/?mode=prod', 'https://example.com/#fragment', 'https://example.com?', ' https://example.com', 'https://user:pass@example.com'];
  for (const origin of invalid) {
    assert.throws(() => loadConfig({ APP_ORIGIN: origin, STEAM_KEY_ENCRYPTION_SECRET: encryptionSecret }), /pure origin/);
  }
  assert.equal(loadConfig({ APP_ORIGIN: 'https://example.com/', STEAM_KEY_ENCRYPTION_SECRET: encryptionSecret }).origin, 'https://example.com');
});
