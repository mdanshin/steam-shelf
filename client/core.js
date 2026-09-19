export const validSteamId = (value) => /^7656119\d{10}$/.test(String(value));
// Keeps only ASCII digits: strips spaces, "Steam ID:" prefixes, NBSP/zero-width characters that mobile paste adds.
export const normalizeSteamId = (value) => String(value ?? '').replace(/[^0-9]/g, '');
export function steamIdProblem(value) {
  const digits = normalizeSteamId(value);
  if (!digits || validSteamId(digits)) return '';
  if (digits.length !== 17) return `Введено ${digits.length} цифр из 17.`;
  return 'SteamID64 должен начинаться с 7656119.';
}
export const validApiKey = (value) => /^[A-F0-9]{32}$/i.test(String(value));

export function credentialScope(uid) {
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(String(uid))) throw new TypeError('A valid Firebase user id is required');
  return `steam-shelf:user:${uid}`;
}

export function currentDeals(games, nowSeconds = Date.now() / 1000) {
  return games.filter((game) => !Number.isFinite(game.discountEndAt) || game.discountEndAt > nowSeconds);
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid ${field} in game record`);
  return value;
}

function optionalNonNegativeInteger(value, field) {
  return value === null ? null : nonNegativeInteger(value, field);
}

function normalizeGame(resource, game) {
  const appid = Number(game?.appid);
  if (!Number.isInteger(appid) || appid <= 0) throw new TypeError('Invalid game record');
  const name = String(game.name || `Steam App ${appid}`);
  if (!name || name.length > 300 || /[\u0000-\u001F\u007F]/.test(name)) throw new TypeError('Invalid game name');
  const base = { appid, name };
  if (resource === 'library') {
    return {
      ...base,
      playtimeForever: nonNegativeInteger(game.playtimeForever, 'playtime'),
      lastPlayedAt: nonNegativeInteger(game.lastPlayedAt, 'last-played timestamp'),
    };
  }
  const normalized = {
    ...base,
    dateAdded: nonNegativeInteger(game.dateAdded, 'wishlist timestamp'),
    priceMinor: optionalNonNegativeInteger(game.priceMinor, 'price'),
    originalPriceMinor: optionalNonNegativeInteger(game.originalPriceMinor, 'original price'),
    savingsMinor: optionalNonNegativeInteger(game.savingsMinor, 'savings'),
    discountPercent: nonNegativeInteger(game.discountPercent, 'discount'),
    reviewCount: optionalNonNegativeInteger(game.reviewCount ?? null, 'review count'),
    reviewPercent: optionalNonNegativeInteger(game.reviewPercent ?? null, 'review percentage'),
    reviewScore: nonNegativeInteger(game.reviewScore ?? 0, 'review score'),
    reviewScoreDesc: game.reviewScoreDesc ?? '',
  };
  if (normalized.discountPercent > 100) throw new TypeError('Invalid discount in game record');
  if (normalized.reviewPercent > 100 || normalized.reviewScore > 9 || typeof normalized.reviewScoreDesc !== 'string' || normalized.reviewScoreDesc.length > 300 || /[\u0000-\u001F\u007F]/.test(normalized.reviewScoreDesc)) throw new TypeError('Invalid reviews in game record');
  if (!normalized.reviewCount) normalized.reviewPercent = null;
  normalized.weak = normalized.reviewPercent !== null && (normalized.reviewPercent < 70 || normalized.reviewCount < 50);
  return normalized;
}

export function normalizeSyncSnapshot(resource, payload) {
  if (!['library', 'wishlist'].includes(resource) || payload?.resource !== resource) throw new TypeError('Unexpected sync resource');
  if (!Array.isArray(payload.games) || Number.isNaN(Date.parse(payload.syncedAt))) throw new TypeError('Invalid sync snapshot');
  const maximum = resource === 'library' ? 20_000 : 200;
  if (payload.games.length > maximum) throw new TypeError('Sync snapshot has too many games');
  const games = payload.games.map((game) => normalizeGame(resource, game));
  if (new Set(games.map((game) => game.appid)).size !== games.length) throw new TypeError('Sync snapshot contains duplicate games');
  return {
    resource,
    games,
    syncedAt: new Date(payload.syncedAt).toISOString(),
  };
}
