import { credentialScope, normalizeSyncSnapshot, validApiKey, validSteamId } from './core.js';

export function createVault(uid, storage) {
  const scope = credentialScope(uid);
  const key = (name) => `${scope}:${name}`;
  return {
    credentials: async () => {
      const value = await storage.get(key('credentials'));
      return validSteamId(value?.steamId) && validApiKey(value?.apiKey) ? { steamId: value.steamId, apiKey: value.apiKey } : null;
    },
    saveCredentials: async ({ steamId, apiKey }) => {
      if (!validSteamId(steamId)) throw new TypeError('Введите корректный SteamID64.');
      if (!validApiKey(apiKey)) throw new TypeError('Введите корректный Steam Web API key.');
      await storage.set(key('credentials'), { steamId, apiKey });
    },
    replaceConnection: async ({ steamId, apiKey }, librarySnapshot) => {
      if (!validSteamId(steamId)) throw new TypeError('Введите корректный SteamID64.');
      if (!validApiKey(apiKey)) throw new TypeError('Введите корректный Steam Web API key.');
      const library = normalizeSyncSnapshot('library', librarySnapshot);
      await storage.update({
        set: [[key('credentials'), { steamId, apiKey }], [key('snapshot:library'), library]],
        delete: [key('snapshot:wishlist')],
      });
    },
    snapshot: async (resource) => {
      const value = await storage.get(key(`snapshot:${resource}`));
      if (!value) return null;
      try { return normalizeSyncSnapshot(resource, value); } catch { return null; }
    },
    saveSnapshot: async (resource, snapshot) => {
      if (!['library', 'wishlist'].includes(resource)) throw new TypeError('Unsupported snapshot resource');
      await storage.set(key(`snapshot:${resource}`), normalizeSyncSnapshot(resource, snapshot));
    },
    disconnect: async () => storage.update({ delete: [key('credentials'), key('snapshot:library'), key('snapshot:wishlist')] }),
  };
}

export function createIndexedDbStorage(indexedDb = globalThis.indexedDB) {
  if (!indexedDb) throw new Error('IndexedDB недоступен в этом браузере.');
  const database = new Promise((resolve, reject) => {
    const request = indexedDb.open('steam-shelf', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('records')) request.result.createObjectStore('records');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Не удалось открыть локальное хранилище.'));
  });
  const transaction = async (mode, operation) => {
    const db = await database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', mode);
      let result;
      const requests = [].concat(operation(tx.objectStore('records')) || []);
      for (const request of requests) {
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(request.error || new Error('Ошибка локального хранилища.'));
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => {};
      tx.onabort = () => reject(tx.error || new Error('Операция локального хранилища отменена.'));
    });
  };
  return {
    get: (key) => transaction('readonly', (store) => store.get(key)),
    set: (key, value) => transaction('readwrite', (store) => store.put(value, key)),
    delete: (key) => transaction('readwrite', (store) => store.delete(key)),
    deleteMany: (keys) => transaction('readwrite', (store) => keys.map((key) => store.delete(key))),
    update: ({ set = [], delete: deleted = [] }) => transaction('readwrite', (store) => [
      ...set.map(([key, value]) => store.put(value, key)),
      ...deleted.map((key) => store.delete(key)),
    ]),
  };
}
