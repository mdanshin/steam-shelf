import test from 'node:test';
import assert from 'node:assert/strict';

import { createGatewaySync } from '../client/gateway.js';

const ENDPOINT = 'https://api.danshin.ms/steam-shelf/v1/sync';
const REQUEST = { resource: 'library', steamId: '76561199999999999', apiKey: 'A'.repeat(32) };

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('gateway client sends a Firebase bearer token to the fixed JSON endpoint', async () => {
  const calls = [];
  const sync = createGatewaySync({
    endpoint: ENDPOINT,
    getToken: async () => 'firebase-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ resource: 'library', games: [], syncedAt: '2026-08-22T00:00:00.000Z' });
    },
  });
  const result = await sync(REQUEST, { expectedUid: 'user-a' });
  assert.equal(result.resource, 'library');
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer firebase-token');
  assert.deepEqual(JSON.parse(calls[0].options.body), REQUEST);
  assert.equal(calls[0].options.credentials, 'omit');
});

test('gateway client refreshes the Firebase token exactly once after 401', async () => {
  const refreshes = [];
  let calls = 0;
  const sync = createGatewaySync({
    endpoint: ENDPOINT,
    getToken: async (force) => { refreshes.push(force); return force ? 'fresh' : 'old'; },
    fetchImpl: async () => (++calls === 1 ? jsonResponse({ error: { message: 'expired' } }, 401) : jsonResponse({ resource: 'wishlist', games: [], syncedAt: '2026-08-22T00:00:00.000Z' })),
  });
  await sync({ resource: 'wishlist', steamId: REQUEST.steamId }, { expectedUid: 'user-a' });
  assert.deepEqual(refreshes, [false, true]);
  assert.equal(calls, 2);
});

test('gateway client does not retry rate limits and does not expose server internals', async () => {
  let calls = 0;
  const sync = createGatewaySync({
    endpoint: ENDPOINT,
    getToken: async () => 'token',
    fetchImpl: async () => { calls += 1; return jsonResponse({ error: { code: 'rate_limited', message: 'Try again later.', debug: 'secret' } }, 429); },
  });
  await assert.rejects(() => sync(REQUEST, { expectedUid: 'user-a' }), /Попробуйте позже/);
  assert.equal(calls, 1);
});

test('gateway client accepts only the production HTTPS endpoint', () => {
  assert.throws(() => createGatewaySync({ endpoint: 'http://api.danshin.ms/steam-shelf/v1/sync', getToken() {}, fetchImpl() {} }));
  assert.throws(() => createGatewaySync({ endpoint: 'https://evil.example/steam-shelf/v1/sync', getToken() {}, fetchImpl() {} }));
  assert.throws(() => createGatewaySync({ endpoint: `${ENDPOINT}?proxy=1`, getToken() {}, fetchImpl() {} }));
});

test('gateway client cancels an oversized streaming response before buffering it all', async () => {
  let chunks = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      chunks += 1;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() { cancelled = true; },
  });
  const sync = createGatewaySync({
    endpoint: ENDPOINT,
    getToken: async () => 'token',
    fetchImpl: async () => new Response(stream, { status: 200 }),
  });
  await assert.rejects(() => sync(REQUEST, { expectedUid: 'user-a' }), /слишком большой/i);
  assert.equal(cancelled, true);
  assert.ok(chunks <= 4);
});

test('gateway client propagates an account-transition abort to fetch', async () => {
  const controller = new AbortController();
  let observedSignal;
  const sync = createGatewaySync({
    endpoint: ENDPOINT,
    getToken: async () => 'token',
    fetchImpl: async (_url, options) => {
      observedSignal = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    },
  });
  const pending = sync(REQUEST, { signal: controller.signal, expectedUid: 'user-a' });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new DOMException('Account changed.', 'AbortError'));
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(observedSignal.aborted, true);
});

test('gateway client settles immediately when account transition aborts token acquisition', async () => {
  const controller = new AbortController();
  let releaseToken;
  let fetchCalls = 0;
  const sync = createGatewaySync({
    endpoint: ENDPOINT,
    getToken: () => new Promise((resolve) => { releaseToken = resolve; }),
    fetchImpl: async () => { fetchCalls += 1; throw new Error('fetch must not run'); },
  });
  const pending = sync(REQUEST, { signal: controller.signal, expectedUid: 'user-a' });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new DOMException('Account changed.', 'AbortError'));
  await assert.rejects(Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error('abort did not settle token acquisition')), 100)),
  ]), (error) => error.name === 'AbortError');
  assert.equal(fetchCalls, 0);
  releaseToken('late-token');
});
