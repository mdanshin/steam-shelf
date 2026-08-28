import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { RequestValidationError, syncSteamRequest, validateSyncRequest } from '../functions/steam-sync.js';

const SYNC_PATH = '/steam-shelf/v1/sync';
const MAX_BODY_BYTES = 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const TOKEN_MAX_BYTES = 4096;

class HttpError extends Error {
  constructor(status, code, message, retryAfter = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

class UpstreamPacer {
  constructor({ intervalMs = 150, maxWaitMs = 45_000, now = Date.now } = {}) {
    this.intervalMs = intervalMs;
    this.maxWaitMs = maxWaitMs;
    this.now = now;
    this.nextAt = 0;
  }

  async take(signal) {
    const now = this.now();
    const slot = Math.max(now, this.nextAt);
    const wait = slot - now;
    if (wait > this.maxWaitMs) throw new HttpError(429, 'upstream_budget_exhausted', 'Try again later.', 10);
    this.nextAt = slot + this.intervalMs;
    if (!wait) return;
    await new Promise((resolve, reject) => {
      const aborted = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', aborted);
        resolve();
      }, wait);
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }
}

export function validateFirebaseClaims(payload, projectId) {
  if (!payload || payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`) throw new HttpError(401, 'invalid_token', 'Authentication failed.');
  if (typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 128) throw new HttpError(401, 'invalid_token', 'Authentication failed.');
  if (payload.email_verified !== true || payload.firebase?.sign_in_provider !== 'google.com') throw new HttpError(403, 'identity_not_allowed', 'A verified Google account is required.');
  return { uid: payload.sub };
}

export async function createFirebaseTokenVerifier(projectId) {
  if (!/^[a-z][a-z0-9-]{4,29}$/.test(projectId)) throw new Error('A valid Firebase project id is required');
  const { createRemoteJWKSet, jwtVerify } = await import('jose');
  const keys = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'), {
    cooldownDuration: 30_000,
    timeoutDuration: 5_000,
  });
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, keys, {
        algorithms: ['RS256'],
        audience: projectId,
        issuer: `https://securetoken.google.com/${projectId}`,
        clockTolerance: 5,
        maxTokenAge: '1h',
      });
      return validateFirebaseClaims(payload, projectId);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(401, 'invalid_token', 'Authentication failed.');
    }
  };
}

export class GatewayLimiter {
  constructor({ now = Date.now, maxEntries = 10_000, quotaPath = null } = {}) {
    this.now = now;
    this.maxEntries = maxEntries;
    this.events = new Map();
    this.inFlight = new Set();
    this.active = { library: 0, wishlist: 0 };
    this.quota = quotaPath ? new DatabaseSync(quotaPath) : null;
    this.operations = 0;
    if (this.quota) {
      this.quota.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS daily_quota (identity TEXT NOT NULL, resource TEXT NOT NULL, bucket INTEGER NOT NULL, count INTEGER NOT NULL CHECK(count >= 0), PRIMARY KEY(identity, resource, bucket)) STRICT;');
      this.readQuota = this.quota.prepare('SELECT count FROM daily_quota WHERE identity = ? AND resource = ? AND bucket = ?');
      this.writeQuota = this.quota.prepare('INSERT INTO daily_quota(identity, resource, bucket, count) VALUES (?, ?, ?, 1) ON CONFLICT(identity, resource, bucket) DO UPDATE SET count = count + 1');
      this.pruneQuota = this.quota.prepare('DELETE FROM daily_quota WHERE bucket < ?');
      const currentBucket = Math.floor(this.now() / (24 * 60 * 60_000));
      this.pruneQuota.run(currentBucket - 1);
    }
  }

  #consume(key, windowMs, limit) {
    const now = this.now();
    const recent = (this.events.get(key) || []).filter((stamp) => now - stamp < windowMs);
    if (recent.length >= limit) throw new HttpError(429, 'rate_limited', 'Try again later.', Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000)));
    recent.push(now);
    this.events.delete(key);
    this.events.set(key, recent);
    while (this.events.size > this.maxEntries) this.events.delete(this.events.keys().next().value);
  }

  #consumeDaily(uid, resource, limit) {
    if (!this.quota) {
      this.#consume(`${uid}:${resource}:daily`, 24 * 60 * 60_000, limit);
      return;
    }
    const now = this.now();
    const bucket = Math.floor(now / (24 * 60 * 60_000));
    const identity = createHash('sha256').update(uid).digest('hex');
    const current = this.readQuota.get(identity, resource, bucket)?.count || 0;
    if (current >= limit) {
      const retryAfter = Math.max(1, Math.ceil((((bucket + 1) * 24 * 60 * 60_000) - now) / 1000));
      throw new HttpError(429, 'rate_limited', 'Try again later.', retryAfter);
    }
    this.writeQuota.run(identity, resource, bucket);
    this.operations += 1;
    if (this.operations % 100 === 0) this.pruneQuota.run(bucket - 1);
  }

  acquire(uid, resource) {
    const [windowMs, shortLimit, dailyLimit] = resource === 'library'
      ? [5 * 60_000, 6, 30]
      : [15 * 60_000, 2, 8];
    const maximum = resource === 'wishlist' ? 1 : 4;
    if (this.active[resource] >= maximum) throw new HttpError(429, 'busy', 'Try again later.', 10);
    const flight = uid;
    if (this.inFlight.has(flight)) throw new HttpError(409, 'already_running', 'This sync is already running.');
    this.#consume(`${uid}:${resource}:short`, windowMs, shortLimit);
    this.#consumeDaily(uid, resource, dailyLimit);
    this.inFlight.add(flight);
    this.active[resource] += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight.delete(flight);
      this.active[resource] = Math.max(0, this.active[resource] - 1);
    };
  }

  close() {
    this.quota?.close();
  }
}

