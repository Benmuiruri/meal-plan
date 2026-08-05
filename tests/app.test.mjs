// Regression tests for the save pipeline: debounce, serialized flushes,
// honest failure states, and self-healing zero-row saves.
// Run with: node --test tests/app.test.mjs
//
// Sections 2–7 of index.html (constants through save pipeline) are sliced out
// and imported with document stubbed; render() lives in the sliced-off view
// layer, so a no-op stands in for it.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Minimal observable DOM: just enough for updateSaveBanner's insert/remove to
// be visible to assertions, so deleting the banner wiring fails the suite.
const dom = { banner: null };
const fakeHeader = {
  insertAdjacentHTML: (_pos, html) => { dom.banner = { html, remove: () => { dom.banner = null; } }; },
};
globalThis.document = {
  visibilityState: 'visible',
  querySelector: (sel) => (sel === '#save-banner' ? dom.banner : sel === '.header' ? fakeHeader : null),
};

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('const DAY_KEYS');
const viewsBanner = html.lastIndexOf('/* =', html.indexOf('8. VIEWS'));
assert.ok(start > 0 && viewsBanner > start, 'section markers found in index.html');

const src = html.slice(start, viewsBanner) + `
function render() {}
function viewSaveErrorBanner() { return '<banner>' + (state.saveErrorPermanent ? 'permanent' : 'transient') + '</banner>'; }
export { state, db, scheduleSave, flushSave };`;

const { state, db, scheduleSave, flushSave } =
  await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a controllable fake for db.client — the .update() and .upsert() chains saveWeek uses
function fakeWeeksClient({ matchedRows = [{ id: 'w1' }], failWith = null, failUpsertWith = null,
                           restoredId = 'w1', delayMs = 0 } = {}) {
  const calls = [];
  return {
    calls,
    ops: (op) => calls.filter((c) => c.op === op),
    from() {
      const b = {
        op: null,
        update(payload) { b.op = 'update'; calls.push({ op: 'update', payload }); return b; },
        upsert(payload, opts) { b.op = 'upsert'; calls.push({ op: 'upsert', payload, opts }); return b; },
        eq: () => b,
        select: () => b,
        single: () => b,
        async then(resolve) {
          if (delayMs) await sleep(delayMs);
          if (b.op === 'upsert') {
            resolve(failUpsertWith
              ? { data: null, error: failUpsertWith }
              : { data: { id: restoredId }, error: null });
          } else {
            resolve(failWith ? { data: null, error: failWith } : { data: matchedRows, error: null });
          }
        },
      };
      return b;
    },
  };
}

beforeEach(() => {
  dom.banner = null;
  state.phase = 'ready';
  state.saveStatus = 'saved';
  state.saveErrorPermanent = false;
  state.week = {
    id: 'w1', user_id: 'u1', week_start: '2026-08-03', budget: 2500, status: 'draft',
    picks: { mains: [], breakfasts: [] }, days: {},
    groceries: [{ id: 'g1', stapleId: 's1', name: 'Eggs', unit: null, price: 100, checked: false }],
    use_remainder: false,
  };
  db.client = fakeWeeksClient();
});

test('saveWeek restores a vanished row on the natural key and adopts the canonical id', async () => {
  db.client = fakeWeeksClient({ matchedRows: [], restoredId: 'w2' });
  await assert.doesNotReject(db.saveWeek(state.week));
  const upserts = db.client.ops('upsert');
  assert.equal(upserts.length, 1);
  // conflict target is (user_id, week_start), never the id — another device
  // may have recreated this week under a fresh uuid
  assert.equal(upserts[0].opts.onConflict, 'user_id,week_start');
  assert.equal('id' in upserts[0].payload, false);
  assert.equal(upserts[0].payload.user_id, 'u1');
  assert.equal(upserts[0].payload.budget, 2500);        // same content
  assert.equal(state.week.id, 'w2');                    // adopted the canonical row
});

