import test from 'node:test';
import assert from 'node:assert/strict';
import { filterByReviewCount, normalizeMinReviews } from '../public/review-filter.js';

test('review threshold is inclusive and hides unknown counts only when enabled', () => {
  const games = [
    { appid: 1, reviewCount: 499 },
    { appid: 2, reviewCount: 500 },
    { appid: 3, reviewCount: 250000 },
    { appid: 4, reviewCount: 0 },
    { appid: 5, reviewCount: null },
    { appid: 6 },
  ];
  assert.deepEqual(filterByReviewCount(games, 500).map((game) => game.appid), [2, 3]);
  assert.deepEqual(filterByReviewCount(games, 0), games);
  assert.deepEqual(filterByReviewCount(games, 250001), []);
  assert.equal(games.length, 6);
});

test('review preference accepts arbitrary whole counts and safely defaults invalid storage', () => {
  assert.equal(normalizeMinReviews('12345'), 12345);
  for (const value of [null, '', 'broken', '-1', '1.5', 'Infinity', '9007199254740992']) {
    assert.equal(normalizeMinReviews(value), 0);
  }
});
