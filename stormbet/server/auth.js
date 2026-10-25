import crypto from 'node:crypto';
import { tx } from './db.js';
import { ECONOMY, EconomyError, move } from './economy.js';

const SESSION_DAYS = 30;
export const COOKIE = 'stormbet_session';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = stored.split('$');
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

export function register(db, username, password) {
  username = String(username || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,20}$/.test(username))
    throw new EconomyError('bad_username', 'Pseudo : 3 à 20 caractères (lettres, chiffres, _ . -)');
  if (String(password || '').length < 8) throw new EconomyError('bad_password', 'Mot de passe : 8 caractères minimum');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username))
    throw new EconomyError('taken', 'Ce pseudo est déjà pris');
  const admins = (process.env.ADMIN_USERNAMES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const role = admins.includes(username.toLowerCase()) ? 'admin' : 'user';
  return tx(db, () => {
    const user = db
      .prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?) RETURNING id')
      .get(username, hashPassword(password), role);
    move(db, user.id, ECONOMY.signupBonus, 'signup_bonus');
    return user.id;
  });
}

export function login(db, username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
  if (!user || !verifyPassword(String(password || ''), user.password_hash))
    throw new EconomyError('bad_credentials', 'Pseudo ou mot de passe incorrect');
  return user.id;
}

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires);
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function userFromToken(db, token) {
  if (!token) return null;
  return (
    db
      .prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                WHERE s.token_hash = ? AND s.expires_at > ?`)
      .get(sha256(token), new Date().toISOString()) || null
  );
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}
