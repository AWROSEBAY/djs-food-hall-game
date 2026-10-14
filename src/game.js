// Game service: applies engine rules to the database.

import { randomInt } from 'node:crypto';
import { tx } from './db.js';
import { SEASON, PRIZES, ROLL_RULES } from './config.js';
import { localParts, rollsForPayment, move, seasonWeek, pickPrize, rollDie } from './engine.js';

const now = () => new Date().toISOString();
const secureRand = () => randomInt(0, 2 ** 32) / 2 ** 32;

export function getPlayer(db, phone) {
  return db.prepare('SELECT * FROM players WHERE phone = ?').get(phone);
}

export function upsertPlayer(db, phone, { smsOptIn }) {
  db.prepare(`INSERT INTO players (phone, created_at, terms_accepted_at, sms_opt_in)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET sms_opt_in = excluded.sms_opt_in`)
    .run(phone, now(), now(), smsOptIn ? 1 : 0);
}

function board(db, phone, season = SEASON) {
  db.prepare('INSERT OR IGNORE INTO boards (phone, season_id) VALUES (?, ?)').run(phone, season.id);
  return db.prepare('SELECT * FROM boards WHERE phone = ? AND season_id = ?').get(phone, season.id);
}

export function rollsAvailable(db, phone, season = SEASON) {
  const r = db.prepare(`SELECT COALESCE(SUM(rolls_granted - rolls_used - rolls_revoked), 0) AS n
    FROM payments WHERE phone = ? AND season_id = ?`).get(phone, season.id);
  return Number(r.n);
}

