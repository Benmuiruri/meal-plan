// Regression tests for the save pipeline: serialized flushes, honest failure
// states, and zero-row saves.
// Run with: node --test tests/app.test.mjs
//
// Sections 2–7 of index.html (constants through save pipeline) are sliced out
// and imported with document stubbed; render() lives in the sliced-off view
// layer, so a no-op stands in for it.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.document = { querySelector: () => null };

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('const DAY_KEYS');
const viewsBanner = html.lastIndexOf('/* =', html.indexOf('8. VIEWS'));
assert.ok(start > 0 && viewsBanner > start, 'section markers found in index.html');

const src = html.slice(start, viewsBanner) + `
function render() {}
export { state, db, scheduleSave, flushSave };`;

const { state, db, flushSave } = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a controllable fake for db.client — only the .update() chain saveWeek uses
function fakeWeeksClient({ matchedRows = [{ id: 'w1' }], failWith = null, delayMs = 0 } = {}) {
  const calls = [];
  return {
    calls,
    from() {
      const b = {
        update(payload) { calls.push(payload); return b; },
        eq: () => b,
        select: () => b,
        async then(resolve) {
          if (delayMs) await sleep(delayMs);
          resolve(failWith ? { data: null, error: failWith } : { data: matchedRows, error: null });
        },
      };
      return b;
    },
  };
}

beforeEach(() => {
  state.phase = 'ready';
  state.saveStatus = 'saved';
  state.week = {
    id: 'w1', week_start: '2026-08-03', budget: 2500, status: 'draft',
    picks: { mains: [], breakfasts: [] }, days: {},
    groceries: [{ id: 'g1', stapleId: 's1', name: 'Eggs', unit: null, price: 100, checked: false }],
    use_remainder: false,
  };
  db.client = fakeWeeksClient();
});

test('saveWeek throws WEEK_GONE when the update matches zero rows', async () => {
  db.client = fakeWeeksClient({ matchedRows: [] });
  await assert.rejects(db.saveWeek(state.week), (e) => e.code === 'WEEK_GONE');
  db.client = fakeWeeksClient();               // one matched row → resolves
  await assert.doesNotReject(db.saveWeek(state.week));
});

test('flushSave success marks saved', async () => {
  state.saveStatus = 'saving';
  await flushSave();
  assert.equal(state.saveStatus, 'saved');
  assert.equal(db.client.calls.length, 1);
});

test('flushSave failure marks the state as error, keeping edits in memory', async () => {
  db.client = fakeWeeksClient({ failWith: { message: 'network down' } });
  await flushSave();
  assert.equal(state.saveStatus, 'error');
  assert.equal(state.week.budget, 2500);       // nothing was thrown away
});

test('a failed save succeeds on retry with the same week row', async () => {
  db.client = fakeWeeksClient({ failWith: { message: 'network down' } });
  await flushSave();
  assert.equal(state.saveStatus, 'error');
  db.client = fakeWeeksClient();
  await flushSave();                            // what the Retry button calls
  assert.equal(state.saveStatus, 'saved');
});

test('saves are serialized: a flush during an in-flight request re-queues, never overlaps', async () => {
  db.client = fakeWeeksClient({ delayMs: 60 });
  const first = flushSave();                   // in flight for 60ms
  await sleep(10);
  await flushSave();                           // must defer, not fire a second request
  assert.equal(db.client.calls.length, 1);
  await first;
  await sleep(300);                            // deferred flush fires after the first lands
  assert.equal(db.client.calls.length, 2);
  assert.equal(state.saveStatus, 'saved');
});
