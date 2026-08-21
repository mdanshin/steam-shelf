import http from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { beginGoogleLogin, completeGoogleLogin } from './lib/google-oauth.js';
import { fetchOwnedGames, fetchWishlist, validApiKey, validSteamId } from './lib/steam-api.js';
import { createStore } from './lib/store.js';
import { loadConfig } from './lib/config.js';
import { loadDeals } from './lib/deals.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SESSION_COOKIE = 'steam_session';
const OAUTH_COOKIE = 'steam_oauth_state';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' https://lh3.googleusercontent.com https://shared.fastly.steamstatic.com; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; object-src 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function send(res, status, body = '', headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function json(res, status, value) { send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' }); }
function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}
function sessionCookie(token, secure, maxAge = SESSION_SECONDS) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function oauthCookie(state, secure, maxAge = 600) {
  return `${OAUTH_COOKIE}=${encodeURIComponent(state)}; HttpOnly; SameSite=Lax; Path=/auth/google/callback; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('JSON required');
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new Error('Request too large');
    parts.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}
function safeUser(user) { return { email: user.email, name: user.name, picture: user.picture }; }

export function createRateLimiter({ now = Date.now, maximumBuckets = 10_000 } = {}) {
  const buckets = new Map();
  const purge = (timestamp) => {
    for (const [key, bucket] of buckets) {
      if (timestamp - bucket.times.at(-1) >= bucket.windowMs) buckets.delete(key);
    }
  };
  return {
    allow(key, maximum, windowMs = 5 * 60_000) {
      const timestamp = now();
      purge(timestamp);
      if (!buckets.has(key) && buckets.size >= maximumBuckets) buckets.delete(buckets.keys().next().value);
      const bucket = (buckets.get(key)?.times || []).filter((time) => timestamp - time < windowMs);
      if (bucket.length >= maximum) {
        buckets.set(key, { times: bucket, windowMs });
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((windowMs - (timestamp - bucket[0])) / 1000)) };
      }
      bucket.push(timestamp);
      buckets.set(key, { times: bucket, windowMs });
      return { allowed: true, retryAfter: 0 };
    },
    size: () => buckets.size,
  };
}

export function createSteamServer({ config, store, oauth, steam, deals, publicRoot = join(ROOT, 'public') }) {
  const googleConfigured = config.googleConfigured ?? Boolean(config.googleClientId && config.googleClientSecret);
  const rateLimiter = createRateLimiter();
  const enforceRate = (res, key, maximum) => {
    const result = rateLimiter.allow(key, maximum);
    if (result.allowed) return true;
    send(res, 429, JSON.stringify({ error: 'Слишком много запросов. Попробуйте позже.' }), { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(result.retryAfter) });
    return false;
  };
  const oauthClient = oauth || {
    begin: () => beginGoogleLogin(config),
    complete: ({ code, verifier, nonce }) => completeGoogleLogin({ config, code, codeVerifier: verifier, nonce }),
  };
  const steamClient = steam || {
    owned: (credentials) => fetchOwnedGames(credentials),
    wishlist: (credentials) => fetchWishlist(credentials),
  };
  const dealsProvider = deals || loadDeals;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, config.origin);
    const method = req.method || 'GET';
    const token = cookieValue(req, SESSION_COOKIE);
    const user = store.getSessionUser(token);
    const requireAuth = () => {
      if (!user) { json(res, 401, { error: 'Требуется вход через Google' }); return false; }
      return true;
    };
    const requireMutation = () => {
      if (!requireAuth()) return false;
      if (req.headers.origin !== config.origin || req.headers['x-csrf-token'] !== user.csrfToken) {
        json(res, 403, { error: 'Запрос отклонён защитой CSRF' }); return false;
      }
      return true;
    };

    try {
      if (method === 'GET' && url.pathname === '/api/status') return json(res, 200, { googleConfigured });
      if (method === 'GET' && url.pathname === '/auth/google') {
        if (!googleConfigured) return json(res, 503, { error: 'Google OAuth ещё не настроен' });
        if (!enforceRate(res, `oauth-start:${req.socket.remoteAddress || 'unknown'}`, 20)) return;
        const attempt = oauthClient.begin();
        store.saveOAuthAttempt({ ...attempt, verifier: attempt.codeVerifier, expiresAt: Date.now() + 10 * 60_000 });
        return send(res, 302, '', { Location: attempt.authorizationUrl, 'Set-Cookie': oauthCookie(attempt.state, config.cookieSecure) });
      }
      if (method === 'GET' && url.pathname === '/auth/google/callback') {
        if (!enforceRate(res, `oauth-callback:${req.socket.remoteAddress || 'unknown'}`, 40)) return;
        const state = url.searchParams.get('state') || '';
        if (!state || cookieValue(req, OAUTH_COOKIE) !== state) return json(res, 400, { error: 'Недействительная или просроченная попытка входа' });
        const attempt = store.consumeOAuthAttempt(state);
        if (!attempt || !url.searchParams.get('code')) return json(res, 400, { error: 'Недействительная или просроченная попытка входа' });
        const profile = await oauthClient.complete({ code: url.searchParams.get('code'), verifier: attempt.verifier, nonce: attempt.nonce });
        const account = store.upsertUser(profile);
        const sessionToken = randomBytes(32).toString('base64url');
        const csrfToken = randomBytes(32).toString('base64url');
        store.createSession({ token: sessionToken, csrfToken, userId: account.id, expiresAt: Date.now() + SESSION_SECONDS * 1000 });
        return send(res, 302, '', { Location: '/', 'Set-Cookie': [sessionCookie(sessionToken, config.cookieSecure), oauthCookie('', config.cookieSecure, 0)] });
      }
      if (method === 'GET' && url.pathname === '/api/me') {
        if (!requireAuth()) return;
        return json(res, 200, { user: safeUser(user), csrfToken: user.csrfToken, settings: store.getPublicSettings(user.id) });
      }
      if (method === 'POST' && url.pathname === '/api/logout') {
        if (!requireMutation()) return;
        store.deleteSession(token);
        return send(res, 204, '', { 'Set-Cookie': sessionCookie('', config.cookieSecure, 0) });
      }
      if (method === 'POST' && url.pathname === '/api/settings') {
        if (!requireMutation()) return;
        if (!enforceRate(res, `settings:${user.id}`, 10)) return;
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Ожидается объект настроек' });
        const steamId = String(body.steamId || '').trim();
        const suppliedKey = String(body.apiKey || '').trim();
        const existing = store.getSteamCredentials(user.id);
        const apiKey = suppliedKey || existing?.apiKey || '';
        if (!validSteamId(steamId) || !validApiKey(apiKey)) return json(res, 400, { error: 'Проверьте SteamID64 и 32-символьный Steam Web API key' });
        let library;
        try { library = await steamClient.owned({ steamId, apiKey }); }
        catch { return json(res, 422, { error: 'Steam не принял эти данные. Проверьте SteamID64, API key и приватность профиля.' }); }
        store.connectSteam(user.id, { steamId, apiKey }, library);
        return send(res, 204);
      }
      if (method === 'DELETE' && url.pathname === '/api/settings') {
        if (!requireMutation()) return;
        store.deleteSteamConnection(user.id);
        return send(res, 204);
      }
      if (method === 'POST' && (url.pathname === '/api/sync/library' || url.pathname === '/api/sync/wishlist')) {
        if (!requireMutation()) return;
        if (!enforceRate(res, `sync:${user.id}:${url.pathname}`, 6)) return;
        const credentials = store.getSteamCredentials(user.id);
        if (!credentials) return json(res, 409, { error: 'Сначала сохраните SteamID64 и API key' });
        const kind = url.pathname.endsWith('/library') ? 'library' : 'wishlist';
        const snapshot = kind === 'library' ? await steamClient.owned(credentials) : await steamClient.wishlist({ steamId: credentials.steamId });
        if (!store.saveSnapshotIfCurrent(user.id, kind, snapshot, credentials.revision)) {
          return json(res, 409, { error: 'Настройки Steam изменились во время синхронизации. Повторите запрос.' });
        }
        return json(res, 200, snapshot);
      }
      if (method === 'GET' && url.pathname.startsWith('/api/catalog/')) {
        if (!requireAuth()) return;
        const kind = url.pathname.slice('/api/catalog/'.length);
        if (kind === 'deals') return json(res, 200, await dealsProvider());
        if (kind !== 'library' && kind !== 'wishlist') return json(res, 404, { error: 'Не найдено' });
        return json(res, 200, store.getSnapshot(user.id, kind) || { games: [], syncedAt: null });
      }
      const staticFiles = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/index.html': ['index.html', 'text/html; charset=utf-8'],
        '/privacy.html': ['privacy.html', 'text/html; charset=utf-8'],
        '/terms.html': ['terms.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/catalog-lifecycle.js': ['catalog-lifecycle.js', 'text/javascript; charset=utf-8'],
        '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
      };
      if (method === 'GET' && staticFiles[url.pathname]) {
        const [name, type] = staticFiles[url.pathname];
        return send(res, 200, await readFile(join(publicRoot, name)), { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      }
      return json(res, 404, { error: 'Не найдено' });
    } catch (error) {
      if (error?.status === 400) return json(res, 400, { error: 'Некорректный JSON' });
      console.error(`[steam-shelf] ${method} ${url.pathname}: ${error instanceof Error ? error.message : 'unexpected error'}`);
      return json(res, 500, { error: 'Операция не выполнена. Попробуйте ещё раз.' });
    }
  });
}

async function main() {
  const config = loadConfig();
  await mkdir(dirname(config.databasePath), { recursive: true });
  const store = createStore({ path: config.databasePath, masterKey: config.masterKey });
  const server = createSteamServer({ config, store });
  server.listen(config.port, config.host, () => console.log(`Steam Shelf: ${config.origin}`));
  const close = () => server.close(() => { store.close(); process.exit(0); });
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exit(1); });
