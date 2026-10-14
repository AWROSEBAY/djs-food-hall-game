import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { openDb } from '../src/db.js';
import { upsertPlayer, recordPayment, recordRefund, play, state, rollsAvailable, redeem } from '../src/game.js';
import { makeApp } from '../src/server.js';
import { issueOtp, checkOtp } from '../src/auth.js';

const PHONE = '+61412345678';
const SWIRL = 'LMJW0EDV18M49';
const inSeason = (hhmm, day = '2026-11-03') => `${day}T${hhmm}:00+11:00`;

function fresh() {
  const db = openDb(':memory:');
  upsertPlayer(db, PHONE, { smsOptIn: true });
  return db;
}

test('payment grants rolls once, and only to signed-up players', () => {
  const db = fresh();
  const p = { paymentId: 'p1', phone: PHONE, locationId: SWIRL, amountCents: 1150, paidAt: inSeason('08:15') };
  assert.deepEqual(recordPayment(db, p), { rolls: 2, offPeak: true, shield: true, reason: 'ok' });
  assert.equal(recordPayment(db, p), null, 'duplicate payment ignored');
  assert.equal(recordPayment(db, { ...p, paymentId: 'p2', phone: '+61400000000' }), null);
  assert.equal(rollsAvailable(db, PHONE), 2);
});

test('payments before the season starts earn nothing', () => {
  const db = fresh();
  assert.equal(recordPayment(db, { paymentId: 'early', phone: PHONE, locationId: SWIRL, amountCents: 2000, paidAt: inSeason('12:00', '2026-10-20') }), null);
});

test('daily cap across several orders', () => {
  const db = fresh();
  const base = { phone: PHONE, locationId: SWIRL, amountCents: 1500 };
  recordPayment(db, { ...base, paymentId: 'a', paidAt: inSeason('08:00') }); // 2
  const second = recordPayment(db, { ...base, paymentId: 'b', paidAt: inSeason('12:30') }); // 1
  const third = recordPayment(db, { ...base, paymentId: 'c', paidAt: inSeason('15:00') }); // 0
  assert.equal(second.rolls, 1);
  assert.equal(third.rolls, 0);
  assert.equal(rollsAvailable(db, PHONE), 3);
  const nextDay = recordPayment(db, { ...base, paymentId: 'd', paidAt: inSeason('12:30', '2026-11-04') });
  assert.equal(nextDay.rolls, 1);
});

test('full refund takes back unused rolls', () => {
  const db = fresh();
  recordPayment(db, { paymentId: 'r1', phone: PHONE, locationId: SWIRL, amountCents: 1200, paidAt: inSeason('12:30') });
  assert.equal(rollsAvailable(db, PHONE), 1);
  assert.deepEqual(recordRefund(db, { paymentId: 'r1', refundedCents: 1200 }), { revoked: 1 });
  assert.equal(rollsAvailable(db, PHONE), 0);
});

test('playing moves the token, uses a roll, and can award a prize within budget', () => {
  const db = fresh();
  recordPayment(db, { paymentId: 'big', phone: PHONE, locationId: SWIRL, amountCents: 100000, paidAt: inSeason('12:30') });
  const seq = [0.4, 0, 0]; // die 3, then "win", then first prize
  const r = play(db, PHONE, { rand: () => seq.shift() ?? 0, at: inSeason('12:31') });
  assert.equal(r.die, 3);
  assert.equal(r.to, 3);
  assert.equal(r.award.name, 'Swirl coffee');
  assert.equal(r.rollsLeft, 0);
  assert.equal(play(db, PHONE).error, 'no_rolls');
  const s = state(db, PHONE);
  assert.equal(s.position, 3);
  assert.equal(s.wallet.length, 1);
  assert.equal(redeem(db, { code: s.wallet[0].code, staff: 'Swirl' }).ok, true);
  assert.equal(redeem(db, { code: s.wallet[0].code, staff: 'Swirl' }).error, 'already_redeemed');
});

test('one-time codes expire and lock after attempts', () => {
  const db = fresh();
  const t = 1_000_000;
  const { code } = issueOtp(db, PHONE, t);
  assert.equal(checkOtp(db, PHONE, '000000x', t), false);
  assert.equal(checkOtp(db, PHONE, code, t + 11 * 60 * 1000), false, 'expired');
  const again = issueOtp(db, PHONE, t + 12 * 60 * 1000);
  assert.equal(checkOtp(db, PHONE, again.code, t + 12 * 60 * 1000), true);
});

test('Square webhook: signed payment grants rolls, bad signature rejected', async () => {
  const db = fresh();
  process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = 'test-key';
  process.env.SQUARE_WEBHOOK_URL = 'https://game.example.com/webhooks/square';
  const fetcher = async (path) => {
    if (path.startsWith('/v2/customers/')) return { customer: { phone_number: '0412 345 678' } };
    throw new Error('unexpected ' + path);
  };
  const server = createServer(makeApp(db, { squareFetcher: fetcher }));
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}/webhooks/square`;
  const event = {
    event_id: 'evt-1', type: 'payment.updated',
    data: { object: { payment: {
      id: 'sq-pay-1', status: 'COMPLETED', location_id: SWIRL, customer_id: 'C1',
      amount_money: { amount: 1250, currency: 'AUD' }, created_at: inSeason('08:40'), updated_at: inSeason('08:41'),
    } } },
  };
  const body = JSON.stringify(event);
  const sig = createHmac('sha256', 'test-key').update(process.env.SQUARE_WEBHOOK_URL + body).digest('base64');
  try {
    const bad = await fetch(url, { method: 'POST', body, headers: { 'x-square-hmacsha256-signature': 'nope' } });
    assert.equal(bad.status, 401);
    const ok = await fetch(url, { method: 'POST', body, headers: { 'x-square-hmacsha256-signature': sig } });
    assert.equal(ok.status, 200);
    assert.equal(rollsAvailable(db, PHONE), 2);
    const dup = await fetch(url, { method: 'POST', body, headers: { 'x-square-hmacsha256-signature': sig } });
    assert.equal((await dup.json()).duplicate, true);
    assert.equal(rollsAvailable(db, PHONE), 2);
  } finally {
    server.close();
  }
});
