// Pure game rules. No database, no network: everything here is unit tested.

import { SEASON, ROLL_RULES, PRIZE_RULES } from './config.js';

const fmt = new Intl.DateTimeFormat('en-AU', {
  timeZone: ROLL_RULES.timezone,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// Local Sydney date and minutes past midnight for a timestamp.
export function localParts(when) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(when)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

export function isOffPeak(when, rules = ROLL_RULES) {
  const { minutes } = localParts(when);
  return minutes < rules.bonusBeforeMinutes || minutes >= rules.bonusFromMinutes;
}

// How many rolls a paid order earns, given rolls already earned that local day.
export function rollsForPayment({ amountCents, paidAt, earnedToday, minOrderCents }, rules = ROLL_RULES) {
  if (amountCents < (minOrderCents ?? rules.minOrderCents)) return { rolls: 0, offPeak: false, reason: 'under_minimum' };
  const offPeak = isOffPeak(paidAt, rules);
  const wanted = offPeak ? 2 : 1;
  const room = Math.max(0, rules.dailyCap - earnedToday);
  const rolls = Math.min(wanted, room);
  return { rolls, offPeak, reason: rolls === 0 ? 'daily_cap' : rolls < wanted ? 'capped' : 'ok' };
}

function checkpointBelow(square, season) {
  let floor = 0;
  for (const c of season.checkpoints) if (square >= c) floor = c;
  return floor;
}

// Move a token. Landing on 50 or beyond finishes the board.
export function move({ position, die, shields }, season = SEASON) {
  const landed = Math.min(season.boardSize, position + die);
  let to = landed;
  let event = null;
  let usedShield = false;
  if (season.ladders[landed]) {
    to = season.ladders[landed];
    event = 'ladder';
  } else if (season.snakes[landed]) {
    if (shields > 0) {
      event = 'shielded';
      usedShield = true;
    } else {
      to = Math.max(season.snakes[landed], landed - season.maxSnakeDrop, checkpointBelow(landed, season));
      event = 'snake';
    }
  }
  return { from: position, landed, to, event, usedShield, finished: to >= season.boardSize };
}

// Week of the season (1..weeks) for a timestamp; 0 before it starts.
export function seasonWeek(when, season = SEASON) {
  const { date } = localParts(when);
  const days = Math.floor((Date.parse(date) - Date.parse(season.startsOn)) / 86400000);
  if (days < 0) return 0;
  return Math.min(season.weeks, Math.floor(days / 7) + 1);
}

// Progressive release: by week n, n/weeks of each prize's stock is available.
export function releasedQty(prize, week, season = SEASON) {
  if (week <= 0) return 0;
  return Math.ceil((prize.qty * week) / season.weeks);
}

// Try to award an instant prize. Returns the prize or null.
// spentCents: prize cost already awarded this season.
// revenueCents: qualifying revenue tracked this season.
export function pickPrize({ prizes, awarded, spentCents, revenueCents, week, rand = Math.random }, rules = PRIZE_RULES, season = SEASON) {
  if (rand() >= rules.winChance) return null;
  const budget = Math.floor(revenueCents * rules.budgetPct) + (rules.seedBudgetCents || 0);
  const open = prizes.filter((p) =>
    (awarded[p.id] || 0) < releasedQty(p, week, season) &&
    spentCents + p.costCents <= budget);
  if (open.length === 0) return null;
  const total = open.reduce((s, p) => s + p.weight, 0);
  let r = rand() * total;
  for (const p of open) {
    r -= p.weight;
    if (r < 0) return p;
  }
  return open[open.length - 1];
}

export function rollDie(rand = Math.random) {
  return 1 + Math.floor(rand() * 6);
}

// Australian mobile to E.164 (+614...). Returns null if it doesn't look like one.
export function normalisePhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/[^\d+]/g, '');
  if (d.startsWith('+61')) d = '0' + d.slice(3);
  else if (d.startsWith('61') && d.length === 11) d = '0' + d.slice(2);
  if (!/^04\d{8}$/.test(d)) return null;
  return '+61' + d.slice(1);
}
