// Domain-layer tests: sections 2–4 of index.html sliced out and imported as
// a data: URL module. Run with: node --test tests/domain.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('const DAY_KEYS');
const dataLayerBanner = html.lastIndexOf('/* =', html.indexOf('5. DATA LAYER'));
assert.ok(start > 0 && dataLayerBanner > start, 'section markers found in index.html');

const src = html.slice(start, dataLayerBanner) + `
export { DAY_KEYS, PICK_TARGET, SEED_MAINS, SEED_BREAKFASTS, parseMoney,
         currentMonday, addDays, nextDraftStart, currentRoute, picksComplete,
         menuReady, reconcileDays, swapSlots, lunchFor, computeTotals, budgetTone };`;

const {
  DAY_KEYS, PICK_TARGET, SEED_MAINS, SEED_BREAKFASTS, parseMoney,
  currentMonday, addDays, nextDraftStart, currentRoute, picksComplete,
  menuReady, reconcileDays, swapSlots, lunchFor, computeTotals, budgetTone,
} = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));

const week = (over = {}) => ({
  budget: null, picks: { mains: [], breakfasts: [] }, days: {},
  groceries: [], ...over,
});

test('parseMoney: empty clears, invalid and negative are rejected', () => {
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('   '), null);
  assert.equal(parseMoney('50'), 50);
  assert.equal(parseMoney('12.50'), 12.5);
  assert.equal(parseMoney('-5'), undefined);
  assert.equal(parseMoney('abc'), undefined);
  assert.equal(parseMoney('1e3'), 1000);
});

test('currentMonday returns an ISO date that is a Monday', () => {
  const iso = currentMonday();
  assert.match(iso, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Date(iso).getUTCDay(), 1);
});

test('picksComplete requires exactly 7 of each', () => {
  const ids = (n, p) => Array.from({ length: n }, (_, i) => p + i);
  assert.equal(picksComplete(week({ picks: { mains: ids(7, 'm'), breakfasts: ids(7, 'b') } })), true);
  assert.equal(picksComplete(week({ picks: { mains: ids(6, 'm'), breakfasts: ids(7, 'b') } })), false);
});

test('menuReady: 7/7 opens the menu by itself, fewer picks need the confirmed flag', () => {
  const ids = (n, p) => Array.from({ length: n }, (_, i) => p + i);
  assert.equal(menuReady(week({ picks: { mains: ids(7, 'm'), breakfasts: ids(7, 'b') } })), true);
  assert.equal(menuReady(week({ picks: { mains: ids(4, 'm'), breakfasts: ids(7, 'b') } })), false);
  assert.equal(menuReady(week({ picks: { mains: ids(4, 'm'), breakfasts: ids(7, 'b'), confirmed: true } })), true);
  assert.equal(menuReady(week({ picks: { mains: ['m1'], breakfasts: [], confirmed: true } })), true);
  // clearing every pick revokes an earlier confirm — an empty week is never
  // ready, or Summary would offer to save an all-dash board
  assert.equal(menuReady(week({ picks: { mains: [], breakfasts: [], confirmed: true } })), false);
  // truthy is not confirmed — only an explicit true survives a round-trip through JSONB
  assert.equal(menuReady(week({ picks: { mains: ['m1'], breakfasts: [], confirmed: 'yes' } })), false);
});

test('reconcileDays fills empty days from picks in order', () => {
  const picks = { mains: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'], breakfasts: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'] };
  const days = reconcileDays(picks, {});
  assert.equal(days.mon.dinner, 'm1');
  assert.equal(days.sun.dinner, 'm7');
  assert.equal(days.mon.breakfast, 'b1');
  assert.equal(DAY_KEYS.every((k) => days[k].dinner && days[k].breakfast), true);
});

test('reconcileDays keeps existing assignments and drops unpicked meals', () => {
  const picks = { mains: ['m1', 'm2'], breakfasts: [] };
  const existing = { mon: { dinner: 'm2', breakfast: null }, tue: { dinner: 'gone', breakfast: null } };
  const days = reconcileDays(picks, existing);
  assert.equal(days.mon.dinner, 'm2');   // kept in place
  assert.equal(days.tue.dinner, 'm1');   // 'gone' dropped, backfilled in pick order
});

test('reconcileDays deduplicates a meal assigned twice', () => {
  const picks = { mains: ['m1', 'm2'], breakfasts: [] };
  const doubled = { mon: { dinner: 'm1', breakfast: null }, tue: { dinner: 'm1', breakfast: null } };
  const days = reconcileDays(picks, doubled);
  assert.equal(days.mon.dinner, 'm1');
  assert.equal(days.tue.dinner, 'm2');
});

test('swapSlots trades one slot between two days and nothing else', () => {
  const days = reconcileDays({ mains: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'], breakfasts: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'] }, {});
  const out = swapSlots(days, 'dinner', 'mon', 'wed');
  assert.equal(out.mon.dinner, 'm3');
  assert.equal(out.wed.dinner, 'm1');
  assert.equal(out.mon.breakfast, 'b1');       // breakfasts untouched
  assert.equal(days.mon.dinner, 'm1');         // input not mutated
});