async function readBody(request) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large', 'Request body is too large.');
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large', 'Request body is too large.');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks, total).toString('utf8')); }
  catch { throw new HttpError(400, 'invalid_json', 'A valid JSON object is required.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_request', 'A request object is required.');
  return value;
}

function writeJson(response, status, payload, origin = null, retryAfter = null) {
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  if (retryAfter) headers['Retry-After'] = String(retryAfter);
  response.writeHead(status, headers);
  response.end(body);
}

function bearerToken(request) {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) throw new HttpError(401, 'authentication_required', 'Authentication is required.');
  const token = header.slice(7);
  if (!token || Buffer.byteLength(token) > TOKEN_MAX_BYTES || /\s/.test(token)) throw new HttpError(401, 'invalid_token', 'Authentication failed.');
  return token;
}

export function createGateway({ allowedOrigins, verifyToken, sync = syncSteamRequest, limiter = new GatewayLimiter(), pacer = new UpstreamPacer(), logger = console } = {}) {
  if (!(allowedOrigins instanceof Set) || !allowedOrigins.size || typeof verifyToken !== 'function') throw new TypeError('Gateway dependencies are required');
  return http.createServer(async (request, response) => {
    const requestId = randomUUID();
    const started = Date.now();
    const rawUrl = request.url || '';
    const origin = request.headers.origin;
    let status = 500;
    let controller;
    let deadlineExpired = false;
    try {
      if (rawUrl !== SYNC_PATH) throw new HttpError(404, 'not_found', 'Not found.');
      if (typeof origin !== 'string' || !allowedOrigins.has(origin)) throw new HttpError(403, 'origin_not_allowed', 'Origin is not allowed.');
      if (request.method === 'OPTIONS') {
        const method = request.headers['access-control-request-method'];
        const headers = String(request.headers['access-control-request-headers'] || '').toLowerCase().split(',').map((value) => value.trim()).filter(Boolean);
        if (method !== 'POST' || headers.some((header) => !['authorization', 'content-type'].includes(header))) throw new HttpError(403, 'preflight_not_allowed', 'Preflight is not allowed.');
        response.writeHead(204, {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'authorization, content-type',
          'Access-Control-Max-Age': '600',
          'Cache-Control': 'no-store',
          Vary: 'Origin',
        });
        response.end();
        status = 204;
        return;
      }
      if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
      if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'content_type_required', 'Content-Type must be application/json.');
      const identity = await verifyToken(bearerToken(request));
      const body = await readBody(request);
      const { resource } = validateSyncRequest(body);
      const release = limiter.acquire(identity.uid, resource);
      controller = new AbortController();
      const abortDisconnected = () => {
        if (!response.writableEnded && !controller.signal.aborted) controller.abort(new Error('client disconnected'));
      };
      request.once('aborted', abortDisconnected);
      response.once('close', abortDisconnected);
      const timeout = setTimeout(() => {
        deadlineExpired = true;
        controller.abort(new Error('deadline exceeded'));
      }, REQUEST_TIMEOUT_MS);
      try {
        const result = await sync(body, { signal: controller.signal, beforeFetch: (signal) => pacer.take(signal) });
        const encoded = JSON.stringify(result);
        if (Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) throw new HttpError(502, 'invalid_upstream', 'Steam returned too much data.');
        if (!controller.signal.aborted && !response.destroyed) {
          status = 200;
          writeJson(response, 200, result, origin);
        }
      } finally {
        clearTimeout(timeout);
        request.off('aborted', abortDisconnected);
        response.off('close', abortDisconnected);
        release();
      }
    } catch (error) {
      if (response.destroyed || controller?.signal.reason?.message === 'client disconnected') {
        status = 499;
        return;
      }
      const safe = error instanceof HttpError
        ? error
        : error instanceof RequestValidationError
          ? new HttpError(400, 'invalid_request', 'Invalid request.')
          : deadlineExpired
            ? new HttpError(504, 'upstream_timeout', 'Steam did not respond in time.')
            : new HttpError(502, 'upstream_failed', 'Steam is temporarily unavailable.');
      status = safe.status;
      if (!response.headersSent) writeJson(response, safe.status, { error: { code: safe.code, message: safe.message, requestId } }, allowedOrigins.has(origin) ? origin : null, safe.retryAfter);
    } finally {
      logger.info?.({ requestId, route: rawUrl.split('?')[0], method: request.method, status, durationMs: Date.now() - started });
    }
  });
}

async function main() {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'steam-shelf-mdanshin';
  const port = Number(process.env.PORT || 8001);
  const allowedOrigins = new Set(String(process.env.ALLOWED_ORIGINS || 'https://danshin.ms,https://mdanshin.github.io').split(',').map((value) => value.trim()).filter(Boolean));
  const quotaPath = process.env.QUOTA_DB_PATH;
  if (!quotaPath) throw new Error('QUOTA_DB_PATH is required');
  const verifyToken = await createFirebaseTokenVerifier(projectId);
  const server = createGateway({ allowedOrigins, verifyToken, limiter: new GatewayLimiter({ quotaPath }) });
  server.requestTimeout = 65_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
  console.info({ event: 'gateway_ready', address: '127.0.0.1', port });
  server.on('error', () => {
    console.error(JSON.stringify({ event: 'gateway_runtime_failed' }));
    process.exitCode = 1;
    server.close();
  });
}

let isDirectEntry = false;
try {
  isDirectEntry = Boolean(process.argv[1])
    && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  isDirectEntry = false;
}
if (isDirectEntry) {
  main().catch(() => {
    console.error(JSON.stringify({ event: 'gateway_start_failed' }));
    process.exitCode = 1;
  });
}
