// SQLite storage (node:sqlite, no native dependency).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  logo_url TEXT,
  source TEXT
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  handle TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  country TEXT,
  region TEXT,
  team_id INTEGER REFERENCES teams(id),
  avatar_url TEXT,
  avatar_credit TEXT,
  twitch TEXT,
  earnings_usd REAL,
  pr_points REAL,
  rating REAL NOT NULL DEFAULT 1250,
  rating_confidence REAL NOT NULL DEFAULT 0,
  form TEXT NOT NULL DEFAULT '[]',
  sources TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  series TEXT,
  tier TEXT NOT NULL DEFAULT 'major',
  mode TEXT NOT NULL DEFAULT 'solo',
  region TEXT,
  location TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT,
  prize_pool_usd REAL,
  field_size INTEGER,
  status TEXT NOT NULL DEFAULT 'upcoming',
  field_status TEXT NOT NULL DEFAULT 'confirmed',
  source_url TEXT,
  notes TEXT,
  sources TEXT NOT NULL DEFAULT '[]'
);

-- An entry is a solo player, a duo or a trio taking part in a tournament.
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  team_id INTEGER REFERENCES teams(id),
  placement INTEGER,
  points REAL,
  prize_usd REAL,
  UNIQUE (tournament_id, name)
);

CREATE TABLE IF NOT EXISTS entry_players (
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id),
  PRIMARY KEY (entry_id, player_id)
);

CREATE TABLE IF NOT EXISTS markets (
  id INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- winner | top3 | top10 | h2h
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | suspended | settled | void
  closes_at TEXT NOT NULL,
  margin REAL NOT NULL,
  UNIQUE (tournament_id, kind, label)
);

CREATE TABLE IF NOT EXISTS selections (
  id INTEGER PRIMARY KEY,
  market_id INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  probability REAL NOT NULL,
  odds REAL NOT NULL,
  result TEXT,                   -- won | lost | void
  UNIQUE (market_id, entry_id)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE COLLATE NOCASE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  balance INTEGER NOT NULL DEFAULT 0,
  xp INTEGER NOT NULL DEFAULT 0,
  daily_streak INTEGER NOT NULL DEFAULT 0,
  last_daily_at TEXT,
  last_rescue_at TEXT,
  equipped TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- Append-only ledger: every FLUX movement is a row; users.balance is its running total.
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT,
  balance_after INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  stake INTEGER NOT NULL,
  total_odds REAL NOT NULL,
  potential_payout INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | won | lost | void
  payout INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at TEXT
);

CREATE TABLE IF NOT EXISTS bet_legs (
  bet_id INTEGER NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
  selection_id INTEGER NOT NULL REFERENCES selections(id),
  odds REAL NOT NULL,
  result TEXT,
  PRIMARY KEY (bet_id, selection_id)
);

CREATE TABLE IF NOT EXISTS shop_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,     -- frame | banner | title
  rarity TEXT NOT NULL,
  price INTEGER NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS inventory (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES shop_items(id),
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS mission_claims (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mission_id TEXT NOT NULL,
  period TEXT NOT NULL,
  PRIMARY KEY (user_id, mission_id, period)
);

-- Stream partnerships: only players who signed an agreement get a player on the site.
CREATE TABLE IF NOT EXISTS stream_partners (
  id INTEGER PRIMARY KEY,
  player_id INTEGER UNIQUE NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,        -- twitch | youtube | kick | rtmp
  channel TEXT,
  consent_status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | revoked
  consent_signed_at TEXT,
  consent_reference TEXT,
  ingest_key_hash TEXT,          -- rtmp only: sha256 of the key WE issued to the player
  ingest_key_hint TEXT,
  is_live INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function openDb(file = process.env.STORMBET_DB || path.resolve('data/stormbet.sqlite')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function slugify(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export const json = {
  parse(s, fallback) {
    try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; }
  },
};
