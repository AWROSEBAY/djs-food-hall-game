// SQLite storage using Node's built-in driver. One file, one process.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  phone TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  terms_accepted_at TEXT NOT NULL,
  sms_opt_in INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS boards (
  phone TEXT NOT NULL REFERENCES players(phone),
  season_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  shields INTEGER NOT NULL DEFAULT 0,
  finished_at TEXT,
  PRIMARY KEY (phone, season_id)
);

-- Every Square payment matched to a player. Rolls are granted per payment.
CREATE TABLE IF NOT EXISTS payments (
  payment_id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  season_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  paid_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  off_peak INTEGER NOT NULL,
  rolls_granted INTEGER NOT NULL,
  rolls_used INTEGER NOT NULL DEFAULT 0,
  rolls_revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS payments_phone_day ON payments (phone, local_date);

CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  season_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  die INTEGER NOT NULL,
  from_square INTEGER NOT NULL,
  landed INTEGER NOT NULL,
  to_square INTEGER NOT NULL,
  event TEXT,
  award_id INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS awards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  season_id TEXT NOT NULL,
  prize_id TEXT NOT NULL,
  prize_name TEXT NOT NULL,
  cost_cents INTEGER NOT NULL,
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  redeemed_at TEXT,
  redeemed_by TEXT
);

CREATE TABLE IF NOT EXISTS otps (
  phone TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Webhook event ids already processed, so Square retries are harmless.
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);
`;

export function openDb(path = process.env.DB_PATH || './data/game.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
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
