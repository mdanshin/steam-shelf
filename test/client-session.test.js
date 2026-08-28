import test from 'node:test';
import assert from 'node:assert/strict';

import { beginSessionTransition, captureSession, isCurrentSession, transitionForCredentialReplacement, transitionForDisconnect } from '../client/session.js';

test('account transition aborts old work and prevents cross-account vault writes', () => {
  const vaultA = { name: 'a' };
  const vaultB = { name: 'b' };
  const state = { epoch: 0, controller: null, user: null, vault: null, credentials: null };

  beginSessionTransition(state);
  state.user = { uid: 'user-a' };
  state.vault = vaultA;
  state.credentials = { steamId: '76561199999999999', apiKey: 'a'.repeat(32) };
  const delayedA = captureSession(state);
  assert.equal(isCurrentSession(state, delayedA), true);

  beginSessionTransition(state);
  state.user = { uid: 'user-b' };
  state.vault = vaultB;
  state.credentials = null;
  assert.equal(delayedA.signal.aborted, true);
  assert.equal(isCurrentSession(state, delayedA), false);
  assert.equal(delayedA.vault, vaultA);
  assert.notEqual(delayedA.vault, state.vault);
});

test('an overlapping older auth load cannot become current after a newer transition', () => {
  const state = { epoch: 0, controller: null, user: null, vault: null, credentials: null };
  const olderEpoch = beginSessionTransition(state);
  const newerEpoch = beginSessionTransition(state);
  assert.notEqual(olderEpoch, newerEpoch);
  assert.equal(olderEpoch === state.epoch, false);
  assert.equal(newerEpoch === state.epoch, true);
});

test('disconnect invalidates old work and creates a new empty session for the same UID', () => {
  const vault = {};
  const state = { epoch: 0, controller: null, user: { uid: 'user-a' }, vault, credentials: { steamId: '76561199999999999' } };
  beginSessionTransition(state);
  const beforeDisconnect = captureSession(state);
  const afterDisconnect = transitionForDisconnect(state);
  assert.equal(beforeDisconnect.signal.aborted, true);
  assert.equal(isCurrentSession(state, beforeDisconnect), false);
  assert.equal(isCurrentSession(state, afterDisconnect), true);
});

test('credential replacement invalidates sync work for the previous Steam account', () => {
  const vault = {};
  const state = { epoch: 0, controller: null, user: { uid: 'user-a' }, vault, credentials: { steamId: '76561199999999999' } };
  beginSessionTransition(state);
  const accountA = captureSession(state);
  const replacement = transitionForCredentialReplacement(state);
  assert.equal(accountA.signal.aborted, true);
  assert.equal(replacement.credentials, null);
  assert.equal(state.credentials, null);
  assert.equal(isCurrentSession(state, accountA), false);
  assert.equal(isCurrentSession(state, replacement), true);
});
