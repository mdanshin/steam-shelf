import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { randomUUID } from 'node:crypto';

import { CallableError, handleSyncCall } from './handler.js';
import { syncSteamRequest } from './steam-sync.js';

initializeApp();
const firestore = getFirestore();
const LIMITS = {
  library: { windowMs: 5 * 60 * 1000, windowMax: 6, dailyMax: 30 },
  wishlist: { windowMs: 15 * 60 * 1000, windowMax: 2, dailyMax: 8 },
};
const LEASE_MS = 6 * 60 * 1000;

async function checkRateLimit(uid, resource) {
  const limit = LIMITS[resource];
  if (!limit) throw new CallableError('invalid-argument', 'Неизвестный тип синхронизации.');
  const reference = firestore.collection('_steamShelfRateLimits').doc(uid);
  const leaseToken = randomUUID();
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const now = Date.now();
    const value = snapshot.data()?.[resource] || {};
    if ((Number(value.leaseUntil) || 0) > now) throw new CallableError('resource-exhausted', 'Синхронизация этого раздела уже выполняется.');
    const inWindow = now - (Number(value.windowStartedAt) || 0) < limit.windowMs;
    const windowCount = inWindow ? Number(value.windowCount) || 0 : 0;
    const day = new Date(now).toISOString().slice(0, 10);
    const dayCount = value.day === day ? Number(value.dayCount) || 0 : 0;
    if (windowCount >= limit.windowMax || dayCount >= limit.dailyMax) throw new CallableError('resource-exhausted', 'Лимит синхронизаций исчерпан. Попробуйте позже.');
    transaction.set(reference, {
      [resource]: {
        windowStartedAt: inWindow ? value.windowStartedAt : now,
        windowCount: windowCount + 1,
        day,
        dayCount: dayCount + 1,
        leaseUntil: now + LEASE_MS,
        leaseToken,
      },
      updatedAt: now,
      expiresAt: new Date(now + 48 * 60 * 60 * 1000),
    }, { merge: true });
  });
  return async () => firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (snapshot.data()?.[resource]?.leaseToken === leaseToken) {
      transaction.update(reference, { [`${resource}.leaseUntil`]: 0, [`${resource}.leaseToken`]: null, updatedAt: Date.now() });
    }
  });
}

export const syncSteam = onCall({
  region: 'europe-west1',
  cors: ['https://danshin.ms', 'https://mdanshin.github.io', 'http://localhost:8080', 'http://127.0.0.1:8080'],
  timeoutSeconds: 300,
  memory: '512MiB',
  maxInstances: 5,
  concurrency: 20,
  enforceAppCheck: true,
  consumeAppCheckToken: true,
}, async (request) => {
  try {
    return await handleSyncCall(request, { checkRateLimit, sync: syncSteamRequest });
  } catch (error) {
    if (error instanceof CallableError) throw new HttpsError(error.code, error.message);
    throw new HttpsError('internal', 'Операция не выполнена.');
  }
});
