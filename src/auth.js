// Phone sign-in with a one-time SMS code, and cookie sessions.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const hash = (s) => createHash('sha256').update(s).digest('hex');
const OTP_TTL_MS = 10 * 60 * 1000;
const SEND_WINDOW_MS = 60 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 5;
const MAX_ATTEMPTS = 5;
const SESSION_DAYS = 90;

// Returns the code to send, or { error } when rate limited.
export function issueOtp(db, phone, nowMs = Date.now()) {
  const row = db.prepare('SELECT * FROM otps WHERE phone = ?').get(phone);
  let sent = 0;
  let windowStart = nowMs;
  if (row && nowMs - row.window_start < SEND_WINDOW_MS) {
    sent = row.sent_count;
    windowStart = row.window_start;
  }
  if (sent >= MAX_SENDS_PER_WINDOW) return { error: 'too_many_codes' };
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare(`INSERT INTO otps (phone, code_hash, expires_at, attempts, sent_count, window_start)
    VALUES (?, ?, ?, 0, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
      attempts = 0, sent_count = excluded.sent_count, window_start = excluded.window_start`)
    .run(phone, hash(phone + code), nowMs + OTP_TTL_MS, sent + 1, windowStart);
  return { code };
}

export function checkOtp(db, phone, code, nowMs = Date.now()) {
  const row = db.prepare('SELECT * FROM otps WHERE phone = ?').get(phone);
  if (!row || row.expires_at < nowMs) return false;
  if (row.attempts >= MAX_ATTEMPTS) return false;
  db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE phone = ?').run(phone);
  const a = Buffer.from(hash(phone + String(code)));
  const b = Buffer.from(row.code_hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  db.prepare('DELETE FROM otps WHERE phone = ?').run(phone);
  return true;
}

export function createSession(db, phone, nowMs = Date.now()) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, phone, expires_at) VALUES (?, ?, ?)')
    .run(hash(token), phone, nowMs + SESSION_DAYS * 86400000);
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export function sessionPhone(db, token, nowMs = Date.now()) {
  if (!token) return null;
  const row = db.prepare('SELECT phone, expires_at FROM sessions WHERE token_hash = ?').get(hash(token));
  return row && row.expires_at > nowMs ? row.phone : null;
}

export function endSession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
}
