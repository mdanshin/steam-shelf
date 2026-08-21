import { resolve } from 'node:path';

export function loadConfig(env = process.env) {
  const configuredOrigin = String(env.APP_ORIGIN || 'http://127.0.0.1:4180');
  const url = new URL(configuredOrigin);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('APP_ORIGIN must be a pure origin');
  const origin = url.origin;
  if (configuredOrigin !== origin && configuredOrigin !== `${origin}/`) throw new Error('APP_ORIGIN must be a pure origin');
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('APP_ORIGIN must use HTTPS outside loopback');
  const key = Buffer.from(String(env.STEAM_KEY_ENCRYPTION_SECRET || ''), 'base64url');
  if (key.length !== 32) throw new Error('STEAM_KEY_ENCRYPTION_SECRET must be a base64url-encoded 32-byte key');
  const googleClientId = String(env.GOOGLE_CLIENT_ID || '');
  const googleClientSecret = String(env.GOOGLE_CLIENT_SECRET || '');
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together');
  return {
    origin,
    host: String(env.HOST || '127.0.0.1'),
    port: Number(env.PORT || url.port || 4180),
    googleClientId,
    googleClientSecret,
    googleConfigured: Boolean(googleClientId && googleClientSecret),
    masterKey: key,
    databasePath: resolve(String(env.DATABASE_PATH || './data/steam.sqlite')),
    cookieSecure: url.protocol === 'https:',
  };
}