test('saveWeek fails loudly when the restore also fails', async () => {
  db.client = fakeWeeksClient({ matchedRows: [], failUpsertWith: { message: 'conflict' } });
  await assert.rejects(db.saveWeek(state.week));
});

test('saveWeek refuses to restore from an incomplete week object', async () => {
  db.client = fakeWeeksClient({ matchedRows: [] });
  delete state.week.user_id;
  await assert.rejects(db.saveWeek(state.week), /incomplete/);
  assert.equal(db.client.ops('upsert').length, 0);
});

test('saveWeek does not upsert when the update matched a row', async () => {
  await db.saveWeek(state.week);
  assert.equal(db.client.ops('upsert').length, 0);
});

test('scheduleSave debounces: two rapid edits produce one request', async () => {
  scheduleSave();
  assert.equal(state.saveStatus, 'saving');
  await sleep(100);
  scheduleSave();                              // resets the 800ms window
  await sleep(1100);
  assert.equal(db.client.ops('update').length, 1);
  assert.equal(state.saveStatus, 'saved');
});

test('flushSave failure marks error and keeps edits; retry with the same row recovers', async () => {
  db.client = fakeWeeksClient({ failWith: { message: 'network down' } });
  await flushSave();
  assert.equal(state.saveStatus, 'error');
  assert.equal(state.week.budget, 2500);       // nothing was thrown away
  db.client = fakeWeeksClient();
  await flushSave();                            // what the Retry button calls
  assert.equal(state.saveStatus, 'saved');
});

test('banner follows every status transition: appears on failure, clears on the next edit', async () => {
  db.client = fakeWeeksClient({ failWith: { message: 'network down' } });
  await flushSave();
  assert.ok(dom.banner, 'banner inserted on error');
  assert.match(dom.banner.html, /transient/);  // connection failures offer Retry
  scheduleSave();                              // user resumes typing
  assert.equal(dom.banner, null, 'a resumed edit clears the stale banner immediately');
});

test('banner clears when a retry succeeds', async () => {
  db.client = fakeWeeksClient({ failWith: { message: 'network down' } });
  await flushSave();
  assert.ok(dom.banner);
  db.client = fakeWeeksClient();
  await flushSave();
  assert.equal(dom.banner, null);
});

test('a permanent failure shows the permanent banner, not a connection retry', async () => {
  db.client = fakeWeeksClient({ matchedRows: [] });
  delete state.week.user_id;                   // restore guard refuses -> permanent
  await flushSave();
  assert.equal(state.saveStatus, 'error');
  assert.equal(state.saveErrorPermanent, true);
  assert.match(dom.banner.html, /permanent/);
});

test('saves are serialized and a stale completion cannot stamp Saved over pending work', async () => {
  db.client = fakeWeeksClient({ delayMs: 60 });
  state.saveStatus = 'saving';
  const first = flushSave();                   // request A, in flight for 60ms
  await sleep(10);
  await flushSave();                           // must defer behind A, not overlap
  assert.equal(db.client.ops('update').length, 1);
  await first;
  // A has completed but the deferred flush is still pending — A must NOT
  // have declared the state saved (delete the !saveTimer guard and this fails)
  assert.equal(state.saveStatus, 'saving');
  await sleep(300);                            // deferred flush fires after A lands
  assert.equal(db.client.ops('update').length, 2);
  assert.equal(state.saveStatus, 'saved');
});

test('a flush deferred behind an in-flight request fires immediately once the tab is hidden', async () => {
  try {
    db.client = fakeWeeksClient({ delayMs: 60 });
    state.saveStatus = 'saving';
    const first = flushSave();                 // request A, in flight
    await sleep(10);
    await flushSave();                         // deferred onto the 200ms timer
    document.visibilityState = 'hidden';
    await first;                               // A completes while hidden
    await sleep(20);                           // far below the 200ms timer —
    assert.equal(db.client.ops('update').length, 2); // — the re-flush must not wait for it
    await sleep(150);                          // let the trailing request settle
    assert.equal(state.saveStatus, 'saved');
  } finally {
    document.visibilityState = 'visible';      // never leak a hidden document to later tests
  }
});
