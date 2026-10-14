// Season rules. Change these here, not in the engine.
// Money is in cents throughout.

export const SEASON = {
  id: 'S1',
  name: 'Season 1',
  startsOn: process.env.SEASON_START || '2026-11-02', // Sydney date, placeholder until Ant confirms
  weeks: 8,
  boardSize: 50,
  checkpoints: [10, 20, 30, 40],
  ladders: { 4: 14, 12: 23, 27: 38, 33: 45 },
  snakes: { 17: 14, 26: 23, 36: 34, 44: 41, 48: 45 },
  maxSnakeDrop: 3,
  grandPrize: 'A chef cooks dinner at your home',
};

export const ROLL_RULES = {
  minOrderCents: 1000, // $10
  dailyCap: 3,
  timezone: 'Australia/Sydney',
  // Bonus roll for orders paid before 11:30 or from 14:00 (Sydney time)
  bonusBeforeMinutes: 11 * 60 + 30,
  bonusFromMinutes: 14 * 60,
};

export const PRIZE_RULES = {
  // Strict budget gate (Shay, 18 Sep 2026): a prize is only awarded if total prize
  // cost stays within this share of tracked revenue for the season.
  budgetPct: 0.03,
  // Starting float so the first players can win before revenue builds up.
  // Without it, nobody can win anything until about $43 of tracked sales per coffee.
  seedBudgetCents: 20000, // $200
  // Chance that a roll tries to award an instant prize. Placeholder, not final.
  winChance: 0.25,
};

// Prize inventory for the season. cost = cash cost to Create, not menu price.
// Costs and quantities from Laura Lao / Shay prize pool (14 Sep 2026); headline
// prizes are handled by the end-of-season draw, not instant wins.
export const PRIZES = [
  { id: 'coffee', name: 'Swirl coffee', costCents: 128, qty: 250, weight: 40 },
  { id: 'scroll', name: 'Cinnamon scroll', costCents: 127, qty: 150, weight: 25 },
  { id: 'cake', name: 'Slice of cake', costCents: 200, qty: 100, weight: 15 },
  { id: 'sandwich', name: 'Sandwich', costCents: 314, qty: 75, weight: 8 },
  { id: 'salad', name: 'Salad', costCents: 448, qty: 50, weight: 5 },
  { id: 'bagel', name: 'Good Bagel', costCents: 450, qty: 50, weight: 5 },
  { id: 'wok2', name: 'Wok lunch for 2', costCents: 8400, qty: 10, weight: 1 },
  { id: 'pdv2', name: 'Pan Divino lunch for 2', costCents: 12000, qty: 5, weight: 1 },
];

// Square location IDs for the DJES outlets that count towards the game.
export const LOCATIONS = {
  LY2BWP34BMPZF: 'Bakery',
  L41CVP9YXENK1: 'Celebration',
  LCBB3AA0TF87D: 'The Deli',
  LWHDV2NSS3W0A: 'Level 2 Cafe',
  LC3NNKD708RB0: 'Oyster Bar',
  LAXJ0R7MM5GS4: 'Pan Divino City',
  LRNDZYN9YKC61: 'Retro Roast',
  LMJW0EDV18M49: 'Swirl',
  LDP5S6JBHMV9R: 'Wok',
};
