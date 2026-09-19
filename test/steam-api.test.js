import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchOwnedGames, fetchWishlist } from '../lib/steam-api.js';

const steamId = '76561199999999999';
const apiKey = 'ABCDEF0123456789ABCDEF0123456789';

test('owned-games sync uses the Steam key only in a header and validates completeness', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ response: { game_count: 1, games: [{ appid: 10, name: 'Counter-Strike', playtime_forever: 120, playtime_2weeks: 30, rtime_last_played: 1000 }] } }), { status: 200 });
  };
  const result = await fetchOwnedGames({ steamId, apiKey, fetchImpl });
  assert.equal(calls[0].url.includes(apiKey), false);
  assert.equal(calls[0].options.headers['x-webapi-key'], apiKey);
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(result.games[0], { appid: 10, name: 'Counter-Strike', playtimeForever: 120, playtimeTwoWeeks: 30, lastPlayedAt: 1000, storeUrl: 'https://store.steampowered.com/app/10/' });
});

test('owned-games sync fails closed on a count mismatch', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ response: { game_count: 2, games: [{ appid: 10, name: 'One' }] } }), { status: 200 });
  await assert.rejects(() => fetchOwnedGames({ steamId, apiKey, fetchImpl }), /incomplete owned-games response/);
});

test('wishlist keeps delisted entries and normalizes regional prices', async () => {
  const fetchImpl = async (url) => {
    const text = String(url);
    if (text.includes('IWishlistService')) return new Response(JSON.stringify({ response: { items: [{ appid: 20, date_added: 123 }, { appid: 30, date_added: 456 }] } }), { status: 200 });
    if (text.includes('IStoreBrowseService')) return new Response(JSON.stringify({ response: { store_items: [{ appid: 20, reviews: { summary_filtered: { review_count: 300000, percent_positive: 94 } } }] } }), { status: 200 });
    if (text.includes('appids=20')) return new Response(JSON.stringify({ 20: { success: true, data: { name: 'Game', header_image: 'https://cdn.example/game.jpg', price_overview: { initial: 20000, final: 10000, discount_percent: 50 } } } }), { status: 200 });
    return new Response(JSON.stringify({ 30: { success: false } }), { status: 200 });
  };
  const result = await fetchWishlist({ steamId, country: 'ru', language: 'russian', fetchImpl, concurrency: 2 });
  assert.equal(result.games.length, 2);
  assert.deepEqual(result.games.find((game) => game.appid === 20), { appid: 20, name: 'Game', dateAdded: 123, priceMinor: 10000, originalPriceMinor: 20000, savingsMinor: 10000, discountPercent: 50, coverUrl: null, storeUrl: 'https://store.steampowered.com/app/20/', reviewCount: 300000, reviewPercent: 94, reviewScore: 0, reviewScoreDesc: '', weak: false });
  assert.equal(result.games.find((game) => game.appid === 30).priceMinor, null);
  assert.equal(result.games.find((game) => game.appid === 30).reviewCount, null);
});

test('SteamID and API key inputs are strictly validated before network access', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return new Response('{}'); };
  await assert.rejects(() => fetchOwnedGames({ steamId: 'not-an-id', apiKey, fetchImpl }), /SteamID64/);
  await assert.rejects(() => fetchOwnedGames({ steamId, apiKey: 'bad', fetchImpl }), /Steam Web API key/);
  assert.equal(called, false);
});

test('oversized Steam responses are rejected before JSON parsing', async () => {
  const fetchImpl = async () => new Response('{}', { status: 200, headers: { 'content-length': String(11 * 1024 * 1024) } });
  await assert.rejects(() => fetchOwnedGames({ steamId, apiKey, fetchImpl }), /too large/);
});

test('wishlist rejects excessive entries before starting per-app fanout', async () => {
  let calls = 0;
  const items = Array.from({ length: 5001 }, (_, index) => ({ appid: index + 1 }));
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ response: { items } }), { status: 200 });
  };
  await assert.rejects(() => fetchWishlist({ steamId, fetchImpl }), /too many entries/);
  assert.equal(calls, 1);
});
