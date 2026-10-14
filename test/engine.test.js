import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  localParts, rollsForPayment, move, seasonWeek, releasedQty, pickPrize, normalisePhone,
} from '../src/engine.js';
import { SEASON, PRIZES } from '../src/config.js';

// 14 Oct 2026 is AEDT (UTC+11).
const syd = (hhmm) => `2026-10-14T${hhmm}:00+11:00`;

test('localParts converts to Sydney time', () => {
  assert.deepEqual(localParts('2026-10-13T22:30:00Z'), { date: '2026-10-14', minutes: 9 * 60 + 30 });
});

test('under $10 earns nothing', () => {
  assert.equal(rollsForPayment({ amountCents: 999, paidAt: syd('12:00'), earnedToday: 0 }).rolls, 0);
});

test('peak order earns 1, off-peak earns 2', () => {
  assert.equal(rollsForPayment({ amountCents: 1000, paidAt: syd('12:30'), earnedToday: 0 }).rolls, 1);
  assert.equal(rollsForPayment({ amountCents: 1000, paidAt: syd('11:29'), earnedToday: 0 }).rolls, 2);
  assert.equal(rollsForPayment({ amountCents: 1000, paidAt: syd('11:30'), earnedToday: 0 }).rolls, 1);
  assert.equal(rollsForPayment({ amountCents: 1000, paidAt: syd('14:00'), earnedToday: 0 }).rolls, 2);
});

test('an outlet can have a lower minimum order', () => {
  assert.equal(rollsForPayment({ amountCents: 850, paidAt: syd('07:45'), earnedToday: 0 }).rolls, 0);
  assert.equal(rollsForPayment({ amountCents: 850, paidAt: syd('07:45'), earnedToday: 0, minOrderCents: 800 }).rolls, 2);
});

test('daily cap of 3 holds', () => {
  assert.equal(rollsForPayment({ amountCents: 2000, paidAt: syd('08:00'), earnedToday: 2 }).rolls, 1);
  const r = rollsForPayment({ amountCents: 2000, paidAt: syd('08:00'), earnedToday: 3 });
  assert.equal(r.rolls, 0);
  assert.equal(r.reason, 'daily_cap');
});

test('ladders lift, snakes drop at most 3 and never below a checkpoint', () => {
  assert.equal(move({ position: 1, die: 3, shields: 0 }).to, 14);
  const s = move({ position: 14, die: 3, shields: 0 });
  assert.equal(s.event, 'snake');
  assert.equal(s.to, 14);
  for (const head of Object.keys(SEASON.snakes).map(Number)) {
    const r = move({ position: head - 1, die: 1, shields: 0 });
    assert.ok(head - r.to <= 3, `snake at ${head} drops too far`);
  }
});

test('shield blocks a snake and is used up', () => {
  const r = move({ position: 43, die: 1, shields: 1 });
  assert.equal(r.event, 'shielded');
  assert.equal(r.to, 44);
  assert.equal(r.usedShield, true);
});

test('reaching 50 finishes', () => {
  assert.equal(move({ position: 47, die: 6, shields: 0 }).finished, true);
  assert.equal(move({ position: 47, die: 6, shields: 0 }).to, 50);
});

test('season weeks and progressive release', () => {
  assert.equal(seasonWeek('2026-11-01T12:00:00+11:00'), 0);
  assert.equal(seasonWeek('2026-11-02T12:00:00+11:00'), 1);
  assert.equal(seasonWeek('2026-11-09T12:00:00+11:00'), 2);
  assert.equal(seasonWeek('2027-03-01T12:00:00+11:00'), 8);
  const coffee = PRIZES.find((p) => p.id === 'coffee');
  assert.equal(releasedQty(coffee, 1), 32);
  assert.equal(releasedQty(coffee, 8), 250);
});

test('budget gate blocks prizes once spend would pass 3% of revenue', () => {
  const always = () => 0; // always "wins" the chance roll and picks the first open prize
  const base = { prizes: PRIZES, awarded: {}, week: 1, rand: always };
  const rules = { budgetPct: 0.03, winChance: 0.25, seedBudgetCents: 0 };
  // $100 revenue -> $3 budget. $2.00 spent + $1.28 coffee = $3.28 > $3, so no.
  assert.equal(pickPrize({ ...base, spentCents: 200, revenueCents: 10000 }, rules), null);
  assert.equal(pickPrize({ ...base, spentCents: 0, revenueCents: 10000 }, rules).id, 'coffee');
  // The $200 seed float lets early players win before revenue builds.
  assert.equal(pickPrize({ ...base, spentCents: 0, revenueCents: 0 }).id, 'coffee');
});

test('released stock limits awards', () => {
  const always = () => 0;
  const awarded = { coffee: 32, scroll: 19, cake: 13, sandwich: 10, salad: 7, bagel: 7, wok2: 2, pdv2: 1 };
  assert.equal(pickPrize({ prizes: PRIZES, awarded, spentCents: 0, revenueCents: 1e9, week: 1, rand: always }), null);
});

test('phone numbers normalise to +614', () => {
  assert.equal(normalisePhone('0412 345 678'), '+61412345678');
  assert.equal(normalisePhone('+61 412 345 678'), '+61412345678');
  assert.equal(normalisePhone('61412345678'), '+61412345678');
  assert.equal(normalisePhone('02 9999 9999'), null);
});
