import test from 'node:test';
import assert from 'node:assert/strict';

import { enrichWishlistReviews, syncSteamRequest } from '../functions/steam-sync.js';

const STEAM_ID = '76561199999999999';
const API_KEY = 'A'.repeat(32);

function response(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('library sync validates before network and keeps API key out of URL', async () => {
  let request;
  const result = await syncSteamRequest({ resource: 'library', steamId: STEAM_ID, apiKey: API_KEY }, {
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return response({ response: { game_count: 1, games: [{ appid: 10, name: 'Counter-Strike', playtime_forever: 120, rtime_last_played: 0 }] } });
    },
  });
  assert.equal(request.url.includes(API_KEY), false);
  assert.equal(request.options.headers['x-webapi-key'], API_KEY);
  assert.equal(result.resource, 'library');
  assert.equal(result.games[0].playtimeForever, 120);
});

test('wishlist sync needs no API key and does not send one to Store API', async () => {
  const requests = [];
  const result = await syncSteamRequest({ resource: 'wishlist', steamId: STEAM_ID }, {
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).includes('IWishlistService')) return response({ response: { items: [{ appid: 10, date_added: 123 }] } });
      if (String(url).includes('IStoreBrowseService')) return response({ response: { store_items: [{ appid: 10, reviews: { summary_filtered: { review_count: 250000, percent_positive: 97, review_score: 9, review_score_label: 'Крайне положительные' }, summary_language_specific: { review_count: 1000, percent_positive: 90 } } }] } });
      return response({ '10': { success: true, data: { name: 'Counter-Strike', price_overview: { final: 10000, initial: 20000, discount_percent: 50 } } } });
    },
  });
  assert.equal(result.games[0].savingsMinor, 10000);
  assert.equal(result.games[0].reviewCount, 250000);
  assert.equal(result.games[0].reviewPercent, 97);
  assert.equal(result.games[0].reviewScoreDesc, 'Крайне положительные');
  assert.equal(result.games[0].weak, false);
  for (const request of requests.slice(1)) {
    assert.equal(request.options.headers?.['x-webapi-key'], undefined);
    assert.equal(request.url.includes(STEAM_ID), false);
  }
});

test('wishlist reviews are fetched in bounded batches and matched by app id', async () => {
  const games = Array.from({ length: 101 }, (_, index) => ({ appid: index + 1, name: `Game ${index + 1}` }));
  const sizes = [];
  let budgetCalls = 0;
  const result = await enrichWishlistReviews(games, {
    beforeFetch: async () => { budgetCalls += 1; },
    fetchImpl: async (url, options) => {
      const input = JSON.parse(new URL(url).searchParams.get('input_json'));
      sizes.push(input.ids.length);
      assert.equal(input.data_request.include_reviews, true);
      assert.equal(options.redirect, 'error');
      return response({ response: { store_items: input.ids.toReversed().map(({ appid }) => ({ appid, reviews: { summary_filtered: { review_count: appid * 1000, percent_positive: 95 } } })) } });
    },
  });
  assert.deepEqual(sizes, [50, 50, 1]);
  assert.equal(budgetCalls, 3);
  assert.deepEqual(result.map((game) => game.appid), games.map((game) => game.appid));
  assert.equal(result[100].reviewCount, 101000);
});

test('unavailable and missing review data remains unknown while confirmed zero stays zero', async () => {
  const games = [{ appid: 10, name: 'Game', priceMinor: 10000 }, { appid: 20 }, { appid: 30 }];
  const unavailable = await enrichWishlistReviews(games, { fetchImpl: async () => response({}, 503) });
  assert.equal(unavailable[0].priceMinor, 10000);
  assert.equal(unavailable[0].reviewCount, null);
  assert.equal(unavailable[0].weak, false);

  const result = await enrichWishlistReviews(games, { fetchImpl: async () => response({ response: { store_items: [
    null,
    { appid: 10, reviews: { summary_filtered: { review_count: 0, percent_positive: 0 } } },
    { appid: 20, reviews: { summary_filtered: { review_count: -1, percent_positive: 101 } } },
  ] } }) });
  assert.deepEqual(result.map((game) => game.reviewCount), [0, null, null]);
  assert.deepEqual(result.map((game) => game.reviewPercent), [null, null, null]);
});

test('review enrichment propagates cancellation and upstream budget errors', async () => {
  const controller = new AbortController();
  await assert.rejects(() => enrichWishlistReviews([{ appid: 10 }], {
    signal: controller.signal,
    fetchImpl: async () => { controller.abort(new Error('client disconnected')); throw controller.signal.reason; },
  }), /client disconnected/);
  let calls = 0;
  await assert.rejects(() => enrichWishlistReviews([{ appid: 10 }], {
    beforeFetch: async () => { throw new Error('upstream budget exhausted'); },
    fetchImpl: async () => { calls += 1; },
  }), /upstream budget exhausted/);
  assert.equal(calls, 0);
});

