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
const dom = { banner: null, inserts: 0 };
const fakeHeader = {
  insertAdjacentHTML: (_pos, html) => {
    dom.inserts++;
    dom.banner = {
      html,
      // read the same attribute production updateSaveBanner reads — no
      // hand-rolled html→kind mapping that can drift from the real contract
      dataset: { kind: /data-kind="([^"]+)"/.exec(html)?.[1] },
      remove: () => { dom.banner = null; },
    };
  },
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
function viewSaveErrorBanner() { const k = state.saveErrorPermanent ? 'permanent' : 'transient'; return '<banner data-kind="' + k + '">' + k + '</banner>'; }
export { state, db, scheduleSave, flushSave, signIn };`;

const { state, db, scheduleSave, flushSave, signIn } =
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
  dom.inserts = 0;
  state.phase = 'ready';
  state.saveStatus = 'saved';
  state.saveErrorPermanent = false;
  state.errorMsg = '';
  state.signinEmail = '';
  state.session = null;
  state.week = {
    id: 'w1', user_id: 'u1', week_start: '2026-08-03', budget: 2500, status: 'draft',
    picks: { mains: [], breakfasts: [] }, days: {},
    groceries: [{ id: 'g1', stapleId: 's1', name: 'Eggs', unit: null, price: 100, checked: false }],
    use_remainder: false,
  };
  db.client = fakeWeeksClient();
});

const authClient = (result) => ({ auth: { signInWithPassword: async () => result } });

test('signIn maps invalid credentials to a friendly error by stable code', async () => {
  db.client = authClient({ data: {}, error: { code: 'invalid_credentials', message: 'anything Supabase says' } });
  assert.equal(await signIn('a@b.com', 'wrong'), false);
  assert.equal(state.errorMsg, 'Wrong email or password.');
  assert.equal(state.signinEmail, 'a@b.com');  // survives the form re-render
  assert.equal(state.session, null);
});

test('signIn falls back to matching the legacy message when no code is present', async () => {
  db.client = authClient({ data: {}, error: { message: 'Invalid login credentials' } });
  assert.equal(await signIn('a@b.com', 'wrong'), false);
  assert.equal(state.errorMsg, 'Wrong email or password.');
});

test('signIn surfaces other auth errors verbatim', async () => {
  db.client = authClient({ data: {}, error: { code: 'over_request_rate_limit', message: 'Too many requests' } });
  assert.equal(await signIn('a@b.com', 'pw'), false);
  assert.equal(state.errorMsg, 'Too many requests');
});

test('signIn success stores the session, clears the error and the kept email', async () => {
  state.errorMsg = 'stale';
  state.signinEmail = 'typoed@example.com';   // left over from a failed attempt
  const session = { user: { id: 'u1' } };
  db.client = authClient({ data: { session }, error: null });
  assert.equal(await signIn('a@b.com', 'right'), true);
  assert.equal(state.session, session);
  assert.equal(state.errorMsg, '');
  assert.equal(state.signinEmail, '', 'a failed address must not pre-fill a future sign-in');
});

test('the real sign-in template emits and escapes the kept email and error message', async () => {
  const tmplStart = html.indexOf('function viewSignin');
  const tmplEnd = html.indexOf('function viewError');
  assert.ok(tmplStart > 0 && tmplEnd > tmplStart, 'sign-in template markers found in index.html');
  // use the real esc, not an identity stub — the escaping is the property
  // that matters for these user/API-controlled strings
  const escStart = html.indexOf('const esc =');
  const escEnd = html.indexOf('[c]));', escStart);
  assert.ok(escStart > 0 && escEnd > escStart, 'esc markers found in index.html');
  const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(
    `const state = { signinEmail: 'kept"@example.com', errorMsg: '<b>boom</b>' };
     ${html.slice(escStart, escEnd + '[c]));'.length)}
     const viewGate = (inner) => inner;
     ${html.slice(tmplStart, tmplEnd)}
     export { viewSignin };`));
  const out = mod.viewSignin();
  assert.match(out, /value="kept&quot;@example\.com"/, 'email is emitted AND attribute-escaped');
  assert.match(out, /&lt;b&gt;boom&lt;\/b&gt;/, 'error message is html-escaped');
  assert.match(out, /type="password"/);
});

test('the sign-in submit glue kicks initData directly (a stalled SIGNED_IN cannot strand loading)', () => {
  const hStart = html.indexOf("if (form.id === 'form-signin')");
  const hEnd = html.indexOf("if (form.id === 'form-addmeal')");
  assert.ok(hStart > 0 && hEnd > hStart, 'sign-in handler markers found in index.html');
  // strip block then line comments so no commented-out call, in either
  // style, can satisfy the pin
  const live = html.slice(hStart, hEnd)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.match(live, /await signIn\(/);
  assert.match(live, /initData\(\)/);
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
  db.client = fakeWeeksClient();
  await flushSave();                           // disarm the timer this test armed
});

test('a banner already showing refreshes when a retry escalates to a permanent failure', async () => {
  db.client = fakeWeeksClient({ failWith: { message: 'network down' } });
  await flushSave();
  assert.match(dom.banner.html, /transient/);
  db.client = fakeWeeksClient({ matchedRows: [] });
  delete state.week.user_id;                   // row gone + week too stripped to restore
  await flushSave();                           // the Retry-button path: no edit in between
  assert.match(dom.banner.html, /permanent/, 'stale transient banner must be replaced');
});

test('a repeat of the same failure keeps the banner element (no focus-yanking rebuild)', async () => {
  db.client = fakeWeeksClient({ failWith: { message: 'network down' } });
  await flushSave();
  assert.equal(dom.inserts, 1);
  await flushSave();                           // Retry fails the same way again
  assert.equal(dom.inserts, 1, 'identical banner must not be torn down and reinserted');
  assert.ok(dom.banner);
});

test('the real banner template pairs permanent with Reload and transient with Retry', async () => {
  const tmplStart = html.indexOf('function viewSaveErrorBanner');
  const tmplEnd = html.indexOf('function viewTabbar');
  assert.ok(tmplStart > 0 && tmplEnd > tmplStart, 'banner template markers found in index.html');
  const bannerSrc = html.slice(tmplStart, tmplEnd);
  const mkBanner = async (permanent) => {
    const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(
      `const state = { saveStatus: 'error', saveErrorPermanent: ${permanent} };\n${bannerSrc}\nexport { viewSaveErrorBanner };`));
    return mod.viewSaveErrorBanner();
  };
  const perm = await mkBanner(true);
  assert.match(perm, /data-action="reload"/);
  assert.match(perm, /data-kind="permanent"/); // the attribute updateSaveBanner's keep/rebuild gate reads
  assert.match(perm, /will be lost/);          // Reload admits it discards unsaved edits
  assert.doesNotMatch(perm, /data-action="retry-save"/);
  const transient = await mkBanner(false);
  assert.match(transient, /data-action="retry-save"/);
  assert.match(transient, /data-kind="transient"/);
  assert.doesNotMatch(transient, /data-action="reload"/);
  // and both actions are keys of the real dispatch table, not just strings
  // somewhere in the file
  const actionsStart = html.indexOf('const actions = {');
  const actionsEnd = html.indexOf('\n};', actionsStart);
  assert.ok(actionsStart > 0 && actionsEnd > actionsStart, 'actions map markers found in index.html');
  const actionsSrc = html.slice(actionsStart, actionsEnd);
  assert.match(actionsSrc, /'retry-save':/);
  assert.match(actionsSrc, /'reload':/);
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

// ── PGRST303 skew retry ────────────────────────────────────────────────
// "JWT issued at future": a freshly minted token can look post-dated to a
// Supabase node whose clock runs a beat behind the issuer's. The rejection
// happens during auth, before the query executes, so a single delayed
// re-run must absorb it — seen live on first production sign-in.

// counts attempts across any select/insert chain; errors[i] fails attempt i
function fakeRetryClient(errors, data = [{ id: 's1' }]) {
  const counter = { attempts: 0 };
  return {
    counter,
    from() {
      const b = {
        insert: () => b, select: () => b, single: () => b, eq: () => b, order: () => b,
        async then(resolve) {
          const error = errors[counter.attempts] ?? null;
          counter.attempts++;
          resolve(error ? { data: null, error } : { data, error: null });
        },
      };
      return b;
    },
  };
}

const SKEW = { code: 'PGRST303', message: 'JWT issued at future' };

// intercept the retry's setTimeout so the test records the delay but never waits it out
async function withInstantTimers(run) {
  const delays = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return realSetTimeout(fn, 0, ...rest); };
  try { await run(); } finally { globalThis.setTimeout = realSetTimeout; }
  return delays;
}

test('a PGRST303 rejection is retried once after a skew-sized delay, then succeeds', async () => {
  const rows = [{ id: 's1' }, { id: 's2' }];
  db.client = fakeRetryClient([SKEW], rows);
  let result;
  const delays = await withInstantTimers(async () => { result = await db.seedStaples('u1'); });
  assert.equal(result, rows);                  // second attempt's data came back
  assert.equal(db.client.counter.attempts, 2);
  assert.equal(delays.length, 1, 'exactly one retry delay');
  assert.ok(delays[0] >= 1000, `the delay must outlive the ~1s skew (got ${delays[0]}ms)`);
});

test('a second PGRST303 failure surfaces instead of retrying forever', async () => {
  db.client = fakeRetryClient([SKEW, SKEW]);
  await withInstantTimers(async () => {
    await assert.rejects(db.seedStaples('u1'), (err) => err.code === 'PGRST303');
  });
  assert.equal(db.client.counter.attempts, 2); // one retry, then give up
});

test('non-skew errors propagate immediately without a retry', async () => {
  db.client = fakeRetryClient([{ code: 'PGRST301', message: 'JWT expired' }]);
  const delays = await withInstantTimers(async () => {
    await assert.rejects(db.seedStaples('u1'), (err) => err.code === 'PGRST301');
  });
  assert.equal(db.client.counter.attempts, 1);
  assert.equal(delays.length, 0, 'no delay may be scheduled for a non-skew error');
});
