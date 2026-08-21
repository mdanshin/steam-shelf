import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { decryptSecret, encryptSecret, maskSecret } from './secrets.js';

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const nowIso = () => new Date().toISOString();

export function createStore({ path, masterKey }) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      google_sub TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      picture TEXT,
      credential_revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS steam_settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      steam_id TEXT NOT NULL,
      encrypted_api_key TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_attempts (
      state_hash TEXT PRIMARY KEY,
      verifier TEXT NOT NULL,
      nonce TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('library','wishlist')),
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, kind)
    );
  `);

  if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name='credential_revision'").get()) {
    db.exec('ALTER TABLE users ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0');
  }

  const statements = {
    userBySub: db.prepare('SELECT * FROM users WHERE google_sub = ?'),
    insertUser: db.prepare('INSERT INTO users (google_sub,email,name,picture,created_at,updated_at) VALUES (?,?,?,?,?,?)'),
    updateUser: db.prepare('UPDATE users SET email=?, name=?, picture=?, updated_at=? WHERE google_sub=?'),
    settings: db.prepare('SELECT steam_id, encrypted_api_key FROM steam_settings WHERE user_id=?'),
    credentials: db.prepare(`SELECT steam_settings.steam_id, steam_settings.encrypted_api_key, users.credential_revision
      FROM steam_settings JOIN users ON users.id=steam_settings.user_id WHERE steam_settings.user_id=?`),
    incrementRevision: db.prepare('UPDATE users SET credential_revision=credential_revision+1 WHERE id=?'),

    saveSettings: db.prepare(`INSERT INTO steam_settings (user_id,steam_id,encrypted_api_key,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET steam_id=excluded.steam_id, encrypted_api_key=excluded.encrypted_api_key, updated_at=excluded.updated_at`),
    deleteSettings: db.prepare('DELETE FROM steam_settings WHERE user_id=?'),
    deleteSnapshots: db.prepare('DELETE FROM snapshots WHERE user_id=?'),
    saveOAuth: db.prepare('INSERT OR REPLACE INTO oauth_attempts (state_hash,verifier,nonce,expires_at) VALUES (?,?,?,?)'),
    oauth: db.prepare('SELECT verifier, nonce, expires_at FROM oauth_attempts WHERE state_hash=?'),
    deleteOAuth: db.prepare('DELETE FROM oauth_attempts WHERE state_hash=?'),
    saveSession: db.prepare('INSERT OR REPLACE INTO sessions (token_hash,user_id,csrf_token,expires_at) VALUES (?,?,?,?)'),
    session: db.prepare(`SELECT users.id, users.email, users.name, users.picture, sessions.csrf_token, sessions.expires_at
      FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=?`),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash=?'),
    purgeOAuth: db.prepare('DELETE FROM oauth_attempts WHERE expires_at < ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    saveSnapshot: db.prepare(`INSERT INTO snapshots (user_id,kind,payload,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id,kind) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`),
    snapshot: db.prepare('SELECT payload FROM snapshots WHERE user_id=? AND kind=?'),
    saveSnapshotIfCurrent: db.prepare(`INSERT INTO snapshots (user_id,kind,payload,updated_at)
      SELECT ?,?,?,? WHERE EXISTS (
        SELECT 1 FROM users JOIN steam_settings ON steam_settings.user_id=users.id
        WHERE users.id=? AND users.credential_revision=?
      ) ON CONFLICT(user_id,kind) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`),
  };

  const purgeExpired = () => {
    const timestamp = Date.now();
    return { oauthAttempts: Number(statements.purgeOAuth.run(timestamp).changes), sessions: Number(statements.purgeSessions.run(timestamp).changes) };
  };
  purgeExpired();

  return {
    upsertUser(profile) {
      const timestamp = nowIso();
      const existing = statements.userBySub.get(profile.googleSub);
      if (existing) statements.updateUser.run(profile.email, profile.name, profile.picture, timestamp, profile.googleSub);
      else statements.insertUser.run(profile.googleSub, profile.email, profile.name, profile.picture, timestamp, timestamp);
      const user = statements.userBySub.get(profile.googleSub);
      return { id: user.id, email: user.email, name: user.name, picture: user.picture };
    },
    saveSteamSettings(userId, { steamId, apiKey }) {
      db.exec('BEGIN IMMEDIATE');
      try {
        statements.incrementRevision.run(userId);
        statements.saveSettings.run(userId, steamId, encryptSecret(apiKey, masterKey, `steam-api-key:user:${userId}`), nowIso());
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    connectSteam(userId, { steamId, apiKey }, librarySnapshot) {
      const encrypted = encryptSecret(apiKey, masterKey, `steam-api-key:user:${userId}`);
      db.exec('BEGIN IMMEDIATE');
      try {
        statements.incrementRevision.run(userId);
        statements.saveSettings.run(userId, steamId, encrypted, nowIso());
        statements.saveSnapshot.run(userId, 'library', JSON.stringify(librarySnapshot), nowIso());
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    deleteSteamConnection(userId) {
      db.exec('BEGIN IMMEDIATE');
      try {
        statements.incrementRevision.run(userId);
        statements.deleteSnapshots.run(userId);
        statements.deleteSettings.run(userId);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    getPublicSettings(userId) {
      const value = statements.settings.get(userId);
      if (!value) return { steamId: '', hasApiKey: false, apiKeyMask: 'Не задан' };
      const apiKey = decryptSecret(value.encrypted_api_key, masterKey, `steam-api-key:user:${userId}`);
      return { steamId: value.steam_id, hasApiKey: true, apiKeyMask: maskSecret(apiKey) };
    },
    getSteamCredentials(userId) {
      const value = statements.credentials.get(userId);
      return value ? { steamId: value.steam_id, apiKey: decryptSecret(value.encrypted_api_key, masterKey, `steam-api-key:user:${userId}`), revision: value.credential_revision } : null;
    },
    saveOAuthAttempt({ state, verifier, nonce, expiresAt }) {
      purgeExpired();
      statements.saveOAuth.run(hash(state), verifier, nonce || '', expiresAt);
    },
    consumeOAuthAttempt(state) {
      const key = hash(state);
      const value = statements.oauth.get(key);
      statements.deleteOAuth.run(key);
      return value && value.expires_at >= Date.now() ? { verifier: value.verifier, nonce: value.nonce } : null;
    },
    createSession({ token, csrfToken, userId, expiresAt }) { purgeExpired(); statements.saveSession.run(hash(token), userId, csrfToken, expiresAt); },
    getSessionUser(token) {
      if (!token) return null;
      const value = statements.session.get(hash(token));
      if (!value || value.expires_at < Date.now()) return null;
      return { id: value.id, email: value.email, name: value.name, picture: value.picture, csrfToken: value.csrf_token };
    },
    deleteSession(token) { if (token) statements.deleteSession.run(hash(token)); },
    purgeExpired,
    saveSnapshot(userId, kind, payload) { statements.saveSnapshot.run(userId, kind, JSON.stringify(payload), nowIso()); },
    saveSnapshotIfCurrent(userId, kind, payload, revision) {
      return Number(statements.saveSnapshotIfCurrent.run(userId, kind, JSON.stringify(payload), nowIso(), userId, revision).changes) === 1;
    },
    getSnapshot(userId, kind) {
      const value = statements.snapshot.get(userId, kind);
      if (!value) return null;
      try { return JSON.parse(value.payload); } catch { return null; }
    },
    close() { db.close(); },
  };
}