// Record a completed Square payment. Idempotent on payment id.
// Returns { rolls, offPeak, shield } or null when it earns nothing new.
export function recordPayment(db, { paymentId, phone, locationId, amountCents, paidAt }, season = SEASON) {
  if (!getPlayer(db, phone)) return null; // only signed-up players earn rolls
  if (seasonWeek(paidAt, season) === 0) return null; // before the season starts
  return tx(db, () => {
    if (db.prepare('SELECT 1 FROM payments WHERE payment_id = ?').get(paymentId)) return null;
    const { date } = localParts(paidAt);
    const earned = db.prepare(`SELECT COALESCE(SUM(rolls_granted), 0) AS n FROM payments
      WHERE phone = ? AND local_date = ?`).get(phone, date);
    const r = rollsForPayment({ amountCents, paidAt, earnedToday: Number(earned.n) });
    db.prepare(`INSERT INTO payments (payment_id, phone, season_id, location_id, amount_cents,
      paid_at, local_date, off_peak, rolls_granted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(paymentId, phone, season.id, locationId, amountCents, paidAt, date, r.offPeak ? 1 : 0, r.rolls);
    let shield = false;
    if (r.offPeak && amountCents >= ROLL_RULES.minOrderCents) {
      const b = board(db, phone, season);
      if (b.shields < 1) {
        db.prepare('UPDATE boards SET shields = 1 WHERE phone = ? AND season_id = ?').run(phone, season.id);
        shield = true;
      }
    }
    return { rolls: r.rolls, offPeak: r.offPeak, shield, reason: r.reason };
  });
}

// Apply a refund. If what's left of the order is under the minimum,
// unused rolls from that order are taken back.
export function recordRefund(db, { paymentId, refundedCents }) {
  return tx(db, () => {
    const p = db.prepare('SELECT * FROM payments WHERE payment_id = ?').get(paymentId);
    if (!p) return null;
    const refunded = Math.max(p.refunded_cents, refundedCents);
    let revoked = p.rolls_revoked;
    if (p.amount_cents - refunded < ROLL_RULES.minOrderCents) {
      revoked = p.rolls_granted - p.rolls_used;
    }
    db.prepare('UPDATE payments SET refunded_cents = ?, rolls_revoked = ? WHERE payment_id = ?')
      .run(refunded, revoked, paymentId);
    return { revoked: revoked - p.rolls_revoked };
  });
}

function awardCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[randomInt(0, chars.length)];
  return s;
}

export function play(db, phone, { rand = secureRand, at = now() } = {}, season = SEASON) {
  return tx(db, () => {
    const grant = db.prepare(`SELECT * FROM payments
      WHERE phone = ? AND season_id = ? AND rolls_granted - rolls_used - rolls_revoked > 0
      ORDER BY paid_at LIMIT 1`).get(phone, season.id);
    if (!grant) return { error: 'no_rolls' };
    const b = board(db, phone, season);
    if (b.finished_at) return { error: 'finished' };

    const die = rollDie(rand);
    const m = move({ position: b.position, die, shields: b.shields }, season);

    let award = null;
    const totals = db.prepare(`SELECT
        (SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) FROM payments WHERE season_id = ?) AS revenue,
        (SELECT COALESCE(SUM(cost_cents), 0) FROM awards WHERE season_id = ?) AS spent`).get(season.id, season.id);
    const awarded = Object.fromEntries(db.prepare(`SELECT prize_id, COUNT(*) AS n FROM awards
      WHERE season_id = ? GROUP BY prize_id`).all(season.id).map((r) => [r.prize_id, Number(r.n)]));
    const prize = pickPrize({
      prizes: PRIZES, awarded, spentCents: Number(totals.spent), revenueCents: Number(totals.revenue),
      week: seasonWeek(at, season), rand,
    });
    if (prize) {
      const code = awardCode();
      const res = db.prepare(`INSERT INTO awards (phone, season_id, prize_id, prize_name, cost_cents, code, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(phone, season.id, prize.id, prize.name, prize.costCents, code, at);
      award = { id: Number(res.lastInsertRowid), name: prize.name, code };
    }

    db.prepare(`UPDATE boards SET position = ?, shields = shields - ?, finished_at = ?
      WHERE phone = ? AND season_id = ?`)
      .run(m.to, m.usedShield ? 1 : 0, m.finished ? at : null, phone, season.id);
    db.prepare('UPDATE payments SET rolls_used = rolls_used + 1 WHERE payment_id = ?').run(grant.payment_id);
    db.prepare(`INSERT INTO plays (phone, season_id, payment_id, die, from_square, landed, to_square, event, award_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(phone, season.id, grant.payment_id, die, m.from, m.landed, m.to, m.event, award?.id ?? null, at);

    return { die, ...m, award, rollsLeft: rollsAvailable(db, phone, season) };
  });
}

export function state(db, phone, season = SEASON) {
  const b = board(db, phone, season);
  const wallet = db.prepare(`SELECT prize_name AS name, code, created_at AS wonAt, redeemed_at AS redeemedAt
    FROM awards WHERE phone = ? AND season_id = ? ORDER BY id DESC`).all(phone, season.id);
  return {
    season: {
      id: season.id, name: season.name, boardSize: season.boardSize, checkpoints: season.checkpoints,
      ladders: season.ladders, snakes: season.snakes, grandPrize: season.grandPrize,
    },
    position: b.position,
    shields: b.shields,
    finished: Boolean(b.finished_at),
    rolls: rollsAvailable(db, phone, season),
    wallet,
  };
}

export function redeem(db, { code, staff }) {
  return tx(db, () => {
    const a = db.prepare('SELECT * FROM awards WHERE code = ?').get(code.toUpperCase());
    if (!a) return { error: 'not_found' };
    if (a.redeemed_at) return { error: 'already_redeemed', redeemedAt: a.redeemed_at };
    db.prepare('UPDATE awards SET redeemed_at = ?, redeemed_by = ? WHERE id = ?').run(now(), staff, a.id);
    return { ok: true, prize: a.prize_name };
  });
}

export function summary(db, season = SEASON) {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const revenue = Number(one('SELECT COALESCE(SUM(amount_cents - refunded_cents),0) AS n FROM payments WHERE season_id = ?', season.id).n);
  const spent = Number(one('SELECT COALESCE(SUM(cost_cents),0) AS n FROM awards WHERE season_id = ?', season.id).n);
  return {
    season: season.id,
    players: Number(one('SELECT COUNT(*) AS n FROM players').n),
    trackedRevenue: revenue / 100,
    prizeCost: spent / 100,
    prizeCostPct: revenue ? +(100 * spent / revenue).toFixed(2) : 0,
    rollsGranted: Number(one('SELECT COALESCE(SUM(rolls_granted),0) AS n FROM payments WHERE season_id = ?', season.id).n),
    plays: Number(one('SELECT COUNT(*) AS n FROM plays WHERE season_id = ?', season.id).n),
    awardsByPrize: db.prepare(`SELECT prize_name AS prize, COUNT(*) AS won, SUM(redeemed_at IS NOT NULL) AS redeemed
      FROM awards WHERE season_id = ? GROUP BY prize_name`).all(season.id),
    finishers: Number(one('SELECT COUNT(*) AS n FROM boards WHERE season_id = ? AND finished_at IS NOT NULL', season.id).n),
  };
}

export function finishers(db, season = SEASON) {
  return db.prepare(`SELECT phone, finished_at FROM boards WHERE season_id = ? AND finished_at IS NOT NULL
    ORDER BY finished_at`).all(season.id);
}
