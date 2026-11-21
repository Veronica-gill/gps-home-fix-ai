import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { privateFile } from './storage.mjs';

const derive = promisify(scrypt);
const options = { N: 2 ** 17, r: 8, p: 1, maxmem: 160 * 1024 ** 2 };
const hashFormat = /^scrypt:([a-f0-9]{32}):([a-f0-9]{64})$/;
const idFormat = /^[a-f0-9]{64}$/;
const randomId = () => randomBytes(32).toString('hex');
const digest = value => createHash('sha256').update(value).digest('hex');
const idleMs = 90 * 60_000;
const lifetimeMs = 12 * 60 * 60_000;
const loginWindowMs = 15 * 60_000;
const loginAttempts = 8;

export const technician = 'technician';

export async function passwordHash(password) {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, 32, options);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function matches(input, expected) {
  return typeof input === 'string' && typeof expected === 'string'
    && timingSafeEqual(Buffer.from(digest(input), 'hex'), Buffer.from(digest(expected), 'hex'));
}

export function authStore(path, env, secure) {
  const accounts = new Map([
    ['owner', { role: 'owner', actor: 'Owner', credential: env.GPS_OWNER_PASSWORD_HASH }],
    [technician, { role: 'technician', actor: 'Technician', credential: env.GPS_TECH_PASSWORD_HASH }]
  ]);
  for (const account of accounts.values()) {
    const entry = hashFormat.exec(account.credential ?? '');
    if (!entry) throw new Error('Configure GPS_OWNER_PASSWORD_HASH and GPS_TECH_PASSWORD_HASH before starting.');
    account.salt = Buffer.from(entry[1], 'hex');
    account.hash = Buffer.from(entry[2], 'hex');
    account.tag = digest(account.credential);
  }
  if (accounts.get('owner').tag === accounts.get(technician).tag) {
    throw new Error('Configure independently generated credentials for each account.');
  }

  privateFile(path);
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA trusted_schema = OFF;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, credential_tag TEXT NOT NULL,
      csrf TEXT NOT NULL, expires_at INTEGER NOT NULL, idle_until INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_attempts (
      username TEXT PRIMARY KEY, started_at INTEGER NOT NULL, attempts INTEGER NOT NULL,
      busy_until INTEGER NOT NULL, attempt_token TEXT NOT NULL
    );
  `);
  const removeOldSessions = db.prepare('DELETE FROM sessions WHERE username = ? AND credential_tag <> ?');
  for (const [username, account] of accounts) removeOldSessions.run(username, account.tag);

  const cookieName = secure ? '__Host-gps_session' : 'gps_local_session';
  const cookie = (value, seconds) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
  const revoke = tokenHash => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  function session(header = '') {
    const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
    if (values.length !== 1) return null;
    const token = values[0].slice(cookieName.length + 1);
    if (!idFormat.test(token)) return null;
    const tokenHash = digest(token);
    const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash);
    if (!row) return null;
    const now = Date.now();
    const account = accounts.get(row.username);
    if (row.expires_at <= now || row.idle_until <= now || account?.tag !== row.credential_tag) {
      revoke(tokenHash);
      return null;
    }
    if (now + idleMs - row.idle_until > 60_000) {
      db.prepare('UPDATE sessions SET idle_until = ? WHERE token_hash = ? AND idle_until > ?')
        .run(now + idleMs, tokenHash, now);
    }
    return { username: row.username, role: account.role, actor: account.actor, csrf: row.csrf, tokenHash };
  }

  async function login(rawUsername, password, oldSession) {
    const username = typeof rawUsername === 'string' ? rawUsername.trim().toLowerCase() : '';
    const account = accounts.get(username);
    if (!account || typeof password !== 'string' || !password.length || Buffer.byteLength(password) > 256) return {};

    const now = Date.now();
    const windowStart = now - loginWindowMs;
    const attempt = randomId();
    const claimed = db.prepare(`
      INSERT INTO login_attempts (username, started_at, attempts, busy_until, attempt_token)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        started_at = CASE WHEN started_at <= ? THEN excluded.started_at ELSE started_at END,
        attempts = CASE WHEN started_at <= ? THEN 1 ELSE attempts + 1 END,
        busy_until = excluded.busy_until, attempt_token = excluded.attempt_token
      WHERE busy_until <= ? AND (started_at <= ? OR attempts < ?)
    `).run(username, now, now + 30_000, attempt, windowStart, windowStart, now, windowStart, loginAttempts);
    if (!claimed.changes) return { throttled: true };

    try {
      const hash = await derive(password, account.salt, 32, options);
      if (!timingSafeEqual(hash, account.hash)) return {};
      const token = randomId();
      const issued = Date.now();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR idle_until <= ?').run(issued, issued);
        if (oldSession) revoke(oldSession.tokenHash);
        db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(
          digest(token), username, account.tag, randomId(), issued + lifetimeMs, issued + idleMs
        );
        db.prepare('DELETE FROM login_attempts WHERE username = ? AND attempt_token = ?').run(username, attempt);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { role: account.role, cookie: cookie(token, lifetimeMs / 1000) };
    } finally {
      db.prepare('UPDATE login_attempts SET busy_until = 0 WHERE username = ? AND attempt_token = ?').run(username, attempt);
    }
  }

  return { session, login, revoke, clearCookie: cookie('', 0), close: () => db.close() };
}