test('swapSlots leaves typed lunch overrides on their days', () => {
  const days = reconcileDays({ mains: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'], breakfasts: [] }, {});
  days.tue.lunch = 'Samosas';
  const out = swapSlots(days, 'dinner', 'mon', 'tue');
  assert.equal(out.tue.lunch, 'Samosas');      // the override belongs to the day, not the dinner
  assert.equal(out.mon.lunch, undefined);      // and never migrates with it
});

test('lunch defaults to the previous day\'s dinner; Monday has none', () => {
  const days = { mon: { dinner: 'm1' }, tue: { dinner: 'm2' } };
  assert.equal(lunchFor(days, 'mon'), null);
  assert.deepEqual(lunchFor(days, 'tue'), { mealId: 'm1' });
  assert.deepEqual(lunchFor(days, 'wed'), { mealId: 'm2' });
});

test('a free-text lunch override wins over the default, even on Monday', () => {
  const days = {
    mon: { dinner: 'm1', lunch: 'Eating out' },
    tue: { dinner: 'm2', lunch: 'Leftover pilau' },
    wed: { dinner: 'm3' },
  };
  assert.deepEqual(lunchFor(days, 'mon'), { custom: 'Eating out' });
  assert.deepEqual(lunchFor(days, 'tue'), { custom: 'Leftover pilau' });
  assert.deepEqual(lunchFor(days, 'wed'), { mealId: 'm2' }); // untouched day keeps the default
});

test('reconcileDays carries lunch overrides through a picks reshuffle', () => {
  const picks = { mains: ['m1', 'm2'], breakfasts: [] };
  const existing = {
    mon: { dinner: 'gone', breakfast: null, lunch: 'Samosas' },
    tue: { dinner: 'm2', breakfast: null },
  };
  const days = reconcileDays(picks, existing);
  assert.equal(days.mon.lunch, 'Samosas');   // override survives the dinner being dropped
  assert.equal(days.tue.lunch, undefined);   // no override invented for other days
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-08-03', 7), '2026-08-10');
  assert.equal(addDays('2026-12-28', 7), '2027-01-04');
  assert.equal(addDays('2026-02-23', 7), '2026-03-02');
});

test('nextDraftStart: a mid-week save plans the following Monday, a stale save jumps to the current one', () => {
  assert.equal(nextDraftStart('2026-08-03', '2026-08-03'), '2026-08-10'); // saved its own week
  assert.equal(nextDraftStart('2026-07-06', '2026-08-03'), '2026-08-03'); // a month idle in between
  assert.equal(nextDraftStart('2026-08-03', '2026-08-10'), '2026-08-10'); // saved exactly one week behind
});

test('currentRoute parses the history detail and falls back to pick', () => {
  const withHash = (h) => {
    globalThis.location = { hash: h };
    try { return currentRoute(); } finally { delete globalThis.location; }
  };
  assert.deepEqual(withHash('#/history'), { route: 'history', detail: null });
  assert.deepEqual(withHash('#/history/2026-08-03'), { route: 'history', detail: '2026-08-03' });
  assert.deepEqual(withHash('#/budget'), { route: 'budget', detail: null });
  assert.deepEqual(withHash('#/budget/2026-08-03'), { route: 'budget', detail: null }, 'detail is a history-only concept');
  assert.deepEqual(withHash('#/nope'), { route: 'pick', detail: null });
  assert.deepEqual(withHash(''), { route: 'pick', detail: null });
});

test('computeTotals ignores null prices and rounds to cents', () => {
  const w = week({ budget: 1000, groceries: [{ price: 0.1 }, { price: 0.2 }, { price: null }] });
  const t = computeTotals(w);
  assert.equal(t.total, 0.3);
  assert.equal(t.remaining, 999.7);
});

test('computeTotals with no budget yields null remaining', () => {
  assert.equal(computeTotals(week({ groceries: [{ price: 50 }] })).remaining, null);
});

test('budgetTone: green at exactly 10% left, amber below, red past zero', () => {
  const tone = (budget, total) => budgetTone(computeTotals(week({ budget, groceries: [{ price: total }] })));
  assert.equal(tone(300, 200), 'green');
  assert.equal(tone(300, 270), 'green');   // remaining 30 = exactly 10%
  assert.equal(tone(300, 271), 'amber');
  assert.equal(tone(300, 301), 'red');
  assert.equal(budgetTone(computeTotals(week())), 'plain');
});

test('PICK_TARGET is 7', () => assert.equal(PICK_TARGET, 7));

test('seed meals are well-formed: unique names, bucket-shaped image names', () => {
  const all = [...SEED_MAINS, ...SEED_BREAKFASTS];
  // names must be unique; an img shared between meals is fine and intended
  // (both vegetable combos use one photo)
  assert.equal(new Set(all.map((m) => m.name)).size, all.length, 'no duplicate names');
  for (const m of all) {
    assert.ok(m.name?.trim(), 'every seed has a name');
    if (m.img !== undefined) {
      // a space or uppercase here is a bucket 404; existence itself was
      // verified live when the photos were loaded (2026-08-06)
      assert.match(m.img, /^[a-z0-9-]+\.jpg$/, `${m.name}: "${m.img}" is not a bucket-shaped object name`);
    }
  }
  const mains = SEED_MAINS.map((m) => m.name);
  assert.ok(mains.includes('Ugali + beef') && mains.includes('Ugali + mbuzi'),
    'the household-added ugali mains stay in the seed library');
  // a live invariant, not a change detector: every breakfast ships with its
  // photo — a seed row silently losing one is a regression
  assert.ok(SEED_BREAKFASTS.every((m) => m.img), 'every breakfast ships with a photo');
});
