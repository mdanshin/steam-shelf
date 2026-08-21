import { createHash, randomBytes } from 'node:crypto';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function beginGoogleLogin(config) {
  const state = randomToken();
  const nonce = randomToken();
  const codeVerifier = randomToken(48);
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: `${config.origin}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,

    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return { state, nonce, codeVerifier, authorizationUrl: `${GOOGLE_AUTH}?${params}` };
}

function idTokenClaims(idToken) {
  if (typeof idToken !== 'string') throw new Error('Google token exchange omitted ID token');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Google returned an invalid ID token');
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object') throw new Error();
    return claims;
  } catch { throw new Error('Google returned an invalid ID token'); }
}

async function jsonResponse(response, context) {
  if (!response.ok) throw new Error(`${context} failed (${response.status})`);
  const maximumBytes = 1024 * 1024;
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new Error(`${context} response is too large`);
  const source = await response.text();
  if (Buffer.byteLength(source, 'utf8') > maximumBytes) throw new Error(`${context} response is too large`);
  let body;
  try { body = JSON.parse(source); } catch { throw new Error(`${context} returned invalid JSON`); }
  if (!body || typeof body !== 'object') throw new Error(`${context} returned invalid JSON`);
  return body;
}

export async function completeGoogleLogin({ config, code, codeVerifier, nonce, fetchImpl = fetch }) {
  if (!code || !codeVerifier || !nonce) throw new Error('Google callback is incomplete');
  const token = await jsonResponse(await fetchImpl(GOOGLE_TOKEN, {
    signal: AbortSignal.timeout(15_000),
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: `${config.origin}/auth/google/callback`,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }).toString(),
  }), 'Google token exchange');
  if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('Google token exchange omitted access token');
  const claims = idTokenClaims(token.id_token);
  if (claims.nonce !== nonce) throw new Error('Google ID token nonce mismatch');
  const profile = await jsonResponse(await fetchImpl(GOOGLE_USERINFO, {
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
  }), 'Google user info');
  if (!profile.sub || !profile.email || profile.email_verified !== true) throw new Error('A verified Google email is required');
  if (String(profile.sub) !== String(claims.sub || '')) throw new Error('Google identity subject mismatch');
  return {
    googleSub: String(profile.sub),
    email: String(profile.email),
    name: String(profile.name || profile.email),
    picture: typeof profile.picture === 'string' && profile.picture.startsWith('https://') ? profile.picture : null,
  };
}
