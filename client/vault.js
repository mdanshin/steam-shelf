import { credentialScope, normalizeSyncSnapshot, validApiKey, validSteamId } from './core.js';

const CREDENTIAL_KEY_ALGORITHM = { name: 'AES-GCM', length: 256 };

// The Steam Web API key is the one secret this vault holds, so it is never written to
// IndexedDB in the clear: it is sealed with a non-extractable AES-GCM key that is itself
// persisted via the same storage abstraction (real IndexedDB natively supports storing
// CryptoKey objects, and so does structuredClone in tests/Node). A non-extractable key
// can be used to encrypt/decrypt but its raw bytes can never be read back out through the
// storage layer — this mainly raises the bar against passive/offline inspection of the
// browser profile; it does not defend against an attacker who already runs same-origin JS.
async function loadCredentialKey(storage, key) {
  return (await storage.get(key('cryptoKey'))) || null;
}

async function ensureCredentialKey(storage, key) {
  const existing = await loadCredentialKey(storage, key);
  if (existing) return existing;
  const generated = await crypto.subtle.generateKey(CREDENTIAL_KEY_ALGORITHM, false, ['encrypt', 'decrypt']);
  await storage.set(key('cryptoKey'), generated);
  return generated;
}

async function sealCredentials(storage, key, credentials) {
  const cryptoKey = await ensureCredentialKey(storage, key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(credentials));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plaintext);
  return { iv, ciphertext };
}

async function unsealCredentials(storage, key, sealed) {
  if (!sealed || !(sealed.iv instanceof Uint8Array) || !(sealed.ciphertext instanceof ArrayBuffer)) return null;
  const cryptoKey = await loadCredentialKey(storage, key);
  if (!cryptoKey) return null;
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, cryptoKey, sealed.ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}

export function createVault(uid, storage) {
  const scope = credentialScope(uid);
  const key = (name) => `${scope}:${name}`;
  return {
    credentials: async () => {
      const sealed = await storage.get(key('credentials'));
      const value = await unsealCredentials(storage, key, sealed);
      return validSteamId(value?.steamId) && validApiKey(value?.apiKey) ? { steamId: value.steamId, apiKey: value.apiKey } : null;
    },
    saveCredentials: async ({ steamId, apiKey }) => {
      if (!validSteamId(steamId)) throw new TypeError('Введите корректный SteamID64.');
      if (!validApiKey(apiKey)) throw new TypeError('Введите корректный Steam Web API key.');
      await storage.set(key('credentials'), await sealCredentials(storage, key, { steamId, apiKey }));
    },
    replaceConnection: async ({ steamId, apiKey }, librarySnapshot) => {
      if (!validSteamId(steamId)) throw new TypeError('Введите корректный SteamID64.');
      if (!validApiKey(apiKey)) throw new TypeError('Введите корректный Steam Web API key.');
      const library = normalizeSyncSnapshot('library', librarySnapshot);
      const sealed = await sealCredentials(storage, key, { steamId, apiKey });
      await storage.update({
        set: [[key('credentials'), sealed], [key('snapshot:library'), library]],
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
    disconnect: async () => storage.update({ delete: [key('credentials'), key('cryptoKey'), key('snapshot:library'), key('snapshot:wishlist')] }),
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
