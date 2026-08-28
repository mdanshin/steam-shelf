import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { createGateway, GatewayLimiter, validateFirebaseClaims } from '../gateway/server.js';

const ORIGIN = 'https://danshin.ms';
const TOKEN = 'test-token';
const LIBRARY = { resource: 'library', steamId: '76561199999999999', apiKey: ['A'.repeat(16), 'B'.repeat(16)].join('') };

test('direct gateway execution invokes bootstrap and reports startup failure generically', () => {
  const entry = fileURLToPath(new URL('../gateway/server.js', import.meta.url));
  const result = spawnSync(process.execPath, [entry], {
    env: { ...process.env, QUOTA_DB_PATH: '' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"event":"gateway_start_failed"/);
  assert.doesNotMatch(result.stderr, /QUOTA_DB_PATH|Error:|stack/i);
});

test('listen failures are caught and reported without address or stack details', async () => {
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-shelf-listen-'));
  try {
    const entry = fileURLToPath(new URL('../gateway/server.js', import.meta.url));
    const result = spawnSync(process.execPath, [entry], {
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        PORT: String(blocker.address().port),
        QUOTA_DB_PATH: path.join(directory, 'quota.sqlite'),
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /"event":"gateway_start_failed"/);
    assert.doesNotMatch(result.stderr, /EADDRINUSE|127\.0\.0\.1|Error:|stack/i);
  } finally {
    await new Promise((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function withGateway(options, run) {
  const server = createGateway({
    allowedOrigins: new Set([ORIGIN]),
    verifyToken: async (token) => {
      if (token !== TOKEN) throw new Error('invalid token');
      return { uid: 'google-user' };
    },
    sync: async (body) => ({ resource: body.resource, games: [], syncedAt: '2026-08-22T00:00:00.000Z' }),
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try { await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function request(base, body = LIBRARY, headers = {}) {
  return fetch(`${base}/steam-shelf/v1/sync`, {
    method: 'POST',
    headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('gateway accepts only the fixed authenticated CORS contract', async () => {
  let verified = 0;
  let synced = 0;
  await withGateway({
    verifyToken: async () => { verified += 1; return { uid: 'google-user' }; },
    sync: async (body) => { synced += 1; return { resource: body.resource, games: [], syncedAt: '2026-08-22T00:00:00.000Z' }; },
  }, async (base) => {
    const success = await request(base);
    assert.equal(success.status, 200);
    assert.equal(success.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(success.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await success.json(), { resource: 'library', games: [], syncedAt: '2026-08-22T00:00:00.000Z' });

    const denied = await request(base, LIBRARY, { Origin: 'https://danshin.ms.evil.example' });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);

    const queried = await fetch(`${base}/steam-shelf/v1/sync?target=evil`, { method: 'POST', headers: { Origin: ORIGIN } });
    assert.equal(queried.status, 404);
    assert.equal(verified, 1);
    assert.equal(synced, 1);
  });
});

test('gateway rejects bad auth, content types and oversized bodies before Steam', async () => {
  let synced = 0;
  await withGateway({ sync: async () => { synced += 1; } }, async (base) => {
    const missing = await fetch(`${base}/steam-shelf/v1/sync`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(missing.status, 401);

    const wrongType = await fetch(`${base}/steam-shelf/v1/sync`, { method: 'POST', headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(wrongType.status, 415);

    const oversized = await fetch(`${base}/steam-shelf/v1/sync`, { method: 'POST', headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(1100) }) });
    assert.equal(oversized.status, 413);
    assert.equal(synced, 0);
  });
});

test('gateway serializes one resource per uid and never reflects secrets in errors', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  await withGateway({ sync: async (body) => { await blocked; return { resource: body.resource, games: [], syncedAt: new Date().toISOString() }; } }, async (base) => {
    const first = request(base);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await request(base);
    assert.equal(second.status, 409);
    const error = JSON.stringify(await second.json());
    assert.equal(error.includes(LIBRARY.apiKey), false);
    release();
    assert.equal((await first).status, 200);
  });
});

test('Firebase claims are bound to this project and a verified Google identity', () => {
  const valid = {
    sub: 'uid-1', aud: 'steam-shelf-mdanshin', iss: 'https://securetoken.google.com/steam-shelf-mdanshin',
    email_verified: true, firebase: { sign_in_provider: 'google.com' },
  };
  assert.deepEqual(validateFirebaseClaims(valid, 'steam-shelf-mdanshin'), { uid: 'uid-1' });
  assert.throws(() => validateFirebaseClaims({ ...valid, email_verified: false }, 'steam-shelf-mdanshin'));
  assert.throws(() => validateFirebaseClaims({ ...valid, firebase: { sign_in_provider: 'password' } }, 'steam-shelf-mdanshin'));
  assert.throws(() => validateFirebaseClaims({ ...valid, aud: 'other' }, 'steam-shelf-mdanshin'));
});

test('gateway aborts upstream work when the downstream client disconnects', async () => {
  let started;
  const syncStarted = new Promise((resolve) => { started = resolve; });
  let upstreamAborted = false;
  await withGateway({
    sync: async (_body, { signal }) => {
      started();
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          upstreamAborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    },
  }, async (base) => {
    const url = new URL('/steam-shelf/v1/sync', base);
    const client = http.request(url, {
      method: 'POST',
      headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    });
    client.on('error', () => {});
    client.end(JSON.stringify(LIBRARY));
    await syncStarted;
    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(upstreamAborted, true);
  });
});

test('gateway maps runtime fetch failures to a generic upstream error', async () => {
  await withGateway({ sync: async () => { throw new TypeError('getaddrinfo ENOTFOUND internal-host'); } }, async (base) => {
    const response = await request(base);
    assert.equal(response.status, 502);
    const body = JSON.stringify(await response.json());
    assert.equal(body.includes('internal-host'), false);
  });
});

test('daily UID quotas survive gateway restarts without storing the UID', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-shelf-quota-'));
  const quotaPath = path.join(directory, 'limits.sqlite');
  let now = Date.UTC(2026, 7, 22, 0, 0, 0);
  let limiter = new GatewayLimiter({ quotaPath, now: () => now });
  for (let index = 0; index < 8; index += 1) {
    const release = limiter.acquire('private-firebase-uid', 'wishlist');
    release();
    now += 16 * 60_000;
  }
  limiter.close();
  limiter = new GatewayLimiter({ quotaPath, now: () => now });
  assert.throws(() => limiter.acquire('private-firebase-uid', 'wishlist'), (error) => error.status === 429);
  limiter.close();
  const bytes = fs.readFileSync(quotaPath);
  assert.equal(bytes.includes(Buffer.from('private-firebase-uid')), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('persistent quota rows older than the previous UTC day are pruned at startup', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-shelf-retention-'));
  const quotaPath = path.join(directory, 'quota.sqlite');
  const day = 24 * 60 * 60_000;
  try {
    const oldLimiter = new GatewayLimiter({ quotaPath, now: () => day });
    oldLimiter.acquire('retention-user', 'library')();
    oldLimiter.close();

    const currentLimiter = new GatewayLimiter({ quotaPath, now: () => 4 * day });
    currentLimiter.close();
    const database = new DatabaseSync(quotaPath);
    assert.equal(database.prepare('SELECT count(*) AS total FROM daily_quota').get().total, 0);
    database.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
