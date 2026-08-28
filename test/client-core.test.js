import test from 'node:test';
import assert from 'node:assert/strict';

import {
  credentialScope,
  currentDeals,
  normalizeSyncSnapshot,
  validApiKey,
  validSteamId,
} from '../client/core.js';

test('credential validation accepts only SteamID64 and 32 hex key', () => {
  assert.equal(validSteamId('76561199999999999'), true);
  assert.equal(validSteamId('7656119999999999'), false);
  assert.equal(validApiKey('A'.repeat(32)), true);
  assert.equal(validApiKey('not-a-key'), false);
});

test('credential scope is stable and isolated by Firebase uid', () => {
  assert.equal(credentialScope('user-a'), 'steam-shelf:user:user-a');
  assert.notEqual(credentialScope('user-a'), credentialScope('user-b'));
  assert.throws(() => credentialScope(''), /user/i);
  assert.throws(() => credentialScope('../other'), /user/i);
});

test('sync snapshots reject malformed or cross-resource data', () => {
  assert.deepEqual(normalizeSyncSnapshot('library', {
    resource: 'library',
    games: [{ appid: 10, name: 'Counter-Strike', playtimeForever: 60, lastPlayedAt: 0 }],
    syncedAt: '2026-08-22T00:00:00.000Z',
  }).games[0], { appid: 10, name: 'Counter-Strike', playtimeForever: 60, lastPlayedAt: 0 });
  assert.throws(() => normalizeSyncSnapshot('library', { resource: 'wishlist', games: [], syncedAt: new Date().toISOString() }), /resource/i);
  assert.throws(() => normalizeSyncSnapshot('library', { resource: 'library', games: [{ appid: 0 }], syncedAt: new Date().toISOString() }), /record/i);
});

test('sync snapshots enforce catalog, name, duplicate and numeric bounds', () => {
  const at = '2026-08-22T00:00:00.000Z';
  assert.throws(() => normalizeSyncSnapshot('wishlist', { resource: 'wishlist', games: Array.from({ length: 201 }, (_, index) => ({ appid: index + 1, name: 'Game', dateAdded: 0, priceMinor: null, originalPriceMinor: null, savingsMinor: null, discountPercent: 0 })), syncedAt: at }), /too many/i);
  assert.throws(() => normalizeSyncSnapshot('library', { resource: 'library', games: [{ appid: 10, name: 'Game', playtimeForever: 0, lastPlayedAt: 0 }, { appid: 10, name: 'Game', playtimeForever: 0, lastPlayedAt: 0 }], syncedAt: at }), /duplicate/i);
  assert.throws(() => normalizeSyncSnapshot('library', { resource: 'library', games: [{ appid: 10, name: 'x'.repeat(301), playtimeForever: 0, lastPlayedAt: 0 }], syncedAt: at }), /name/i);
  assert.throws(() => normalizeSyncSnapshot('wishlist', { resource: 'wishlist', games: [{ appid: 10, name: 'Game', dateAdded: 0, priceMinor: -1, originalPriceMinor: 10, savingsMinor: 11, discountPercent: 101 }], syncedAt: at }), /record/i);
});

test('expired Steam deals are not shown after their source end time', () => {
  const ended = { appid: 1159420, name: 'Robin Hood - Sherwood Builders', discountEndAt: 1_787_850_000 };
  const active = { appid: 20, name: 'Still discounted', discountEndAt: 1_788_195_600 };
  const unknown = { appid: 30, name: 'Unknown end', discountEndAt: null };

  assert.deepEqual(currentDeals([ended, active, unknown], 1_787_890_000), [active, unknown]);
});