test('invalid client input performs no network calls', async () => {
  let calls = 0;
  await assert.rejects(() => syncSteamRequest({ resource: 'library', steamId: 'bad', apiKey: API_KEY }, { fetchImpl: async () => { calls += 1; } }), /SteamID64/);
  await assert.rejects(() => syncSteamRequest({ resource: 'other', steamId: STEAM_ID, apiKey: API_KEY }, { fetchImpl: async () => { calls += 1; } }), /resource/);
  assert.equal(calls, 0);
});

test('unknown request fields are rejected before network access', async () => {
  let calls = 0;
  await assert.rejects(() => syncSteamRequest({ resource: 'library', steamId: STEAM_ID, apiKey: API_KEY, url: 'https://example.com' }, {
    fetchImpl: async () => { calls += 1; },
  }), /field/i);
  assert.equal(calls, 0);
});

test('wishlist limits fanout and rejects duplicate app ids', async () => {
  let calls = 0;
  await assert.rejects(() => syncSteamRequest({ resource: 'wishlist', steamId: STEAM_ID }, {
    fetchImpl: async () => {
      calls += 1;
      return response({ response: { items: Array.from({ length: 501 }, (_, index) => ({ appid: index + 1 })) } });
    },
  }), /too many/i);
  assert.equal(calls, 1);

  await assert.rejects(() => syncSteamRequest({ resource: 'wishlist', steamId: STEAM_ID }, {
    fetchImpl: async () => response({ response: { items: [{ appid: 10 }, { appid: 10 }] } }),
  }), /duplicate/i);
});

test('incomplete Steam library response fails closed', async () => {
  await assert.rejects(() => syncSteamRequest({ resource: 'library', steamId: STEAM_ID, apiKey: API_KEY }, {
    fetchImpl: async () => response({ response: { game_count: 2, games: [{ appid: 10, name: 'Only one' }] } }),
  }), /incomplete/i);
});

test('Steam sync rejects bounded-but-dangerous catalog shapes', async () => {
  await assert.rejects(() => syncSteamRequest({ resource: 'library', steamId: STEAM_ID, apiKey: API_KEY }, {
    fetchImpl: async () => response({ response: { game_count: 20_001, games: Array.from({ length: 20_001 }, (_, index) => ({ appid: index + 1, name: 'Game' })) } }),
  }), /too many/i);

  await assert.rejects(() => syncSteamRequest({ resource: 'wishlist', steamId: STEAM_ID }, {
    fetchImpl: async () => response({ response: { items: Array.from({ length: 201 }, (_, index) => ({ appid: index + 1 })) } }),
  }), /too many/i);

  await assert.rejects(() => syncSteamRequest({ resource: 'library', steamId: STEAM_ID, apiKey: API_KEY }, {
    fetchImpl: async () => response({ response: { game_count: 1, games: [{ appid: 10, name: 'x'.repeat(301) }] } }),
  }), /invalid/i);
});

test('chunked oversized Steam responses are rejected while streaming', async () => {
  const body = new ReadableStream({
    start(controller) {
      const chunk = new Uint8Array(1024 * 1024);
      for (let index = 0; index < 6; index += 1) controller.enqueue(chunk);
      controller.close();
    },
  });
  await assert.rejects(() => syncSteamRequest({ resource: 'library', steamId: STEAM_ID, apiKey: API_KEY }, {
    fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
  }), /too large/i);
});

test('wishlist cancellation stops workers before they launch additional detail requests', async () => {
  const controller = new AbortController();
  let fetchCalls = 0;
  let budgetCalls = 0;
  const fetchImpl = async (url) => {
    fetchCalls += 1;
    if (String(url).includes('IWishlistService')) return response({ response: { items: Array.from({ length: 20 }, (_, index) => ({ appid: index + 1, date_added: 1 })) } });
    const appid = Number(new URL(url).searchParams.get('appids'));
    return response({ [appid]: { success: true, data: { name: `Game ${appid}`, is_free: true } } });
  };
  await assert.rejects(() => syncSteamRequest({ resource: 'wishlist', steamId: STEAM_ID }, {
    fetchImpl,
    signal: controller.signal,
    beforeFetch: async () => {
      budgetCalls += 1;
      if (budgetCalls === 4) controller.abort(new Error('client disconnected'));
    },
  }), /client disconnected/i);
  assert.ok(fetchCalls >= 1 && fetchCalls <= 3);
});
