import test from 'node:test';
import assert from 'node:assert/strict';

import { handleSyncCall } from '../functions/handler.js';

const data = { resource: 'library', steamId: '76561199999999999', apiKey: 'A'.repeat(32) };

test('callable handler requires Firebase authentication before rate limit or Steam', async () => {
  let calls = 0;
  await assert.rejects(() => handleSyncCall({ auth: null, data }, {
    checkRateLimit: async () => { calls += 1; },
    sync: async () => { calls += 1; },
  }), (error) => error.code === 'unauthenticated');
  assert.equal(calls, 0);
});

test('callable handler scopes rate limit to authenticated uid', async () => {
  const seen = [];
  const result = await handleSyncCall({ auth: { uid: 'firebase-user', token: { email_verified: true, firebase: { sign_in_provider: 'google.com' } } }, data }, {
    checkRateLimit: async (uid, resource) => { seen.push(uid, resource); return async () => seen.push('released'); },
    sync: async (value) => ({ resource: value.resource, games: [], syncedAt: '2026-08-22T00:00:00.000Z' }),
  });
  assert.deepEqual(seen, ['firebase-user', 'library', 'released']);
  assert.equal(result.resource, 'library');
});

test('callable handler releases single-flight lease after upstream failure', async () => {
  let released = false;
  await assert.rejects(() => handleSyncCall({ auth: { uid: 'u', token: { email_verified: true, firebase: { sign_in_provider: 'google.com' } } }, data }, {
    checkRateLimit: async () => async () => { released = true; },
    sync: async () => { throw new Error('upstream failed'); },
  }));
  assert.equal(released, true);
});

test('callable handler converts client errors without exposing request secrets', async () => {
  await assert.rejects(() => handleSyncCall({ auth: { uid: 'u', token: { email_verified: true, firebase: { sign_in_provider: 'google.com' } } }, data }, {
    checkRateLimit: async () => {},
    sync: async () => { throw new TypeError('A valid SteamID64 is required'); },
  }), (error) => error.code === 'invalid-argument' && !String(error.message).includes(data.apiKey));
});

test('callable handler rejects unverified and non-Google identities', async () => {
  const dependencies = { checkRateLimit: async () => {}, sync: async () => ({}) };
  await assert.rejects(
    () => handleSyncCall({ auth: { uid: 'u', token: { email_verified: false, firebase: { sign_in_provider: 'google.com' } } }, data }, dependencies),
    (error) => error.code === 'permission-denied',
  );
  await assert.rejects(
    () => handleSyncCall({ auth: { uid: 'u', token: { email_verified: true, firebase: { sign_in_provider: 'password' } } }, data }, dependencies),
    (error) => error.code === 'permission-denied',
  );
});
