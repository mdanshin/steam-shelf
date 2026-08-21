import test from 'node:test';
import assert from 'node:assert/strict';
import { beginGoogleLogin, completeGoogleLogin } from '../lib/google-oauth.js';

const config = {
  origin: 'http://127.0.0.1:4180',
  googleClientId: 'client.apps.googleusercontent.com',
  googleClientSecret: 'server-only-secret',
};
const jwt = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

test('Google login uses state, nonce and PKCE without exposing client secret', () => {
  const login = beginGoogleLogin(config);
  const url = new URL(login.authorizationUrl);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:4180/auth/google/callback');
  assert.equal(url.searchParams.get('state'), login.state);
  assert.equal(url.searchParams.get('nonce'), login.nonce);
  assert.ok(login.nonce.length >= 32);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(login.codeVerifier.length >= 43);
  assert.equal(url.search.includes(config.googleClientSecret), false);
});

test('Google callback exchanges the code server-side and accepts a verified identity', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/token')) return new Response(JSON.stringify({ access_token: 'access-token', id_token: jwt({ sub: 'google-123', nonce: 'expected-nonce' }) }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ sub: 'google-123', email: 'user@example.com', email_verified: true, name: 'User', picture: 'https://example.com/avatar.jpg' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const user = await completeGoogleLogin({ config, code: 'one-time-code', codeVerifier: 'verifier', nonce: 'expected-nonce', fetchImpl });
  assert.deepEqual(user, { googleSub: 'google-123', email: 'user@example.com', name: 'User', picture: 'https://example.com/avatar.jpg' });
  assert.match(requests[0].options.body, /client_secret=server-only-secret/);
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer access-token');
  assert.ok(requests.every((request) => request.options.signal instanceof AbortSignal));
});

test('Google callback rejects a mismatched OIDC nonce before accepting userinfo', async () => {
  let userinfoCalled = false;
  const fetchImpl = async (url) => {
    if (String(url).includes('/token')) return new Response(JSON.stringify({ access_token: 'access-token', id_token: jwt({ sub: 'google-123', nonce: 'other-nonce' }) }), { status: 200 });
    userinfoCalled = true;
    return new Response(JSON.stringify({ sub: 'google-123', email: 'user@example.com', email_verified: true }), { status: 200 });
  };
  await assert.rejects(() => completeGoogleLogin({ config, code: 'code', codeVerifier: 'verifier', nonce: 'expected-nonce', fetchImpl }), /nonce/);
  assert.equal(userinfoCalled, false);
});

test('Google callback rejects unverified email identities', async () => {
  const fetchImpl = async (url) => String(url).includes('/token')
    ? new Response(JSON.stringify({ access_token: 'access-token', id_token: jwt({ sub: 'google-123', nonce: 'nonce' }) }), { status: 200 })
    : new Response(JSON.stringify({ sub: 'google-123', email: 'user@example.com', email_verified: false }), { status: 200 });
  await assert.rejects(() => completeGoogleLogin({ config, code: 'code', codeVerifier: 'verifier', nonce: 'nonce', fetchImpl }), /verified Google email/);
});

test('Google callback rejects oversized identity responses', async () => {
  const fetchImpl = async () => new Response('{}', { status: 200, headers: { 'content-length': String(2 * 1024 * 1024) } });
  await assert.rejects(() => completeGoogleLogin({ config, code: 'code', codeVerifier: 'verifier', nonce: 'nonce', fetchImpl }), /too large/);
});
