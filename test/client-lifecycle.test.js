import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogLifecycle, currentDeals } from '../public/catalog-lifecycle.js';

test('disconnect clears personal catalogs and invalidates in-flight responses', () => {
  const lifecycle = createCatalogLifecycle();
  lifecycle.catalogs.set('library', { games: [{ appid: 1 }] });
  lifecycle.catalogs.set('wishlist', { games: [{ appid: 2 }] });
  lifecycle.catalogs.set('deals', { games: [{ appid: 3 }] });
  const requestRevision = lifecycle.revision();

  lifecycle.invalidatePersonal();

  assert.equal(lifecycle.catalogs.has('library'), false);
  assert.equal(lifecycle.catalogs.has('wishlist'), false);
  assert.equal(lifecycle.catalogs.has('deals'), true);
  assert.equal(lifecycle.canStore('library', requestRevision), false);
  assert.equal(lifecycle.canStore('wishlist', requestRevision), false);
  assert.equal(lifecycle.canStore('deals', requestRevision), true);
  assert.equal(lifecycle.canRender('library', 'wishlist'), false);
  assert.equal(lifecycle.canRender('library', 'library'), true);
});

test('local catalog excludes deals after their source end time', () => {
  const ended = { appid: 1159420, discountEndAt: 1_787_850_000 };
  const active = { appid: 20, discountEndAt: 1_788_195_600 };

  assert.deepEqual(currentDeals([ended, active], 1_787_890_000), [active]);
});
