import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createStore } from '../lib/store.js';
import { createRateLimiter, createSteamServer } from '../server.js';

async function fixture(run, configOverrides = {}, dependencyOverrides = {}) {
  const path = join(tmpdir(), `steam-server-${randomUUID()}.sqlite`);
  const store = createStore({ path, masterKey: Buffer.alloc(32, 4) });
  const oauth = {
    begin: () => ({ state: 'state-1', nonce: 'nonce-1', codeVerifier: 'verifier-1', authorizationUrl: 'https://accounts.google.com/auth' }),
    complete: async () => ({ googleSub: 'google-user', email: 'user@example.com', name: 'User', picture: null }),
  };
  const steam = {
    owned: async ({ apiKey }) => {
      if (apiKey === 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF') throw new Error('invalid key');
      return { games: [{ appid: 10, name: 'Game' }], syncedAt: '2026-01-01T00:00:00Z' };
    },
    wishlist: async () => ({ games: [{ appid: 20, name: 'Wish' }], syncedAt: '2026-01-01T00:00:00Z' }),
  };
  const config = { origin: 'http://127.0.0.1', googleClientId: 'id', googleClientSecret: 'secret', googleConfigured: true, cookieSecure: false, ...configOverrides };
  const server = createSteamServer({ config, store, oauth: { ...oauth, ...dependencyOverrides.oauth }, steam: { ...steam, ...dependencyOverrides.steam }, deals: () => ({ games: [{ appid: 30, name: 'Deal' }], syncedAt: 'now' }) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  config.origin = base;
  try { await run({ base, store }); } finally { server.close(); await once(server, 'close'); store.close(); await rm(path, { force: true }); }
}

async function login(base) {
  const start = await fetch(`${base}/auth/google`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const oauthCookie = start.headers.get('set-cookie').split(';', 1)[0];
  const callback = await fetch(`${base}/auth/google/callback?code=code&state=state-1`, { redirect: 'manual', headers: { Cookie: oauthCookie } });
  assert.equal(callback.status, 302);
  const cookie = callback.headers.get('set-cookie').split(';', 1)[0];
  const me = await fetch(`${base}/api/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  return { cookie, me: await me.json() };
}

test('personal APIs require Google authentication', async () => fixture(async ({ base }) => {
  assert.deepEqual(await (await fetch(`${base}/api/status`)).json(), { googleConfigured: true });
  assert.equal((await fetch(`${base}/api/me`)).status, 401);
  assert.equal((await fetch(`${base}/api/catalog/library`)).status, 401);
}));

test('setup mode serves the app while Google OAuth is not configured', async () => fixture(async ({ base }) => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /href="https:\/\/store\.steampowered\.com\/account\/"/);
  assert.match(html, /сразу под именем аккаунта/);
  assert.match(html, /https:\/\/steamcommunity\.com\/dev\/apikey/);
  assert.deepEqual(await (await fetch(`${base}/api/status`)).json(), { googleConfigured: false });
  assert.equal((await fetch(`${base}/auth/google`, { redirect: 'manual' })).status, 503);
}, { googleClientId: '', googleClientSecret: '', googleConfigured: false }));

test('Google login creates a secure server session and logout revokes it', async () => fixture(async ({ base }) => {
  const { cookie, me } = await login(base);
  assert.equal(me.user.email, 'user@example.com');
  assert.ok(me.csrfToken);
  const logout = await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'X-CSRF-Token': me.csrfToken } });
  assert.equal(logout.status, 204);
  assert.equal((await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).status, 401);
}));

test('settings and sync enforce same-origin CSRF and isolate personal snapshots', async () => fixture(async ({ base }) => {
  const { cookie, me } = await login(base);
  const body = JSON.stringify({ steamId: '76561199999999999', apiKey: 'ABCDEF0123456789ABCDEF0123456789' });
  assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body })).status, 403);
  const headers = { Cookie: cookie, Origin: base, 'X-CSRF-Token': me.csrfToken, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers, body: 'null' })).status, 400);
  assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers, body: '{malformed}' })).status, 400);
  assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers, body })).status, 204);
  const validatedLibrary = await (await fetch(`${base}/api/catalog/library`, { headers: { Cookie: cookie } })).json();
  assert.equal(validatedLibrary.games[0].appid, 10);
  const badReplacement = JSON.stringify({ steamId: '76561199999999999', apiKey: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF' });
  assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers, body: badReplacement })).status, 422);
  assert.equal((await fetch(`${base}/api/me`, { headers: { Cookie: cookie } }).then((response) => response.json())).settings.apiKeyMask, '••••••••6789');
  assert.equal((await fetch(`${base}/api/sync/library`, { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(`${base}/api/sync/wishlist`, { method: 'POST', headers })).status, 200);
  const library = await (await fetch(`${base}/api/catalog/library`, { headers: { Cookie: cookie } })).json();
  const wishlist = await (await fetch(`${base}/api/catalog/wishlist`, { headers: { Cookie: cookie } })).json();
  const deals = await (await fetch(`${base}/api/catalog/deals`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual([library.games[0].appid, wishlist.games[0].appid, deals.games[0].appid], [10, 20, 30]);
  assert.equal((await fetch(`${base}/api/settings`, { method: 'DELETE', headers })).status, 204);
  const removedLibrary = await (await fetch(`${base}/api/catalog/library`, { headers: { Cookie: cookie } })).json();
  assert.equal(removedLibrary.games.length, 0);
}));

test('callback rejects missing, expired or replayed OAuth state', async () => fixture(async ({ base }) => {
  assert.equal((await fetch(`${base}/auth/google/callback?code=code&state=unknown`, { redirect: 'manual' })).status, 400);
  const start = await fetch(`${base}/auth/google`, { redirect: 'manual' });
  const oauthCookie = start.headers.get('set-cookie').split(';', 1)[0];
  assert.equal((await fetch(`${base}/auth/google/callback?code=code&state=state-1`, { redirect: 'manual' })).status, 400);
  assert.equal((await fetch(`${base}/auth/google/callback?code=code&state=state-1`, { redirect: 'manual', headers: { Cookie: oauthCookie } })).status, 302);
  assert.equal((await fetch(`${base}/auth/google/callback?code=code&state=state-1`, { redirect: 'manual', headers: { Cookie: oauthCookie } })).status, 400);
}));

test('expensive Steam sync is rate limited before unbounded upstream calls', async () => fixture(async ({ base }) => {
  const { cookie, me } = await login(base);
  const headers = { Cookie: cookie, Origin: base, 'X-CSRF-Token': me.csrfToken, 'Content-Type': 'application/json' };
  const body = JSON.stringify({ steamId: '76561199999999999', apiKey: 'ABCDEF0123456789ABCDEF0123456789' });
  assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers, body })).status, 204);
  const statuses = [];
  for (let index = 0; index < 7; index += 1) statuses.push((await fetch(`${base}/api/sync/library`, { method: 'POST', headers })).status);
  assert.deepEqual(statuses.slice(0, 6), [200, 200, 200, 200, 200, 200]);
  assert.equal(statuses[6], 429);
}));

test('rate limiter expires idle keys and remains bounded', () => {
  let now = 0;
  const limiter = createRateLimiter({ now: () => now, maximumBuckets: 3 });
  for (let index = 0; index < 20; index += 1) limiter.allow(`client-${index}`, 2, 1000);
  assert.ok(limiter.size() <= 3);
  now = 2000;
  limiter.allow('fresh', 2, 1000);
  assert.equal(limiter.size(), 1);
});

test('spoofed forwarding headers do not bypass direct-peer OAuth rate limits', async () => fixture(async ({ base }) => {
  const statuses = [];
  for (let index = 0; index < 21; index += 1) {
    statuses.push((await fetch(`${base}/auth/google`, { redirect: 'manual', headers: { 'X-Forwarded-For': `203.0.113.${index}` } })).status);
  }
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(302));
  assert.equal(statuses[20], 429);
}));

test('an in-flight sync cannot restore a snapshot after disconnect', async () => {
  let resolveSync;
  let ownedCalls = 0;
  const owned = async () => {
    ownedCalls += 1;
    if (ownedCalls === 1) return { games: [{ appid: 1 }], syncedAt: 'setup' };
    return new Promise((resolve) => { resolveSync = resolve; });
  };
  await fixture(async ({ base }) => {
    const { cookie, me } = await login(base);
    const headers = { Cookie: cookie, Origin: base, 'X-CSRF-Token': me.csrfToken, 'Content-Type': 'application/json' };
    const body = JSON.stringify({ steamId: '76561199999999999', apiKey: 'ABCDEF0123456789ABCDEF0123456789' });
    assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers, body })).status, 204);
    const syncing = fetch(`${base}/api/sync/library`, { method: 'POST', headers });
    while (!resolveSync) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await fetch(`${base}/api/settings`, { method: 'DELETE', headers })).status, 204);
    resolveSync({ games: [{ appid: 99 }], syncedAt: 'stale' });
    assert.equal((await syncing).status, 409);
    const snapshot = await (await fetch(`${base}/api/catalog/library`, { headers: { Cookie: cookie } })).json();
    assert.equal(snapshot.games.length, 0);
  }, {}, { steam: { owned } });
});

test('an in-flight sync cannot overwrite a replacement credential snapshot', async () => {
  let resolveSync;
  let ownedCalls = 0;
  const owned = async ({ steamId }) => {
    ownedCalls += 1;
    if (ownedCalls === 2) return new Promise((resolve) => { resolveSync = resolve; });
    return { games: [{ appid: steamId.endsWith('998') ? 3 : 1 }], syncedAt: 'current' };
  };
  await fixture(async ({ base }) => {
    const { cookie, me } = await login(base);
    const headers = { Cookie: cookie, Origin: base, 'X-CSRF-Token': me.csrfToken, 'Content-Type': 'application/json' };
    const key = 'ABCDEF0123456789ABCDEF0123456789';
    assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ steamId: '76561199999999999', apiKey: key }) })).status, 204);
    const syncing = fetch(`${base}/api/sync/library`, { method: 'POST', headers });
    while (!resolveSync) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ steamId: '76561199999999998', apiKey: key }) })).status, 204);
    resolveSync({ games: [{ appid: 99 }], syncedAt: 'stale' });
    assert.equal((await syncing).status, 409);
    const snapshot = await (await fetch(`${base}/api/catalog/library`, { headers: { Cookie: cookie } })).json();
    assert.equal(snapshot.games[0].appid, 3);
  }, {}, { steam: { owned } });
});
