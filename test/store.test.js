import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createStore } from '../lib/store.js';

const apiKey = 'ABCDEF0123456789ABCDEF0123456789';

async function withStore(run) {
  const path = join(tmpdir(), `steam-shelf-${randomUUID()}.sqlite`);
  const store = createStore({ path, masterKey: Buffer.alloc(32, 9) });
  try { await run(store, path); } finally { store.close(); await rm(path, { force: true }); }
}

test('user settings persist an encrypted Steam key and expose only a mask', async () => withStore(async (store, path) => {
  const user = store.upsertUser({ googleSub: 'sub-1', email: 'user@example.com', name: 'User', picture: null });
  store.saveSteamSettings(user.id, { steamId: '76561199999999999', apiKey });
  assert.deepEqual(store.getPublicSettings(user.id), { steamId: '76561199999999999', hasApiKey: true, apiKeyMask: '••••••••6789' });
  assert.deepEqual(store.getSteamCredentials(user.id), { steamId: '76561199999999999', apiKey, revision: 1 });
  assert.equal((await readFile(path)).includes(Buffer.from(apiKey)), false);
}));

test('OAuth state and sessions are one-time, expiring and stored by token hash', async () => withStore(async (store) => {
  store.saveOAuthAttempt({ state: 'state', verifier: 'verifier', nonce: 'nonce', expiresAt: Date.now() + 10000 });
  assert.deepEqual(store.consumeOAuthAttempt('state'), { verifier: 'verifier', nonce: 'nonce' });
  assert.equal(store.consumeOAuthAttempt('state'), null);
  store.saveOAuthAttempt({ state: 'expired', verifier: 'v', nonce: 'n', expiresAt: Date.now() - 1 });
  assert.equal(store.consumeOAuthAttempt('expired'), null);
  const user = store.upsertUser({ googleSub: 'sub-2', email: 'two@example.com', name: 'Two', picture: null });
  store.createSession({ token: 'raw-session-token', csrfToken: 'csrf-token', userId: user.id, expiresAt: Date.now() + 10000 });
  assert.equal(store.getSessionUser('raw-session-token').email, 'two@example.com');
  assert.equal(store.getSessionUser('raw-session-token').csrfToken, 'csrf-token');
  store.deleteSession('raw-session-token');
  assert.equal(store.getSessionUser('raw-session-token'), null);
}));

test('personal catalog snapshots remain isolated by user and kind', async () => withStore(async (store) => {
  const first = store.upsertUser({ googleSub: 'one', email: 'one@example.com', name: 'One', picture: null });
  const second = store.upsertUser({ googleSub: 'two', email: 'two@example.com', name: 'Two', picture: null });
  store.saveSnapshot(first.id, 'library', { games: [{ appid: 1 }], syncedAt: 'now' });
  store.saveSnapshot(first.id, 'wishlist', { games: [{ appid: 2 }], syncedAt: 'now' });
  assert.equal(store.getSnapshot(first.id, 'library').games[0].appid, 1);
  assert.equal(store.getSnapshot(first.id, 'wishlist').games[0].appid, 2);
  assert.equal(store.getSnapshot(second.id, 'library'), null);
  store.deleteSteamConnection(first.id);
  assert.equal(store.getSteamCredentials(first.id), null);
  assert.equal(store.getSnapshot(first.id, 'library'), null);
  assert.equal(store.getSnapshot(first.id, 'wishlist'), null);
}));

test('expired OAuth attempts and sessions are purged in bulk', async () => withStore(async (store) => {
  const user = store.upsertUser({ googleSub: 'purge', email: 'purge@example.com', name: 'Purge', picture: null });
  store.saveOAuthAttempt({ state: 'expired', verifier: 'v', nonce: 'n', expiresAt: Date.now() - 1 });
  assert.deepEqual(store.purgeExpired(), { oauthAttempts: 1, sessions: 0 });
  store.createSession({ token: 'expired-session', csrfToken: 'csrf', userId: user.id, expiresAt: Date.now() - 1 });
  assert.deepEqual(store.purgeExpired(), { oauthAttempts: 0, sessions: 1 });
  assert.equal(store.consumeOAuthAttempt('expired'), null);
  assert.equal(store.getSessionUser('expired-session'), null);
}));

test('snapshot writes require the same live credential revision', async () => withStore(async (store) => {
  const user = store.upsertUser({ googleSub: 'race', email: 'race@example.com', name: 'Race', picture: null });
  store.connectSteam(user.id, { steamId: '76561199999999999', apiKey }, { games: [{ appid: 1 }] });
  const first = store.getSteamCredentials(user.id);
  assert.equal(first.revision, 1);
  store.deleteSteamConnection(user.id);
  assert.equal(store.saveSnapshotIfCurrent(user.id, 'library', { games: [{ appid: 2 }] }, first.revision), false);
  store.connectSteam(user.id, { steamId: '76561199999999998', apiKey }, { games: [{ appid: 3 }] });
  const replacement = store.getSteamCredentials(user.id);
  assert.equal(replacement.revision, 3);
  assert.equal(store.saveSnapshotIfCurrent(user.id, 'library', { games: [{ appid: 4 }] }, first.revision), false);
  assert.equal(store.getSnapshot(user.id, 'library').games[0].appid, 3);
  assert.equal(store.saveSnapshotIfCurrent(user.id, 'wishlist', { games: [{ appid: 5 }] }, replacement.revision), true);
}));
