const API_ORIGIN = 'https://api.steampowered.com';
const STORE_ORIGIN = 'https://store.steampowered.com';
const COVER_HOSTS = new Set(['shared.fastly.steamstatic.com', 'shared.akamai.steamstatic.com', 'cdn.cloudflare.steamstatic.com']);
const MAX_WISHLIST_ENTRIES = 5000;

export const validSteamId = (value) => /^7656119\d{10}$/.test(String(value));
export const validApiKey = (value) => /^[A-F0-9]{32}$/i.test(String(value));

function validateCredentials(steamId, apiKey) {
  if (!validSteamId(steamId)) throw new TypeError('A valid SteamID64 is required');
  if (!validApiKey(apiKey)) throw new TypeError('A valid Steam Web API key is required');
}

async function fetchJson(url, options, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(45_000), redirect: 'error', ...options });
  if (!response.ok) throw new Error(`Steam request failed (${response.status})`);
  const maximumBytes = 10 * 1024 * 1024;
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new Error('Steam response is too large');
  const source = await response.text();
  if (Buffer.byteLength(source, 'utf8') > maximumBytes) throw new Error('Steam response is too large');
  let value;
  try { value = JSON.parse(source); } catch { throw new Error('Steam returned invalid JSON'); }
  if (!value || typeof value !== 'object') throw new Error('Steam returned invalid JSON');
  return value;
}

function canonicalStoreUrl(appid) {
  return `https://store.steampowered.com/app/${appid}/`;
}

function trustedCover(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && COVER_HOSTS.has(url.hostname) ? url.href : null;
  } catch { return null; }
}

export async function fetchOwnedGames({ steamId, apiKey, fetchImpl = fetch }) {
  validateCredentials(steamId, apiKey);
  const params = new URLSearchParams({ steamid: steamId, include_appinfo: 'true', include_played_free_games: 'true', format: 'json' });
  const payload = await fetchJson(`${API_ORIGIN}/IPlayerService/GetOwnedGames/v0001/?${params}`, {
    headers: { 'x-webapi-key': apiKey, Accept: 'application/json' },
  }, fetchImpl);
  const response = payload.response || {};
  const games = Array.isArray(response.games) ? response.games : [];
  if (!Number.isInteger(response.game_count) || response.game_count !== games.length) throw new Error('Steam returned an incomplete owned-games response');
  const normalized = games.map((game) => ({
    appid: Number(game.appid),
    name: String(game.name || `Steam App ${game.appid}`),
    playtimeForever: Number(game.playtime_forever) || 0,
    playtimeTwoWeeks: Number(game.playtime_2weeks) || 0,
    lastPlayedAt: Number(game.rtime_last_played) || 0,
    storeUrl: canonicalStoreUrl(Number(game.appid)),
  })).filter((game) => Number.isInteger(game.appid) && game.appid > 0)
    .sort((left, right) => right.playtimeForever - left.playtimeForever || left.name.localeCompare(right.name));
  if (normalized.length !== games.length) throw new Error('Steam returned invalid owned-games records');
  return { games: normalized, syncedAt: new Date().toISOString() };
}

async function enrichWishlistItem(item, country, language, fetchImpl) {
  const appid = Number(item.appid);
  if (!Number.isInteger(appid) || appid <= 0) throw new Error('Steam wishlist contains an invalid App ID');
  const query = new URLSearchParams({ appids: String(appid), cc: country, l: language });
  const payload = await fetchJson(`${STORE_ORIGIN}/api/appdetails?${query}`, { headers: { Accept: 'application/json' } }, fetchImpl);
  const record = payload[String(appid)] || payload[appid];
  const fallback = {
    appid,
    name: `Steam App ${appid}`,
    dateAdded: Number(item.date_added) || 0,
    priceMinor: null,
    originalPriceMinor: null,
    savingsMinor: null,
    discountPercent: 0,
    coverUrl: null,
    storeUrl: canonicalStoreUrl(appid),
  };
  if (!record?.success || !record.data) return fallback;
  const data = record.data;
  const price = data.price_overview || null;
  const current = Number.isInteger(price?.final) ? price.final : data.is_free ? 0 : null;
  const original = Number.isInteger(price?.initial) ? price.initial : current;
  return {
    ...fallback,
    name: String(data.name || fallback.name),
    priceMinor: current,
    originalPriceMinor: original,
    savingsMinor: current !== null && original !== null ? Math.max(0, original - current) : null,
    discountPercent: Number.isInteger(price?.discount_percent) ? price.discount_percent : 0,
    coverUrl: trustedCover(data.header_image),
  };
}

export async function fetchWishlist({ steamId, country = 'ru', language = 'russian', fetchImpl = fetch, concurrency = 4 }) {
  if (!validSteamId(steamId)) throw new TypeError('A valid SteamID64 is required');
  const query = new URLSearchParams({ steamid: steamId });
  const payload = await fetchJson(`${API_ORIGIN}/IWishlistService/GetWishlist/v1/?${query}`, { headers: { Accept: 'application/json' } }, fetchImpl);
  const items = payload.response?.items;
  if (!Array.isArray(items)) throw new Error('Steam wishlist is private or unavailable');
  if (items.length > MAX_WISHLIST_ENTRIES) throw new Error('Steam wishlist has too many entries');
  const result = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(8, Number(concurrency) || 1)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await enrichWishlistItem(items[index], country, language, fetchImpl);
    }
  });
  await Promise.all(workers);
  if (result.length !== items.length || new Set(result.map((game) => game.appid)).size !== items.length) throw new Error('Steam returned an incomplete wishlist response');
  result.sort((left, right) => right.dateAdded - left.dateAdded || left.name.localeCompare(right.name));
  return { games: result, syncedAt: new Date().toISOString() };
}
