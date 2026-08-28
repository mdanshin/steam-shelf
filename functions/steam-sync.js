const API_ORIGIN = 'https://api.steampowered.com';
const STORE_ORIGIN = 'https://store.steampowered.com';
const MAX_LIBRARY_BYTES = 5 * 1024 * 1024;
const MAX_WISHLIST_BYTES = 512 * 1024;
const MAX_DETAILS_BYTES = 256 * 1024;
const MAX_LIBRARY = 20_000;
const MAX_WISHLIST = 200;
const MAX_NAME_LENGTH = 300;

const validSteamId = (value) => /^7656119\d{10}$/.test(String(value));
const validApiKey = (value) => /^[A-F0-9]{32}$/i.test(String(value));

export class RequestValidationError extends TypeError {}

export function validateSyncRequest(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new RequestValidationError('A request object is required');
  const resource = String(data?.resource || '');
  if (!['library', 'wishlist'].includes(resource)) throw new RequestValidationError('Unsupported sync resource');
  const allowed = new Set(resource === 'library' ? ['resource', 'steamId', 'apiKey'] : ['resource', 'steamId']);
  if (Object.keys(data).some((field) => !allowed.has(field))) throw new RequestValidationError('Unexpected request field');
  const steamId = String(data?.steamId || '');
  const apiKey = String(data?.apiKey || '');
  if (!validSteamId(steamId)) throw new RequestValidationError('A valid SteamID64 is required');
  if (resource === 'library' && !validApiKey(apiKey)) throw new RequestValidationError('A valid Steam Web API key is required');
  return { resource, steamId, apiKey };
}

async function readBoundedText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Steam returned an unreadable response');
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('Steam response is too large');
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(output);
}

async function fetchJson(url, options, fetchImpl, { maxBytes, timeoutMs, signal, beforeFetch } = {}) {
  signal?.throwIfAborted();
  if (beforeFetch) await beforeFetch(signal);
  signal?.throwIfAborted();
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.any(signals) });
  if (!response?.ok) throw new Error(`Steam request failed (${response?.status || 'network'})`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Steam response is too large');
  const source = await readBoundedText(response, maxBytes);
  try {
    const value = JSON.parse(source);
    if (!value || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw new Error('Steam returned invalid JSON');
  }
}

function boundedName(value, appid) {
  const name = String(value || `Steam App ${appid}`);
  if (!name || name.length > MAX_NAME_LENGTH || /[\u0000-\u001F\u007F]/.test(name)) throw new Error('Steam returned an invalid game name');
  return name;
}

function nonNegativeInteger(value, field) {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Steam returned an invalid ${field}`);
  return number;
}

async function library(steamId, apiKey, fetchImpl, signal, beforeFetch) {
  const query = new URLSearchParams({ steamid: steamId, include_appinfo: 'true', include_played_free_games: 'true', format: 'json' });
  const payload = await fetchJson(`${API_ORIGIN}/IPlayerService/GetOwnedGames/v0001/?${query}`, {
    headers: { Accept: 'application/json', 'x-webapi-key': apiKey },
  }, fetchImpl, { maxBytes: MAX_LIBRARY_BYTES, timeoutMs: 15_000, signal, beforeFetch });
  const response = payload.response || {};
  const games = Array.isArray(response.games) ? response.games : [];
  if (!Number.isInteger(response.game_count) || response.game_count !== games.length) throw new Error('Steam returned an incomplete owned-games response');
  if (games.length > MAX_LIBRARY) throw new Error('Steam library has too many entries');
  const normalized = games.map((game) => ({
    appid: Number(game.appid),
    name: boundedName(game.name, game.appid),
    playtimeForever: nonNegativeInteger(game.playtime_forever, 'playtime'),
    lastPlayedAt: nonNegativeInteger(game.rtime_last_played, 'last-played timestamp'),
  }));
  if (normalized.some((game) => !Number.isInteger(game.appid) || game.appid <= 0)) throw new Error('Steam returned invalid owned-games records');
  if (new Set(normalized.map((game) => game.appid)).size !== normalized.length) throw new Error('Steam returned duplicate owned-games records');
  return normalized;
}

async function wishlist(steamId, fetchImpl, signal, beforeFetch) {
  const query = new URLSearchParams({ steamid: steamId });
  const payload = await fetchJson(`${API_ORIGIN}/IWishlistService/GetWishlist/v1/?${query}`, { headers: { Accept: 'application/json' } }, fetchImpl, { maxBytes: MAX_WISHLIST_BYTES, timeoutMs: 10_000, signal, beforeFetch });
  const items = payload.response?.items;
  if (!Array.isArray(items)) throw new Error('Steam wishlist is private or unavailable');
  if (items.length > MAX_WISHLIST) throw new Error('Steam wishlist has too many entries');
  const appids = items.map((item) => Number(item.appid));
  if (new Set(appids).size !== appids.length) throw new Error('Steam wishlist contains duplicate App IDs');
  const games = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(6, Math.max(1, items.length)) }, async () => {
    while (cursor < items.length) {
      signal?.throwIfAborted();
      const index = cursor++;
      const item = items[index];
    const appid = Number(item.appid);
    if (!Number.isInteger(appid) || appid <= 0) throw new Error('Steam wishlist contains an invalid App ID');
    const details = await fetchJson(`${STORE_ORIGIN}/api/appdetails?${new URLSearchParams({ appids: String(appid), cc: 'ru', l: 'russian' })}`, { headers: { Accept: 'application/json' } }, fetchImpl, { maxBytes: MAX_DETAILS_BYTES, timeoutMs: 5_000, signal, beforeFetch });
    const data = details[String(appid)]?.data;
    const price = data?.price_overview;
    const current = Number.isInteger(price?.final) ? price.final : data?.is_free ? 0 : null;
    const original = Number.isInteger(price?.initial) ? price.initial : current;
      games[index] = {
      appid,
      name: boundedName(data?.name, appid),
      dateAdded: nonNegativeInteger(item.date_added, 'wishlist timestamp'),
      priceMinor: current,
      originalPriceMinor: original,
      savingsMinor: current !== null && original !== null ? Math.max(0, original - current) : null,
      discountPercent: Number.isInteger(price?.discount_percent) ? price.discount_percent : 0,
      };
      if (![games[index].priceMinor, games[index].originalPriceMinor, games[index].savingsMinor].every((value) => value === null || (Number.isSafeInteger(value) && value >= 0)) || games[index].discountPercent < 0 || games[index].discountPercent > 100) throw new Error('Steam returned invalid price data');
    }
  });
  await Promise.all(workers);
  return games;
}

export async function syncSteamRequest(data, { fetchImpl = fetch, signal, beforeFetch } = {}) {
  const { resource, steamId, apiKey } = validateSyncRequest(data);
  const games = resource === 'library' ? await library(steamId, apiKey, fetchImpl, signal, beforeFetch) : await wishlist(steamId, fetchImpl, signal, beforeFetch);
  return { resource, games, syncedAt: new Date().toISOString() };
}
