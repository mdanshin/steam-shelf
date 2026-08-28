import test from 'node:test';
import assert from 'node:assert/strict';

import { createIndexedDbStorage, createVault } from '../client/vault.js';

function memoryStorage() {
  const values = new Map();
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => values.set(key, structuredClone(value)),
    delete: async (key) => values.delete(key),
    deleteMany: async (keys) => { for (const key of keys) values.delete(key); },
    update: async ({ set = [], delete: deleted = [] }) => { for (const [key, value] of set) values.set(key, structuredClone(value)); for (const key of deleted) values.delete(key); },
  };
}

function transactionalIndexedDb() {
  const values = new Map();
  let abortWrites = false;
  const database = {
    objectStoreNames: { contains: () => true },
    transaction(_name, mode) {
      const staged = new Map(values);
      let completion;
      const tx = { error: null };
      const scheduleCompletion = () => {
        clearTimeout(completion);
        completion = setTimeout(() => {
          if (abortWrites && mode === 'readwrite') { tx.error = new Error('forced abort'); tx.onabort?.(); return; }
          if (mode === 'readwrite') { values.clear(); for (const [key, value] of staged) values.set(key, value); }
          tx.oncomplete?.();
        }, 0);
      };
      const request = (operation) => {
        const result = {};
        queueMicrotask(() => {
          try { result.result = operation(); result.onsuccess?.(); scheduleCompletion(); }
          catch (error) { result.error = error; result.onerror?.(); }
        });
        return result;
      };
      tx.objectStore = () => ({
        get: (key) => request(() => staged.get(key)),
        put: (value, key) => request(() => staged.set(key, structuredClone(value))),
        delete: (key) => request(() => staged.delete(key)),
      });
      return tx;
    },
  };
  return {
    indexedDb: { open: () => { const request = {}; queueMicrotask(() => { request.result = database; request.onsuccess?.(); }); return request; } },
    values,
    abortNextWrites: () => { abortWrites = true; },
  };
}

test('vault isolates credentials and snapshots by Firebase uid', async () => {
  const storage = memoryStorage();
  const first = createVault('user-a', storage);
  const second = createVault('user-b', storage);
  await first.saveCredentials({ steamId: '76561199999999999', apiKey: 'A'.repeat(32) });
  await first.saveSnapshot('library', { resource: 'library', games: [], syncedAt: '2026-08-22T00:00:00.000Z' });
  assert.equal((await first.credentials()).steamId, '76561199999999999');
  assert.equal(await second.credentials(), null);
  assert.equal((await first.snapshot('library')).resource, 'library');
  assert.equal(await second.snapshot('library'), null);
});

test('disconnect clears credentials and personal snapshots together', async () => {
  const storage = memoryStorage();
  const vault = createVault('user-a', storage);
  await vault.saveCredentials({ steamId: '76561199999999999', apiKey: 'A'.repeat(32) });
  await vault.saveSnapshot('library', { resource: 'library', games: [], syncedAt: '2026-08-22T00:00:00.000Z' });
  await vault.saveSnapshot('wishlist', { resource: 'wishlist', games: [], syncedAt: '2026-08-22T00:00:00.000Z' });
  await vault.disconnect();
  assert.equal(await vault.credentials(), null);
  assert.equal(await vault.snapshot('library'), null);
  assert.equal(await vault.snapshot('wishlist'), null);
});

test('credential replacement atomically replaces library and removes the prior wishlist', async () => {
  const storage = memoryStorage();
  const vault = createVault('user-a', storage);
  await vault.saveCredentials({ steamId: '76561199999999999', apiKey: 'a'.repeat(32) });
  await vault.saveSnapshot('wishlist', { resource: 'wishlist', games: [], syncedAt: '2026-08-22T00:00:00.000Z' });
  const library = { resource: 'library', games: [], syncedAt: '2026-08-23T00:00:00.000Z' };
  await vault.replaceConnection({ steamId: '76561199999999998', apiKey: 'b'.repeat(32) }, library);
  assert.equal((await vault.credentials()).steamId, '76561199999999998');
  assert.equal((await vault.snapshot('library')).syncedAt, library.syncedAt);
  assert.equal(await vault.snapshot('wishlist'), null);
});

test('vault rejects malformed snapshots and ignores malformed stored credentials', async () => {
  const storage = memoryStorage();
  const vault = createVault('user-safe', storage);
  await assert.rejects(() => vault.saveSnapshot('library', { resource: 'wishlist', games: [], syncedAt: new Date().toISOString() }), /resource/i);
  await storage.set('steam-shelf:user:user-safe:credentials', { steamId: 'bad', apiKey: 'bad' });
  await storage.set('steam-shelf:user:user-safe:snapshot:library', { resource: 'library', games: 'bad', syncedAt: 'bad' });
  assert.equal(await vault.credentials(), null);
  assert.equal(await vault.snapshot('library'), null);
});

test('IndexedDB disconnect waits for one atomic transaction commit', async () => {
  const fake = transactionalIndexedDb();
  const storage = createIndexedDbStorage(fake.indexedDb);
  const vault = createVault('transaction-user', storage);
  await vault.saveCredentials({ steamId: '76561199999999999', apiKey: 'a'.repeat(32) });
  await vault.saveSnapshot('library', { resource: 'library', games: [], syncedAt: '2026-08-22T00:00:00.000Z' });
  await vault.saveSnapshot('wishlist', { resource: 'wishlist', games: [], syncedAt: '2026-08-22T00:00:00.000Z' });
  assert.equal(fake.values.size, 3);
  fake.abortNextWrites();
  await assert.rejects(() => vault.replaceConnection(
    { steamId: '76561199999999998', apiKey: 'b'.repeat(32) },
    { resource: 'library', games: [], syncedAt: '2026-08-23T00:00:00.000Z' },
  ), /forced abort/);
  assert.equal((await vault.credentials()).steamId, '76561199999999999');
  assert.notEqual(await vault.snapshot('wishlist'), null);
  await assert.rejects(() => vault.disconnect(), /forced abort/);
  assert.equal(fake.values.size, 3);
});
