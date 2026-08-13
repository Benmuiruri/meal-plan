// App-layer tests. Sections 2–7 of index.html are sliced out and imported
// with document stubbed. Run with: node --test tests/app.test.mjs

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

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
export { state, db, scheduleSave, flushSave, signIn, resizeImage, isServerRejection,
         markDeadImage, reviveDeadImages, performSaveWeek, withCeiling, MEAL_REQUEST_CEILING_MS,
         confirmSheet, settleConfirm, noticeSheet, togglePasswordField, isPasswordToggle,
         clearPicks };`;

const { state, db, scheduleSave, flushSave, signIn, resizeImage, isServerRejection,
        markDeadImage, reviveDeadImages, performSaveWeek, withCeiling, MEAL_REQUEST_CEILING_MS,
        confirmSheet, settleConfirm, noticeSheet, togglePasswordField, isPasswordToggle,
        clearPicks } =
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
    groceries: [{ id: 'g1', stapleId: 's1', name: 'Eggs', price: 100, checked: false }],
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
  // the real ICONS too — the template reads it, so a stub here could drift
  const iconsStart = html.indexOf('const ICONS = {');
  const iconsEnd = html.indexOf('};', iconsStart);
  assert.ok(iconsStart > 0 && iconsEnd > iconsStart, 'ICONS markers found in index.html');
  const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(
    `const state = { signinEmail: 'kept"@example.com', errorMsg: '<b>boom</b>' };
     ${html.slice(escStart, escEnd + '[c]));'.length)}
     ${html.slice(iconsStart, iconsEnd + 2)}
     const viewGate = (inner) => inner;
     ${html.slice(tmplStart, tmplEnd)}
     export { viewSignin };`));
  const out = mod.viewSignin();
  assert.match(out, /value="kept&quot;@example\.com"/, 'email is emitted AND attribute-escaped');
  assert.match(out, /&lt;b&gt;boom&lt;\/b&gt;/, 'error message is html-escaped');
  assert.match(out, /type="password"/);
});

// a fake just observable enough for the toggle: the type, the pressed flag
// and the caret are the whole contract
function fakePasswordField({ type = 'password', pressed = 'false' } = {}) {
  const input = {
    _type: type, value: 'hunter2', selectionStart: 3, selectionEnd: 3,
    focused: false, focus() { this.focused = true; },
    get type() { return this._type; },
    // a real browser drops the caret to the end when the type changes; without
    // that here, the restore assertion below passes with the restore deleted
    set type(t) { this._type = t; this.selectionStart = this.selectionEnd = this.value.length; },
    setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; },
  };
  const attrs = { 'aria-pressed': pressed };
  const btn = {
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => { attrs[k] = String(v); },
    attrs,
    parentElement: { querySelector: (sel) => (sel.includes('input') ? input : null) },
  };
  return { input, btn, attrs };
}

test('the password toggle flips the field in place and keeps the caret where it was', () => {
  const { input, btn, attrs } = fakePasswordField();
  assert.equal(togglePasswordField(btn), true, 'the first press reveals');
  assert.equal(input.type, 'text', 'the field is readable');
  assert.equal(attrs['aria-pressed'], 'true', 'the button says so');
  assert.equal(input.value, 'hunter2', 'the typed password is untouched');
  assert.deepEqual([input.selectionStart, input.selectionEnd], [3, 3],
    'a type flip resets the caret in some browsers — it is put back');

  assert.equal(togglePasswordField(btn), false, 'pressing again hides');
  assert.equal(input.type, 'password');
  assert.equal(attrs['aria-pressed'], 'false');
});

test('the password toggle reads its state from the button, not a module variable', () => {
  // two independent presses of a button already marked pressed must both
  // hide — a private boolean would flip-flop instead
  const a = fakePasswordField({ type: 'text', pressed: 'true' });
  const b = fakePasswordField({ type: 'text', pressed: 'true' });
  assert.equal(togglePasswordField(a.btn), false);
  assert.equal(togglePasswordField(b.btn), false);
  assert.equal(a.input.type, 'password');
  assert.equal(b.input.type, 'password');
});

test('a toggle with no field beside it says so, and claims no state it never reached', () => {
  const attrs = { 'aria-pressed': 'false' };
  const orphan = {
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => { attrs[k] = String(v); },
    parentElement: { querySelector: () => null },
  };
  assert.equal(togglePasswordField(orphan), null,
    'nothing to toggle is its own answer — false would read as "hidden now"');
  assert.equal(attrs['aria-pressed'], 'false', 'and the button is left as it was');
});

test('the toggle never re-renders — a render would wipe the password being typed', () => {
  const at = html.indexOf("'toggle-password':");
  assert.ok(at > 0, 'toggle-password action found in index.html');
  const body = html.slice(at, html.indexOf("'confirm-yes':", at));
  assert.ok(body.length > 0 && body.length < 400, 'the action body is bounded by the next action');
  // the exact shape, not just the absence of the word "render": any added
  // statement is a repaint waiting to happen, whatever it is spelled
  assert.match(body, /^'toggle-password': \(el\) => \{ togglePasswordField\(el\); \},/,
    'the action is the delegation and nothing else — the password lives only in the DOM');
});

test('the focus guard recognises the toggle and nothing else', () => {
  const SEL = '[data-action="toggle-password"]';
  const onToggle = { closest: (s) => (s === SEL ? onToggle : null) };
  const elsewhere = { closest: () => null };
  assert.equal(isPasswordToggle(onToggle), true, 'a press on the toggle is guarded');
  assert.equal(isPasswordToggle(elsewhere), false, 'every other press is left alone');
  assert.equal(isPasswordToggle(null), false, 'and a targetless event does not throw');
});

test('the toggle refuses focus so the caret and the phone keyboard stay put', () => {
  const at = html.indexOf("document.addEventListener('mousedown'");
  assert.ok(at > 0, 'the focus guard is wired in index.html');
  const live = html.slice(at, html.indexOf('});', at)).replace(/\/\/[^\n]*/g, '');
  assert.match(live, /if \(isPasswordToggle\(e\.target\)\) e\.preventDefault\(\);/,
    'the wiring is exactly the tested predicate guarding the one call that keeps focus');
});

test('the reveal button carries its own CSS: one icon at a time, and text kept off it', () => {
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.match(style, /\.pw-toggle\s*\{[^}]*position:\s*absolute/,
    'the button is laid over the field, not stacked after it');
  assert.match(style, /\.field-password\s+\.field\s*\{[^}]*padding-right:\s*\d+px/,
    'without the padding a long password runs under the icon');
  // the wrapper stands in for the field it wraps, so the row rhythm has to be
  // one value — restated literally, the password row drifts when .field moves
  // the token itself, not just the two references: undeclared, var() falls back
  // to nothing and every field in the form loses its spacing silently
  assert.match(style, /:root\s*\{[^}]*--field-gap:\s*\d+px/, 'the rhythm is declared');
  assert.match(style, /\.field\s*\{[^}]*margin-bottom:\s*var\(--field-gap\)/);
  assert.match(style, /\.field-password\s*\{[^}]*margin-bottom:\s*var\(--field-gap\)/);
  assert.match(style, /\.pw-toggle\[aria-pressed="false"\]\s+\.icon-eye-off\s*,\s*\.pw-toggle\[aria-pressed="true"\]\s+\.icon-eye\s*\{[^}]*display:\s*none/,
    'the pressed state is what picks the icon — without this rule both show at once');
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
  // the reveal toggle is the first button in the form now, so a bare
  // querySelector('button') disables the eye and leaves sign-in double-tappable
  assert.doesNotMatch(live, /querySelector\('button'\)/,
    'the guard must name the submit button, not take whichever button comes first');
  assert.match(live, /querySelector\('button\[type="submit"\]'\)\.disabled = true/);
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
// node clock skew rejects a fresh token before the query runs — one delayed
// re-run must absorb it (seen live on first production sign-in)

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
  // real taxonomy: an expired JWT is ALSO PGRST303 — only the message
  // separates it from skew, so it must take the no-retry path
  db.client = fakeRetryClient([{ code: 'PGRST303', message: 'JWT expired' }]);
  const delays = await withInstantTimers(async () => {
    await assert.rejects(db.seedStaples('u1'), (err) => err.message === 'JWT expired');
  });
  assert.equal(db.client.counter.attempts, 1);
  assert.equal(delays.length, 0, 'no delay may be scheduled for an expired token');

  db.client = fakeRetryClient([{ code: '42501', message: 'permission denied for table staples' }]);
  const delays2 = await withInstantTimers(async () => {
    await assert.rejects(db.seedStaples('u1'), (err) => err.code === '42501');
  });
  assert.equal(db.client.counter.attempts, 1);
  assert.equal(delays2.length, 0, 'no delay may be scheduled for a non-JWT error');
});

// ── editable lunch: template + glue ────────────────────────────────────
test('the menu board renders every lunch as an input: override escaped into value, default in placeholder', async () => {
  const domStart = html.indexOf('const DAY_KEYS');
  const domEnd = html.lastIndexOf('/* =', html.indexOf('5. DATA LAYER'));
  const wkStart = html.indexOf('function viewWeek');
  const wkEnd = html.indexOf('/* ---------- Budget');
  assert.ok(domStart > 0 && domEnd > domStart, 'domain slice markers found in index.html');
  assert.ok(wkStart > 0 && wkEnd > wkStart, 'viewWeek markers found in index.html');
  const ids = (n, p) => Array.from({ length: n }, (_, i) => p + i);
  const days = {};
  ids(7, '').forEach((_, i) => {
    days[['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][i]] = { breakfast: 'b' + i, dinner: 'm' + i };
  });
  days.tue.lunch = '<b>Left"over</b>';       // hostile text must land escaped in the attribute
  const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(`
    ${html.slice(domStart, domEnd)}
    const state = { lifted: null, week: {
      picks: { mains: ${JSON.stringify(ids(7, 'm'))}, breakfasts: ${JSON.stringify(ids(7, 'b'))} },
      days: ${JSON.stringify(days)},
    } };
    const mealName = (id) => id ? 'MEAL-' + id : '—';
    ${html.slice(wkStart, wkEnd)}
    export { viewWeek };`));
  const out = mod.viewWeek();
  assert.match(out, /value="&lt;b&gt;Left&quot;over&lt;\/b&gt;"/, 'override is emitted AND attribute-escaped');
  assert.match(out, /placeholder="MEAL-m1 — from Tuesday&#39;s pot"/, 'default lunch lives in the placeholder');
  assert.match(out, /placeholder="Add a lunch"/, 'Monday has no default but still takes a lunch');
  assert.equal(out.match(/data-change="lunch"/g)?.length, 7, 'all seven days are editable');
});

test('the locked menu lists what is already picked, in pick order, names escaped', async () => {
  const domStart = html.indexOf('const DAY_KEYS');
  const domEnd = html.lastIndexOf('/* =', html.indexOf('5. DATA LAYER'));
  const wkStart = html.indexOf('function viewWeek');
  const wkEnd = html.indexOf('/* ---------- Budget');
  assert.ok(domStart > 0 && domEnd > domStart, 'domain slice markers found in index.html');
  assert.ok(wkStart > 0 && wkEnd > wkStart, 'viewWeek markers found in index.html');
  const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(`
    ${html.slice(domStart, domEnd)}
    const state = { lifted: null, week: {
      picks: { mains: ['m2', 'm1'], breakfasts: [] }, days: {},
    } };
    const mealName = (id) => id === 'm1' ? '<b>Hot & Sour</b>' : 'MEAL-' + id;
    ${html.slice(wkStart, wkEnd)}
    export { viewWeek };`));
  const out = mod.viewWeek();
  assert.match(out, /Mains 2\/7 · Breakfasts 0\/7/, 'the counts stay');
  // pick order preserved: m2 was picked first, so it leads the list
  assert.match(out, /<li>MEAL-m2<\/li>\s*<li>&lt;b&gt;Hot &amp; Sour&lt;\/b&gt;<\/li>/,
    'names appear in pick order AND html-escaped');
  assert.match(out, /<p class="picked-title">Mains<\/p>/);
  assert.doesNotMatch(out, /<p class="picked-title">Breakfasts<\/p>/,
    'an empty category shows no heading over nothing');
});

test('the locked menu offers Save menu once something is picked; a confirmed menu opens the board', async () => {
  const domStart = html.indexOf('const DAY_KEYS');
  const domEnd = html.lastIndexOf('/* =', html.indexOf('5. DATA LAYER'));
  const wkStart = html.indexOf('function viewWeek');
  const wkEnd = html.indexOf('/* ---------- Budget');
  assert.ok(domStart > 0 && domEnd > domStart, 'domain slice markers found in index.html');
  assert.ok(wkStart > 0 && wkEnd > wkStart, 'viewWeek markers found in index.html');
  const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(`
    ${html.slice(domStart, domEnd)}
    const state = { lifted: null, week: { picks: { mains: ['m1'], breakfasts: [] }, days: {} } };
    const mealName = (id) => id ? 'MEAL-' + id : '—';
    ${html.slice(wkStart, wkEnd)}
    export { viewWeek, state };`));
  // one pick is enough for the offer
  let out = mod.viewWeek();
  assert.match(out, /week-locked/);
  assert.match(out, /data-action="save-menu"/, 'a partial week can be declared done');
  // nothing picked — nothing to build
  mod.state.week.picks = { mains: [], breakfasts: [] };
  assert.doesNotMatch(mod.viewWeek(), /data-action="save-menu"/, 'an empty week offers nothing to save');
  // a confirmed week emptied of picks re-locks — the flag alone builds nothing
  mod.state.week.picks = { mains: [], breakfasts: [], confirmed: true };
  assert.match(mod.viewWeek(), /week-locked/, 'clearing every pick revokes the confirm');
  // confirmed: the board opens with the picks it has, empty slots stay open
  mod.state.week.picks = { mains: ['m1'], breakfasts: ['b1'], confirmed: true };
  mod.state.week.days = { mon: { breakfast: 'b1', dinner: 'm1' } };
  out = mod.viewWeek();
  assert.doesNotMatch(out, /week-locked/, 'the confirmed menu is not locked');
  assert.match(out, /This week's menu/);
  assert.match(out, /MEAL-m1/);
  assert.match(out, /<span class="meal">—<\/span>/, 'an unfilled slot renders open, not broken');
});

test('the save-menu action asks first, then flips the flag and schedules a save', () => {
  const hStart = html.indexOf("'save-menu':");
  const hEnd = html.indexOf("'open-add':", hStart);
  assert.ok(hStart > 0 && hEnd > hStart, 'save-menu handler markers found in index.html');
  const live = html.slice(hStart, hEnd)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.match(live, /if \(!\(await confirmSheet\([\s\S]*?\)\)\) return;/,
    'committing a partial menu is a question, and no answers change nothing');
  assert.match(live, /picks\.confirmed = true/);
  assert.match(live, /scheduleSave\(\);\s*render\(\);/, 'the flag rides the normal save pipeline');
});

test('the lunch change glue trims typed text and deletes the override when emptied', () => {
  const hStart = html.indexOf("if (el.dataset.change === 'lunch')");
  const hEnd = html.indexOf("document.addEventListener('submit'");
  assert.ok(hStart > 0 && hEnd > hStart, 'lunch handler markers found in index.html');
  const live = html.slice(hStart, hEnd)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.match(live, /el\.value\.trim\(\)/);
  assert.match(live, /delete day\.lunch/, 'an emptied field must fall back to the default, not store ""');
  assert.match(live, /scheduleSave\(\)/);
});

// ── meal photo upload ──────────────────────────────────────────────────
function fakeStorageClient({ failWith = null } = {}) {
  const uploads = [];
  const removed = [];
  return {
    uploads,
    removed,
    storage: {
      from: (bucket) => ({
        upload: async (path, blob, opts) => {
          uploads.push({ bucket, path, blob, opts });
          return failWith ? { data: null, error: failWith } : { data: { path }, error: null };
        },
        remove: async (paths) => { removed.push({ bucket, paths }); return { data: null, error: null }; },
        // the URL shape supabase-js actually returns — the round-trip test
        // below pins that removeMealImage's parsing agrees with it
        getPublicUrl: (path) => ({ data: { publicUrl: `https://x.supabase.co/storage/v1/object/public/${bucket}/${path}` } }),
      }),
    },
  };
}

test('uploadMealImage stores a jpeg in meal-images and returns its public url', async () => {
  db.client = fakeStorageClient();
  const blob = { size: 42000 };
  const url = await db.uploadMealImage(blob);
  const [up] = db.client.uploads;
  assert.equal(db.client.uploads.length, 1);
  assert.equal(up.bucket, 'meal-images');
  assert.match(up.path, /^[0-9a-f-]{36}\.jpg$/, 'object name is a uuid, never the user filename');
  assert.equal(up.blob, blob);
  assert.equal(up.opts.contentType, 'image/jpeg');
  assert.equal(url, `https://x.supabase.co/storage/v1/object/public/meal-images/${up.path}`);
});

test('a public url from uploadMealImage round-trips through removeMealImage to the same object', async () => {
  db.client = fakeStorageClient();
  const url = await db.uploadMealImage({});
  await db.removeMealImage(url);
  assert.equal(db.client.removed.length, 1);
  assert.deepEqual(db.client.removed[0].paths, [db.client.uploads[0].path]);
});

test('removeMealImage refuses a url it cannot parse instead of silently doing nothing', async () => {
  db.client = fakeStorageClient();
  await assert.rejects(db.removeMealImage('https://elsewhere.example/foo.jpg'), /not a meal-images/);
  assert.equal(db.client.removed.length, 0);
});

// only a PostgREST-shaped code proves the server answered — postgrest-js
// forwards transport errors' own codes, so truthy is not enough
test('isServerRejection accepts only PostgREST-shaped codes', () => {
  assert.equal(isServerRejection({ code: 'PGRST301' }), true);
  assert.equal(isServerRejection({ code: '23505' }), true);      // SQLSTATE from a constraint
  assert.equal(isServerRejection({ code: '42501' }), true);      // SQLSTATE from RLS
  // forwarded transport codes, all unknowns — the row may have been written:
  assert.equal(isServerRejection({ code: '', message: 'TypeError: Failed to fetch' }), false);
  assert.equal(isServerRejection({ code: '20', message: 'AbortError: signal is aborted' }), false);
  assert.equal(isServerRejection({ code: 20 }), false, 'a non-string code is never a PostgREST answer');
  assert.equal(isServerRejection(new TypeError('Failed to fetch')), false);
  assert.equal(isServerRejection(undefined), false);
});

test('uploadMealImage generates a fresh path per call — a retried upload cannot collide', async () => {
  db.client = fakeStorageClient();
  await db.uploadMealImage({});
  await db.uploadMealImage({});
  const [a, b] = db.client.uploads;
  assert.notEqual(a.path, b.path);
});

test('uploadMealImage surfaces storage failures', async () => {
  db.client = fakeStorageClient({ failWith: { message: 'Payload too large' } });
  await assert.rejects(db.uploadMealImage({}), (err) => err.message === 'Payload too large');
});

test('the add-meal sheet offers a labelled file upload, not a URL field, and re-emits a kept name escaped', async () => {
  const tmplStart = html.indexOf('function viewAddSheet');
  const tmplEnd = html.indexOf('/* ---------- Week');
  assert.ok(tmplStart > 0 && tmplEnd > tmplStart, 'add-sheet markers found in index.html');
  const escStart = html.indexOf('const esc =');
  const escEnd = html.indexOf('[c]));', escStart);
  const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(
    `const state = { errorMsg: '', addName: 'Kept <name>' };
     ${html.slice(escStart, escEnd + '[c]));'.length)}
     ${html.slice(tmplStart, tmplEnd)}
     export { viewAddSheet };`));
  const out = mod.viewAddSheet('main');
  assert.match(out, /role="dialog" aria-modal="true"/, 'the sheet declares the modality inert enforces');
  assert.match(out, /type="file"/);
  assert.match(out, /accept="image\/\*"/);
  assert.match(out, /Photo \(optional\)/, 'the hint is visible text, not only an aria-label');
  assert.match(out, /value="Kept &lt;name&gt;"/, 'a failed add keeps the typed name, escaped');
  assert.doesNotMatch(out, /type="url"/, 'the pasted-URL field is gone');
});

test('the add-meal submit glue nests the calls: upload takes the resized file, failure keeps the name and reclaims the upload', () => {
  const hStart = html.indexOf("if (form.id === 'form-addmeal')");
  const hEnd = html.indexOf("if (form.id === 'form-additem')");
  assert.ok(hStart > 0 && hEnd > hStart, 'add-meal handler markers found in index.html');
  const live = html.slice(hStart, hEnd)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  // uploadPhoto pins the order (upload receives resizeImage's awaited result)
  // and puts the decode inside the promise the ceiling bounds
  assert.match(live, /await withCeiling\(uploadPhoto\(file\)\)/);
  assert.match(live, /db\.addMeal\(/);
  assert.match(live, /state\.addName = name/, 'a failed add must keep the typed name');
  // reclaim is gated on a structured rejection: a network unknown may mean
  // the row WAS written, and deleting then breaks a live meal's image
  assert.match(live, /if \(image_url && isServerRejection\(err\)\)/, 'reclaim must go through the tested discriminator');
  assert.match(live, /db\.removeMealImage\(image_url\)/, 'a failed add must reclaim its upload');
  assert.match(live, /console\.info\('meal image kept/, 'a kept-unknown object goes on the record');
});

test('removeMealImage deletes the object named by its public url', async () => {
  const removed = [];
  db.client = { storage: { from: (bucket) => ({
    remove: async (paths) => { removed.push({ bucket, paths }); return { data: null, error: null }; },
  }) } };
  await db.removeMealImage('https://x.supabase.co/storage/v1/object/public/meal-images/abc-123.jpg');
  assert.deepEqual(removed, [{ bucket: 'meal-images', paths: ['abc-123.jpg'] }]);
});

// ── resizeImage ────────────────────────────────────────────────────────
// Stub the canvas world: createImageBitmap decodes to a fixed size, the
// canvas records its dimensions and toBlob arguments.
async function withCanvasWorld({ w, h, blob = { type: 'image/jpeg' } }, run) {
  const world = { canvas: null, toBlobArgs: null, closed: false, decoded: 0 };
  globalThis.createImageBitmap = async () => {
    world.decoded++;
    return { width: w, height: h, close: () => { world.closed = true; } };
  };
  document.createElement = () => (world.canvas = {
    width: 0, height: 0,
    getContext: () => ({ drawImage: () => {} }),
    toBlob: (cb, type, quality) => { world.toBlobArgs = { type, quality }; cb(blob); },
  });
  try { await run(world); } finally {
    delete globalThis.createImageBitmap;
    delete document.createElement;
  }
  return world;
}

test('resizeImage scales a standard photo to the 400×300 pixel budget', async () => {
  await withCanvasWorld({ w: 800, h: 600 }, async (world) => {
    const out = await resizeImage({ size: 1000 });
    assert.equal(world.canvas.width, 400);
    assert.equal(world.canvas.height, 300);
    assert.equal(world.toBlobArgs.type, 'image/jpeg');
    assert.equal(out.type, 'image/jpeg');
    assert.ok(world.closed, 'bitmap memory is released');
  });
});

test('resizeImage holds extreme aspect ratios to the same pixel budget', async () => {
  await withCanvasWorld({ w: 600, h: 6000 }, async (world) => {
    await resizeImage({ size: 1000 });
    const { width, height } = world.canvas;
    assert.ok(width * height <= 400 * 300 * 1.02, `a tall screenshot must fit the budget (got ${width}×${height})`);
    assert.ok(Math.abs(height / width - 10) < 0.2, 'aspect ratio is preserved');
    assert.ok(width < 400, 'the budget, not the width, is the bound');
  });
});

test('resizeImage never upscales a small image', async () => {
  await withCanvasWorld({ w: 300, h: 200 }, async (world) => {
    await resizeImage({ size: 1000 });
    assert.equal(world.canvas.width, 300);
    assert.equal(world.canvas.height, 200);
  });
});

test('resizeImage rejects a >20MB file before decoding it', async () => {
  const world = await withCanvasWorld({ w: 800, h: 600 }, async () => {
    await assert.rejects(resizeImage({ size: 21 * 1024 * 1024 }), /too large/);
  });
  assert.equal(world.decoded, 0, 'the oversized file must never reach createImageBitmap');
});

test('resizeImage refuses a >50MP decode before allocating a canvas for it', async () => {
  await withCanvasWorld({ w: 10000, h: 6000 }, async (world) => {
    await assert.rejects(resizeImage({ size: 1000 }), /megapixels/);
    assert.equal(world.canvas, null, 'no canvas is created for a refused image');
    assert.ok(world.closed, 'the decoded bitmap is still released');
  });
});

test('resizeImage fails loudly when the canvas cannot encode', async () => {
  await withCanvasWorld({ w: 800, h: 600, blob: null }, async () => {
    await assert.rejects(resizeImage({ size: 1000 }), /process/);
  });
});

test('viewPick renders a live image and degrades a dead-flagged one to its tinted tile', async () => {
  const tmplStart = html.indexOf('function viewPick');
  const tmplEnd = html.indexOf('function viewAddSheet');
  assert.ok(tmplStart > 0 && tmplEnd > tmplStart, 'viewPick markers found in index.html');
  const escStart = html.indexOf('const esc =');
  const escEnd = html.indexOf('[c]));', escStart);
  const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(
    `const PICK_TARGET = 7;
     const TINTS = ['#111'];
     const KIND_FOR_TAB = { mains: 'main', breakfasts: 'breakfast' };
     const state = { pickTab: 'mains', addOpen: false,
       week: { picks: { mains: [], breakfasts: [] } },
       meals: [
         { id: 'm1', kind: 'main', name: 'Alive', tint: '#123', image_url: 'https://x/live.jpg' },
         { id: 'm2', kind: 'main', name: 'Gone', tint: '#123', image_url: 'https://x/dead.jpg', imageDead: true },
       ] };
     ${html.slice(escStart, escEnd + '[c]));'.length)}
     ${html.slice(tmplStart, tmplEnd)}
     export { viewPick };`));
  const out = mod.viewPick();
  assert.match(out, /src="https:\/\/x\/live\.jpg"/);
  assert.doesNotMatch(out, /dead\.jpg/, 'a dead-flagged image must not be re-requested on re-render');
  assert.match(out, /Gone/, 'the degraded card still shows its name tile');
});

test('markDeadImage flags the meal, removes the face and its shade by name, ignores non-card errors', () => {
  state.meals = [{ id: 'm1', name: 'Steak', image_url: 'https://x/dead.jpg' }];
  const removed = [];
  const shade = { remove: () => removed.push('shade') };
  const img = {
    tagName: 'IMG',
    closest: (sel) => (sel === '.meal-card[data-id]' ? { dataset: { id: 'm1' } } : null),
    parentElement: { querySelector: (sel) => (sel === '.shade' ? shade : null) },
    remove: () => removed.push('img'),
  };
  assert.equal(markDeadImage(img), true);
  assert.equal(state.meals[0].imageDead, true);
  assert.deepEqual(removed, ['shade', 'img'], 'exactly the shade and the image — never "whatever follows"');

  state.meals = [{ id: 'm1' }];
  assert.equal(markDeadImage({ tagName: 'SCRIPT' }), false, 'non-image errors are ignored');
  assert.equal(markDeadImage({ tagName: 'IMG', closest: () => null }), false, 'images outside meal cards are ignored');
  assert.equal(state.meals[0].imageDead, undefined);
});

test('reviveDeadImages clears every dead flag and reports whether any were set', () => {
  state.meals = [{ id: 'a', imageDead: true }, { id: 'b' }, { id: 'c', imageDead: true }];
  assert.equal(reviveDeadImages(), true);
  assert.ok(state.meals.every((m) => !('imageDead' in m)));
  assert.equal(reviveDeadImages(), false, 'nothing to revive → no render needed');
});

test('the image-error and online wiring: capture phase, and recovery on connectivity', () => {
  const errStart = html.indexOf("document.addEventListener('error'");
  assert.ok(errStart > 0, 'error listener found in index.html');
  const errEnd = html.indexOf(', true);', errStart);
  assert.ok(errEnd > errStart && errEnd - errStart < 200,
    'the error listener must end in capture phase — error events do not bubble');
  assert.match(html.slice(errStart, errEnd), /markDeadImage\(e\.target\)/);

  const onStart = html.indexOf("window.addEventListener('online'");
  const onEnd = html.indexOf('});', onStart);
  assert.ok(onStart > 0 && onEnd > onStart, 'online listener found in index.html');
  const onLive = html.slice(onStart, onEnd)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.match(onLive, /reviveDeadImages\(\)/, 'coming back online must give dead images another chance');
});

// ── save-the-week & history ────────────────────────────────────────────
// fake for every weeks-table path performSaveWeek exercises; `log` records
// the operation order
function fakeWeeksReader({ latest = null, saved = [], failWith = null, failSelect = false,
                           failStatusUpdate = false, flipZeroRows = false, delayMs = 0, hang = 0 } = {}) {
  const inserts = [];
  const filters = [];
  const log = [];
  const hung = [];
  let hangsLeft = hang;
  return {
    inserts,
    filters,
    log,
    // completes any requests parked by `hang`, so a test can drain its own timers
    release: () => hung.splice(0).forEach((f) => f()),
    from() {
      const q = { op: 'select', payload: null, statusEq: false };
      const b = {
        select: () => b, maybeSingle: () => b, single: () => b,
        limit: (n) => { filters.push(['limit', n]); return b; },
        eq: (col, val) => { if (col === 'status') q.statusEq = true; filters.push(['eq', col, val]); return b; },
        order: (col, opts) => { filters.push(['order', col, opts?.ascending]); return b; },
        insert(payload) { q.op = 'insert'; inserts.push(payload); return b; },
        update(payload) { q.op = 'update'; q.payload = payload; return b; },
        async then(resolve) {
          if (delayMs) await sleep(delayMs);
          log.push(q.op === 'update' ? (q.payload?.status ? 'flip-status' : 'flush-week') : q.op);
          if (hangsLeft > 0) {
            hangsLeft--;
            hung.push(() => resolve({ data: [{ id: 'w1' }], error: null }));
            return;
          }
          if (failWith) return resolve({ data: null, error: failWith });
          if (q.op === 'update') {
            if (q.payload?.status && failStatusUpdate) return resolve({ data: null, error: failStatusUpdate });
            if (q.payload?.status && flipZeroRows) return resolve({ data: [], error: null });
            return resolve({ data: [{ id: 'w1' }], error: null });
          }
          if (q.op === 'insert') {
            return resolve({ data: { id: 'new-week', status: 'draft', ...inserts[inserts.length - 1] }, error: null });
          }
          if (failSelect) return resolve({ data: null, error: { message: 'select refused' } });
          resolve({ data: q.statusEq ? saved : latest, error: null });
        },
      };
      return b;
    },
  };
}

test('loadActiveWeek resumes the newest draft no matter how stale', async () => {
  const draft = { id: 'w9', status: 'draft', week_start: '2026-06-01' };
  db.client = fakeWeeksReader({ latest: draft });
  assert.equal(await db.loadActiveWeek('u1', '2026-08-03'), draft);
  assert.equal(db.client.inserts.length, 0, 'an old draft is resumed, never replaced');
  // "the newest row" is a query shape, not an accident of the fake
  assert.deepEqual(db.client.filters, [['order', 'week_start', false], ['limit', 1]]);
});

test('loadActiveWeek after a mid-week save starts the following Monday', async () => {
  db.client = fakeWeeksReader({ latest: { id: 'w1', status: 'saved', week_start: '2026-08-03' } });
  const week = await db.loadActiveWeek('u1', '2026-08-03');
  assert.deepEqual(db.client.inserts, [{ user_id: 'u1', week_start: '2026-08-10' }]);
  assert.equal(week.id, 'new-week');
});

test('loadActiveWeek after a stale save jumps to the current Monday', async () => {
  db.client = fakeWeeksReader({ latest: { id: 'w1', status: 'saved', week_start: '2026-07-06' } });
  await db.loadActiveWeek('u1', '2026-08-03');
  assert.deepEqual(db.client.inserts, [{ user_id: 'u1', week_start: '2026-08-03' }]);
});

test('loadActiveWeek with no weeks at all starts the current Monday', async () => {
  db.client = fakeWeeksReader({ latest: null });
  await db.loadActiveWeek('u1', '2026-08-03');
  assert.deepEqual(db.client.inserts, [{ user_id: 'u1', week_start: '2026-08-03' }]);
});

test('markWeekSaved flips exactly the status, and flags a vanished row as a known condition', async () => {
  db.client = fakeWeeksClient();
  await db.markWeekSaved('w1');
  assert.deepEqual(db.client.ops('update')[0].payload, { status: 'saved' });

  db.client = fakeWeeksClient({ matchedRows: [] });
  await assert.rejects(db.markWeekSaved('w1'), (err) => err.weekRowGone === true);
});

test('listSavedWeeks asks for saved rows newest first', async () => {
  const rows = [{ id: 'a', week_start: '2026-08-03' }];
  db.client = fakeWeeksReader({ saved: rows });
  assert.equal(await db.listSavedWeeks(), rows);
  assert.deepEqual(db.client.filters, [['eq', 'status', 'saved'], ['order', 'week_start', false]]);
});

test('performSaveWeek runs flush, status flip, next draft — in that order', async () => {
  state.session = { user: { id: 'u1' } };
  state.history = [{ id: 'stale' }];
  db.client = fakeWeeksReader({ latest: { id: 'w1', status: 'saved', week_start: '2026-08-03' } });
  assert.equal((await performSaveWeek('2026-08-03')).outcome, 'done');
  assert.deepEqual(db.client.log, ['flush-week', 'flip-status', 'select', 'insert'],
    'reordering the flow is a different flow');
  assert.equal(state.week.week_start, '2026-08-10'); // computed by nextDraftStart, not the fake
  assert.equal(state.week.id, 'new-week');
  assert.equal(state.history, null, 'the cached list no longer has the newest week');
});

test('performSaveWeek refuses to freeze a week whose sync failed', async () => {
  state.session = { user: { id: 'u1' } };
  db.client = fakeWeeksReader({ failWith: { message: 'down' } });
  assert.equal((await performSaveWeek('2026-08-03')).outcome, 'dirty');
  assert.ok(!db.client.log.includes('flip-status'), 'stale data must never become the record');
  assert.equal(state.saveStatus, 'error');
});

test('performSaveWeek waits out an in-flight flush AND its deferred re-queue before flipping', async () => {
  state.session = { user: { id: 'u1' } };
  db.client = fakeWeeksReader({ latest: { id: 'w1', status: 'saved', week_start: '2026-08-03' }, delayMs: 40 });
  scheduleSave();                          // status → 'saving', debounce armed
  const inflight = flushSave();            // consumes the debounce; pipeline mid-flight
  const result = await performSaveWeek('2026-08-03');
  await inflight;
  assert.equal(result.outcome, 'done', 'a healthy pipeline mid-flush is not a dirty week');
  const lastFlush = db.client.log.lastIndexOf('flush-week');
  assert.ok(db.client.log.filter((op) => op === 'flush-week').length >= 2,
    'the deferred re-queue ran — the wait loop was genuinely entered');
  assert.ok(db.client.log.indexOf('flip-status') > lastFlush, 'the flip waits for full quiescence');
});

test('a pipeline that ends in error while save-week waits still reports dirty', async () => {
  state.session = { user: { id: 'u1' } };
  db.client = fakeWeeksReader({ failWith: { message: 'down' }, delayMs: 40 });
  scheduleSave();
  const inflight = flushSave();
  const result = await performSaveWeek('2026-08-03');
  await inflight;
  assert.equal(result.outcome, 'dirty');
  assert.ok(!db.client.log.includes('flip-status'));
  await sleep(250); // let the deferred re-queue fire and fail against our own fake
});

test('the quiescence wait has a ceiling — a hung pipeline exits dirty with an honest status', async () => {
  state.session = { user: { id: 'u1' } };
  db.client = fakeWeeksReader({ latest: { id: 'w1', status: 'saved', week_start: '2026-08-03' }, hang: 1 });
  scheduleSave();                          // status → 'saving'
  const inflight = flushSave();            // hangs until release()
  state.saveErrorPermanent = true;         // last observed failure was permanent
  const result = await performSaveWeek('2026-08-03', 120);
  assert.equal(result.outcome, 'dirty');
  assert.equal(state.saveStatus, 'error', 'the chip must not read "Saving" forever');
  assert.equal(state.saveErrorPermanent, true, 'the ceiling reports staleness, it does not invent a failure class');
  assert.ok(!db.client.log.includes('flip-status'));
  // a re-entry while the request is still hung must exit at once, not
  // freeze the screen for another full ceiling
  const t0 = Date.now();
  assert.equal((await performSaveWeek('2026-08-03', 5000)).outcome, 'dirty');
  assert.ok(Date.now() - t0 < 1000, 'no second full-ceiling wait');
  db.client.release();                     // un-hang, then drain our own timers
  await inflight;
  await sleep(300);
});

test('after a vanished row, a retry restores it via the flush self-heal and then freezes it', async () => {
  state.session = { user: { id: 'u1' } };
  // row vanishes between first flush and first flip; the retry's flush
  // self-heals by upsert and the flip lands on the restored row
  let exists = true;
  let flips = 0;
  const log = [];
  db.client = { from() {
    const q = { op: 'select', payload: null, opts: null };
    const b = {
      select: () => b, maybeSingle: () => b, single: () => b, limit: () => b,
      order: () => b, eq: () => b,
      insert: (p) => { q.op = 'insert'; q.payload = p; return b; },
      update: (p) => { q.op = 'update'; q.payload = p; return b; },
      upsert: (p, o) => { q.op = 'upsert'; q.payload = p; q.opts = o; return b; },
      then(resolve) {
        const isFlip = q.op === 'update' && q.payload?.status === 'saved';
        log.push(isFlip ? 'flip' : q.op);
        if (isFlip) {
          flips++;
          if (flips === 1) { exists = false; return void resolve({ data: [], error: null }); }
          return void resolve({ data: exists ? [{ id: state.week.id }] : [], error: null });
        }
        if (q.op === 'update') return void resolve({ data: exists ? [{ id: state.week.id }] : [], error: null });
        if (q.op === 'upsert') { exists = true; return void resolve({ data: { id: 'w-restored' }, error: null }); }
        if (q.op === 'insert') return void resolve({ data: { id: 'w-next', status: 'draft', ...q.payload }, error: null });
        return void resolve({ data: { id: 'w-restored', status: 'saved', week_start: state.week.week_start }, error: null });
      },
    };
    return b;
  } };
  const first = await performSaveWeek('2026-08-03');
  assert.equal(first.outcome, 'save-failed');
  assert.equal(first.error.weekRowGone, true);
  const second = await performSaveWeek('2026-08-03');
  assert.equal(second.outcome, 'done', 'the advice "retrying restores it" is true end to end');
  assert.ok(log.includes('upsert'), 'the self-heal actually ran');
  assert.equal(state.week.id, 'w-next', 'and the flow finished on a fresh draft');
});

test('a REJECTED status flip (coded) changes nothing and reports save-failed with the reason', async () => {
  state.session = { user: { id: 'u1' } };
  db.client = fakeWeeksReader({ failStatusUpdate: { code: '42501', message: 'permission denied' } });
  const { outcome, error } = await performSaveWeek('2026-08-03');
  assert.equal(outcome, 'save-failed');
  assert.equal(error.message, 'permission denied', 'the reason survives to the caller');
  assert.equal(state.week.status, 'draft');
  assert.equal(db.client.inserts.length, 0);
});

test('an UNKNOWN flip outcome (no code) reports save-unknown — the row may be frozen', async () => {
  state.session = { user: { id: 'u1' } };
  db.client = fakeWeeksReader({ failStatusUpdate: { message: 'TypeError: Failed to fetch' } });
  assert.equal((await performSaveWeek('2026-08-03')).outcome, 'save-unknown');
  assert.equal(db.client.inserts.length, 0, 'no next draft on an unconfirmed save');
});

test('a vanished row is a KNOWN outcome: save-failed, flagged, and retryable', async () => {
  state.session = { user: { id: 'u1' } };
  db.client = fakeWeeksReader({ flipZeroRows: true });
  const { outcome, error } = await performSaveWeek('2026-08-03');
  assert.equal(outcome, 'save-failed', 'PostgREST answered — nothing about this is unknowable');
  assert.equal(error.weekRowGone, true);
  assert.match(error.message, /retrying restores it/, 'the advice is true: the flush self-heal recreates the row');
});

test('a failed next-draft load still flips memory to saved — the record cannot resurrect as a draft', async () => {
  state.session = { user: { id: 'u1' } };
  db.client = fakeWeeksReader({ failSelect: true });
  const frozen = state.week;
  assert.equal((await performSaveWeek('2026-08-03')).outcome, 'load-failed');
  // the self-heal upsert writes week.status verbatim — this is what stops it
  // un-saving the record if the frozen row ever needs restoring
  assert.equal(frozen.status, 'saved');
  assert.equal(state.week, frozen, 'no half-initialized draft is installed');
  assert.equal(state.history, null);
});

test('performSaveWeek is single-flight: the second tap of a double-tap is busy', async () => {
  state.session = { user: { id: 'u1' } };
  db.client = fakeWeeksReader({ latest: { id: 'w1', status: 'saved', week_start: '2026-08-03' }, delayMs: 25 });
  const [first, second] = await Promise.all([performSaveWeek('2026-08-03'), performSaveWeek('2026-08-03')]);
  assert.equal(first.outcome, 'done');
  assert.equal(second.outcome, 'busy');
  assert.equal(db.client.inserts.length, 1, 'exactly one next draft, no unique-key collision');
});

test('the save-week action gates the UI for the duration and maps every outcome', () => {
  const hStart = html.indexOf("'save-week':");
  const hEnd = html.indexOf("'retry-history':");
  assert.ok(hStart > 0 && hEnd > hStart, 'save-week handler markers found in index.html');
  const live = html.slice(hStart, hEnd)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.match(live, /if \(saveWeekBusy\(\)\) return/);
  // ordering pinned: busy exits before ANY mutation, loadingMsg included
  assert.match(live, /if \(outcome === 'busy'\) return;\s*state\.loadingMsg = ''/,
    'a busy outcome must precede every mutation of the running flow’s gate');
  // the lock: nothing is editable while the flow runs, so no debounced save
  // can fire into the frozen record...
  assert.match(live, /state\.phase = 'loading';\s*state\.loadingMsg = 'Saving the week…';\s*render\(\);\s*const \{ outcome, error \} = await performSaveWeek\(currentMonday\(\)\)/);
  // ...and every branch releases it: unknowable outcomes into the error
  // lock, everything else back to ready
  assert.match(live, /outcome === 'save-unknown' \|\| outcome === 'load-failed'\)[\s\S]{0,150}?state\.phase = 'error'/);
  // release is anchored ABOVE the done branch, so dirty and save-failed
  // inherit it — inside the done block it would leave the gate painted
  assert.match(live, /state\.phase = 'ready';\s*if \(outcome === 'done'\)/,
    'the gate must be released before the outcome fan-out');
  // messages are pinned INSIDE their branches — swapping them fails
  assert.match(live, /outcome === 'save-unknown'\s*\? "Couldn't confirm whether the week was saved/);
  assert.match(live, /: 'The week was saved, but starting the next one failed/);
  // dirty states the fact and nothing else — advice is the banner's job
  assert.match(live, /outcome === 'dirty'\)[\s\S]{0,160}?noticeSheet\([\s\S]{0,120}?The week wasn't saved/,
    'an explicitly invoked action must acknowledge its failure');
  assert.match(live, /outcome === 'save-failed'\)[\s\S]{0,160}?noticeSheet\([\s\S]{0,120}?error\?\.message/,
    'the rejection reason reaches the user');
  // done must not rely on a hashchange event that an equal hash never fires
  // — anchored to the done branch AND covering all four statements in order
  assert.match(live,
    /outcome === 'done'\)\s*\{[\s\S]{0,420}?state\.route = 'pick';\s*state\.historyDetail = null;\s*history\.replaceState\(null, '', '#\/pick'\);\s*render\(\)/,
    'navigation belongs to done alone; dirty and save-failed stay on Summary');
});

// ── history templates, executed with the real domain slice ────────────
const viewsStart = html.indexOf('function viewTotals');
const viewsEnd = html.indexOf('/* ---------- root');
assert.ok(viewsStart > 0 && viewsEnd > viewsStart, 'summary/history view markers found in index.html');
const domStart = html.indexOf('const DAY_KEYS');
const domEnd = html.lastIndexOf('/* =', html.indexOf('5. DATA LAYER'));
assert.ok(domStart > 0 && domEnd > domStart, 'domain slice markers found in index.html');
const viewsMod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(`
  ${html.slice(domStart, domEnd)}
  const state = { week: null, history: null, historyError: '', historyDetail: null };
  const mealName = (id) => id ? 'MEAL-' + id : '—';
  ${html.slice(viewsStart, viewsEnd)}
  export { state as vstate, viewSummary, viewHistory, viewHistoryDetail };`));

const fullWeek = (over = {}) => {
  const ids = (n, p) => Array.from({ length: n }, (_, i) => p + i);
  const days = {};
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].forEach((k, i) => {
    days[k] = { breakfast: 'b' + i, dinner: 'm' + i };
  });
  return {
    id: 'w1', week_start: '2026-07-27', budget: 1000, status: 'saved',
    picks: { mains: ids(7, 'm'), breakfasts: ids(7, 'b') }, days,
    groceries: [{ id: 'g1', name: 'Eggs', price: 300, checked: true }],
    ...over,
  };
};

test('the summary offers Save this week only once the menu is complete', () => {
  viewsMod.vstate.week = fullWeek({ status: 'draft' });
  assert.match(viewsMod.viewSummary(), /data-action="save-week"/);
  viewsMod.vstate.week = fullWeek({ status: 'draft', picks: { mains: [], breakfasts: [] } });
  assert.doesNotMatch(viewsMod.viewSummary(), /data-action="save-week"/, 'a barely-started week cannot be frozen');
});

test('a confirmed partial menu unlocks the summary board and its save button', () => {
  viewsMod.vstate.week = fullWeek({ status: 'draft', picks: { mains: ['m1'], breakfasts: [], confirmed: true } });
  const out = viewsMod.viewSummary();
  assert.match(out, /sum-board/, 'the board builds from what was picked');
  assert.match(out, /data-action="save-week"/, 'a confirmed partial week can be saved');
});

test('the summary grocery list is numbered, not a checklist', () => {
  viewsMod.vstate.week = fullWeek({
    status: 'draft',
    groceries: [
      { id: 'g1', name: 'Eggs', price: 300, checked: true },
      { id: 'g2', name: 'Milk', price: 120, checked: false },
    ],
  });
  const out = viewsMod.viewSummary();
  assert.doesNotMatch(out, /data-change="tick"/, 'no live checkboxes on the summary');
  assert.doesNotMatch(out, /is-checked/, 'a stale checked flag cannot strike items out');
  assert.match(out, /<span class="g-num">1\.<\/span>\s*<span class="g-name">Eggs/,
    'rows are numbered in list order');
  assert.match(out, /<span class="g-num">2\.<\/span>\s*<span class="g-name">Milk/);
});

test('the history list walks loading, empty, and rows states', () => {
  viewsMod.vstate.historyDetail = null;
  viewsMod.vstate.history = null;
  assert.match(viewsMod.viewHistory(), /Loading…/);
  viewsMod.vstate.history = [];
  assert.match(viewsMod.viewHistory(), /No saved weeks yet/);
  viewsMod.vstate.history = [fullWeek()];
  const out = viewsMod.viewHistory();
  assert.match(out, /href="#\/history\/2026-07-27"/);
  assert.match(out, /Week of 27 Jul 2026/);
  assert.match(out, /300 \/ 1,000/, 'spend against budget, at a glance');
});

test('the history detail is read-only and totals the week it shows', () => {
  viewsMod.vstate.history = [fullWeek()];
  viewsMod.vstate.historyDetail = '2026-07-27';
  const out = viewsMod.viewHistory();
  assert.match(out, /Week of 2026-07-27/);
  assert.match(out, /MEAL-m3/, 'the board resolves meal names');
  assert.doesNotMatch(out, /data-change="tick"/, 'no live checkboxes in a record');
  assert.doesNotMatch(out, /tick-static|is-checked/,
    'a legacy checked flag renders no tick column — the record is a list, not a worksheet');
  assert.match(out, /<span class="g-num">1\.<\/span>\s*<span class="g-name">Eggs/,
    'the record is numbered like the summary');
  assert.doesNotMatch(out, /data-action="save-week"/);
  assert.match(out, /KSh 700/, 'remaining is computed from THAT week');
  assert.match(out, /href="#\/history"/, 'a way back to the list');
  viewsMod.vstate.historyDetail = '1999-01-04';
  assert.match(viewsMod.viewHistory(), /No saved week for that date/);
});

// ── the request ceiling ────────────────────────────────────────────────

test('withCeiling rejects a request that never lands', async () => {
  const never = new Promise(() => {});
  await assert.rejects(withCeiling(never, 20), /took too long to answer/);
});

test('withCeiling passes a landed result straight through', async () => {
  assert.equal(await withCeiling(Promise.resolve('landed'), 20), 'landed');
  await assert.rejects(withCeiling(Promise.reject(new Error('refused')), 20), /refused/);
});

test('a request that lands cancels its ceiling timer instead of leaking it', async () => {
  const cleared = [];
  const realClear = globalThis.clearTimeout;
  globalThis.clearTimeout = (t) => { cleared.push(t); return realClear(t); };
  try {
    await withCeiling(Promise.resolve('landed'), 60_000);
  } finally {
    globalThis.clearTimeout = realClear;
  }
  assert.equal(cleared.length, 1, 'the pending ceiling is cleared, not abandoned to fire in a minute');
});

// a timed-out write is abandoned, not cancelled — the flag is what stops the
// caller from freeing the sheet for a second, racing write
test('a ceiling breach is flagged as an unknown outcome, an ordinary failure is not', async () => {
  const breach = await withCeiling(new Promise(() => {}), 20).catch((e) => e);
  assert.equal(breach.timedOut, true);
  const refusal = await withCeiling(Promise.reject(new Error('refused')), 20).catch((e) => e);
  assert.notEqual(refusal.timedOut, true);
});

test('the shipped ceiling is bounded and generous enough for a photo upload', () => {
  assert.ok(MEAL_REQUEST_CEILING_MS >= 5000 && MEAL_REQUEST_CEILING_MS <= 30000, 'a usable, finite ceiling');
});

test('uploadPhoto starts the resize inside the promise, so a ceiling can bound the decode', async () => {
  // the ceiling wraps uploadPhoto(file); if resize ran before the promise
  // existed, the slowest step on a phone would sit outside every bound
  const src = html.slice(html.indexOf('const uploadPhoto'), html.indexOf('// Supabase node clock skew'));
  assert.match(src, /const uploadPhoto = async \(file\) => db\.uploadMealImage\(await resizeImage\(file\)\)/);
  for (const site of ['form-addmeal', 'form-editmeal']) {
    const start = html.indexOf(`if (form.id === '${site}')`);
    const slice = html.slice(start, start + 1400);
    assert.match(slice, /await withCeiling\(uploadPhoto\(file\)\)/, `${site} bounds resize and upload together`);
    assert.doesNotMatch(slice, /withCeiling\(db\.uploadMealImage\(await resizeImage/,
      `${site} must not resolve the resize before the ceiling starts`);
  }
});

// ── meal editing & archiving ───────────────────────────────────────────

// meals-table fake: records update payloads and their filters
function fakeMealsTable({ rows = [{ id: 'm1', name: 'Steak' }], failWith = null } = {}) {
  const updates = [];
  return {
    updates,
    from() {
      const u = { payload: null, filters: [] };
      const b = {
        update(payload) { u.payload = payload; updates.push(u); return b; },
        eq(col, val) { u.filters.push([col, val]); return b; },
        select: () => b,
        async then(resolve) {
          resolve(failWith ? { data: null, error: failWith } : { data: rows, error: null });
        },
      };
      return b;
    },
  };
}

test('updateMeal writes exactly the given fields to the named meal and returns its row', async () => {
  db.client = fakeMealsTable({ rows: [{ id: 'm1', name: 'New name' }] });
  const row = await db.updateMeal('m1', { name: 'New name' });
  assert.deepEqual(db.client.updates[0].payload, { name: 'New name' });
  assert.deepEqual(db.client.updates[0].filters, [['id', 'm1']]);
  assert.equal(row.name, 'New name');
});

test('updateMeal reports a vanished meal in plain words, not a PostgREST shrug', async () => {
  db.client = fakeMealsTable({ rows: [] });
  await assert.rejects(db.updateMeal('m1', { archived: true }), /no longer exists/);
});

test('updateMeal surfaces server rejections', async () => {
  db.client = fakeMealsTable({ failWith: { code: '42501', message: 'RLS says no' } });
  await assert.rejects(db.updateMeal('m1', { name: 'X' }), (err) => err.code === '42501');
});

// archived meals must stay loaded: saved weeks resolve names through
// state.meals, so filtering them out of the query blanks past menus
function fakeLibraryClient({ meals = [], staples = [] } = {}) {
  const tables = {};
  return {
    tables,
    from(name) {
      const t = (tables[name] = { filters: [] });
      const rows = name === 'meals' ? meals : staples;
      const b = {
        select: () => b,
        eq: (col, val) => { t.filters.push(['eq', col, val]); return b; },
        order: (col, opts) => { t.filters.push(['order', col, opts?.ascending]); return b; },
        async then(resolve) { resolve({ data: rows, error: null }); },
      };
      return b;
    },
  };
}

test('loadLibrary returns archived meals too — history needs their names', async () => {
  const meals = [{ id: 'm1', archived: false }, { id: 'm2', archived: true }];
  db.client = fakeLibraryClient({ meals, staples: [{ id: 's1' }] });
  const lib = await db.loadLibrary();
  assert.deepEqual(lib.meals, meals);
  assert.deepEqual(db.client.tables.meals.filters, [['order', 'created_at', undefined]],
    'no archived filter in the query — hiding is the pick grid’s job');
});

test('viewPick moves archived meals to a restore list — unless they are still picked', async () => {
  const tmplStart = html.indexOf('function viewPick');
  const tmplEnd = html.indexOf('function viewAddSheet');
  assert.ok(tmplStart > 0 && tmplEnd > tmplStart, 'viewPick markers found in index.html');
  const escStart = html.indexOf('const esc =');
  const escEnd = html.indexOf('[c]));', escStart);
  const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(
    `const PICK_TARGET = 7;
     const TINTS = ['#111'];
     const KIND_FOR_TAB = { mains: 'main', breakfasts: 'breakfast' };
     const state = { pickTab: 'mains', addOpen: false, editId: null,
       week: { picks: { mains: ['m3'], breakfasts: [] } },
       meals: [
         { id: 'm1', kind: 'main', name: 'Alive', tint: '#123' },
         { id: 'm2', kind: 'main', name: 'Buried', tint: '#123', archived: true },
         { id: 'm3', kind: 'main', name: 'Stuck', tint: '#123', archived: true },
       ] };
     ${html.slice(escStart, escEnd + '[c]));'.length)}
     ${html.slice(tmplStart, tmplEnd)}
     export { viewPick };`));
  const out = mod.viewPick();
  assert.match(out, /data-action="toggle-pick" data-id="m1"/);
  assert.doesNotMatch(out, /data-action="toggle-pick" data-id="m2"/, 'archived meals leave the grid');
  assert.match(out, /data-action="restore-meal" data-id="m2"/, 'and land in the restore list instead');
  // another device can archive a meal this draft has picked — hiding the card
  // would freeze the count at 7/7 with nothing left to unpick
  assert.match(out, /data-action="toggle-pick" data-id="m3"/, 'a picked meal stays on the grid even archived');
  assert.doesNotMatch(out, /data-action="restore-meal" data-id="m3"/, 'and is not listed twice');
  assert.match(out, /Hold a meal/, 'long-press is invisible — the hint is the only signpost');
});

test('viewPick offers a way to start over only when there is something to start over from', async () => {
  const tmplStart = html.indexOf('function viewPick');
  const tmplEnd = html.indexOf('function viewAddSheet');
  assert.ok(tmplStart > 0 && tmplEnd > tmplStart, 'viewPick markers found in index.html');
  const escStart = html.indexOf('const esc =');
  const escEnd = html.indexOf('[c]));', escStart);
  const pickWith = async (mains) => (await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(
    `const PICK_TARGET = 7;
     const TINTS = ['#111'];
     const KIND_FOR_TAB = { mains: 'main', breakfasts: 'breakfast' };
     const state = { pickTab: 'mains', addOpen: false, editId: null,
       week: { picks: { mains: ${JSON.stringify(mains)}, breakfasts: [] } },
       meals: [{ id: 'm1', kind: 'main', name: 'Pilau', tint: '#123' }] };
     ${html.slice(escStart, escEnd + '[c]));'.length)}
     ${html.slice(tmplStart, tmplEnd)}
     export { viewPick };`))).viewPick();

  const fresh = await pickWith([]);
  assert.doesNotMatch(fresh, /data-action="clear-picks"/, 'a fresh week has nothing to clear');
  const started = await pickWith(['m1']);
  assert.match(started, /data-action="clear-picks"/, 'one pick is enough to want to start over');
  assert.match(started, /aria-label="Clear picked mains"/,
    '"Clear" alone names nothing for a screen reader landing on the button');
  assert.match(started, /class="pick-tally"[\s\S]*?1 \/ 7[\s\S]*?clear-picks/,
    'the button rides with the count it clears, so space-between still pins the tally right');
});

test('the clear button keeps its box inside the sticky count row', () => {
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.match(style, /\.pick-tally\s*\{[^}]*display:\s*flex/,
    'the count and the button are one group — three loose children would centre the count');
  // measured at 375px: the row is 45px with no button and 45px with one. Drop
  // either declaration below and it grows (2px centred-only, 2.5px line-height
  // only), pushing the whole grid down the moment the first pick lands
  assert.match(style, /\.pick-tally\s*\{[^}]*align-items:\s*center/,
    'a baseline-aligned button hangs 2.5px below the count it sits beside');
  assert.match(style, /\.pick-clear\s*\{[^}]*line-height:\s*1/,
    "and a full line-height puts the button's box back outside the count's");
});

test('the clear button takes a thumb, not just a cursor', () => {
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.match(style, /\.pick-clear\s*\{[^}]*position:\s*relative/,
    'the overlay anchors to the button, not to the sticky row');
  assert.match(style, /\.pick-clear::after\s*\{[^}]*content:\s*''/,
    'without content the pseudo-element generates no box at all and the target is 23px again');
  assert.match(style, /\.pick-clear::after\s*\{[^}]*position:\s*absolute[^}]*\}/,
    'a 23px-tall target is a miss on a phone, and this one clears the week');
  // measured with elementFromPoint: -13px gives a 45px tap, -11px only 40.5px,
  // because inset resolves against the padding box and the border eats 2px
  assert.match(style, /\.pick-clear::after\s*\{[^}]*inset:\s*-13px/,
    'growing the button itself would push the grid down — the hit area grows instead');
});

test('Escape closes a sheet, editor first, and defers to the write gate', () => {
  const s = html.indexOf("document.addEventListener('keydown'");
  assert.ok(s > 0, 'keydown wiring found in index.html');
  const live = html.slice(s, html.indexOf('});', s))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.match(live, /if \(e\.key !== 'Escape'\) return/);
  // the question is topmost — Escape answers it, never the sheet under it
  assert.match(live, /if \(state\.confirm\) settleConfirm\(false\);\s*else if \(state\.editId\)/,
    'an open confirm swallows Escape before either sheet sees it');
  // routed through the actions, so both close paths keep their in-flight guard
  assert.match(live, /if \(state\.editId\) actions\['close-edit'\]\(\);\s*else if \(state\.addOpen\) actions\['close-add'\]\(\)/,
    'the topmost sheet closes first, and neither bypasses its gate');
});

test('confirmSheet parks one question and settleConfirm answers it exactly once', async () => {
  const p = confirmSheet({ title: 'Sure?', body: 'Really.', confirmLabel: 'Yes' });
  assert.ok(state.confirm, 'the question sits in state for render to pick up');
  settleConfirm(true);
  assert.equal(await p, true);
  assert.equal(state.confirm, null, 'settling clears the question');
  settleConfirm(false); // nothing open — a stray teardown answer must be a no-op

  const q = confirmSheet({ title: 'Again?', body: 'Still.', confirmLabel: 'Yes' });
  settleConfirm(false);
  settleConfirm(true); // a late second answer lands on nothing
  assert.equal(await q, false);

  // a second ask while one is open must answer the first, not strand it
  const first = confirmSheet({ title: 'First?', body: 'One.', confirmLabel: 'Yes' });
  const second = confirmSheet({ title: 'Second?', body: 'Two.', confirmLabel: 'Yes' });
  assert.equal(await first, false, 'the clobbered question resolves instead of dangling');
  assert.equal(state.confirm.title, 'Second?', 'the new question is the open one');
  settleConfirm(true);
  assert.equal(await second, true);
});

test('a notice is a one-answer question on the same slot: any way out resolves it', async () => {
  const n = noticeSheet({ title: '7 already selected', body: 'Unpick one first.' });
  assert.equal(state.confirm.notice, true, 'the notice flag drops the Cancel button');
  assert.equal(state.confirm.confirmLabel, 'Okay');
  settleConfirm(false); // backdrop, Escape, back — the answer is never read
  await n;
  assert.equal(state.confirm, null);
});

test('an 8th pick asks nothing and saves nothing — it gets a notice and stops', () => {
  const tp = html.slice(html.indexOf("'toggle-pick':"), html.indexOf("'open-add':"));
  assert.match(tp, /noticeSheet\(\{[\s\S]{0,140}?PICK_TARGET[\s\S]{0,140}?\}\);\s*return;/,
    'the full-board branch shows the notice and exits before any reconcile or save');
  assert.doesNotMatch(tp, /bump/, 'the counter bump is gone — the notice replaced it');
});

test('clearing empties the tab the question named and leaves the other alone', async () => {
  state.week.picks = { mains: ['m1', 'm2'], breakfasts: ['b1'] };
  const p = clearPicks('mains');
  assert.ok(state.confirm, 'starting over is a question, not a silent wipe');
  settleConfirm(true);
  assert.equal(await p, true);
  assert.deepEqual(state.week.picks.mains, []);
  assert.deepEqual(state.week.picks.breakfasts, ['b1'], 'the tab nobody asked about keeps its picks');
  assert.equal(state.saveStatus, 'saving', 'the emptied week is on its way to the server');
  db.client = fakeWeeksClient();
  await flushSave();                       // disarm the debounce this test armed
});

test('a declined clear changes nothing and saves nothing', async () => {
  state.week.picks = { mains: ['m1', 'm2'], breakfasts: [] };
  const p = clearPicks('mains');
  settleConfirm(false);
  assert.equal(await p, false);
  assert.deepEqual(state.week.picks.mains, ['m1', 'm2']);
  assert.equal(state.saveStatus, 'saved', 'a cancelled question must not arm a save');
});

test('nothing picked is its own answer — no question, no save', async () => {
  state.week.picks = { mains: [], breakfasts: ['b1'] };
  assert.equal(await clearPicks('mains'), null,
    'null is "there was nothing to clear" — false would read as "you cancelled"');
  assert.equal(state.confirm, null, 'no question was ever asked');
  assert.equal(state.saveStatus, 'saved');
});

test('clearing empties the days those picks filled and keeps the lunches you typed', async () => {
  state.week.picks = { mains: ['m1', 'm2'], breakfasts: ['b1'] };
  state.week.days = {
    mon: { dinner: 'm1', breakfast: 'b1', lunch: 'Leftovers' },
    tue: { dinner: 'm2', breakfast: null },
  };
  const p = clearPicks('mains');
  settleConfirm(true);
  await p;
  assert.equal(state.week.days.mon.dinner, null, 'the dinner it filled goes back to empty');
  assert.equal(state.week.days.tue.dinner, null);
  assert.equal(state.week.days.mon.breakfast, 'b1', 'the other tab keeps the days it filled');
  assert.equal(state.week.days.mon.lunch, 'Leftovers', 'a lunch you typed is your words, not a pick');
  db.client = fakeWeeksClient();
  await flushSave();
});

// no path reaches this today; the guard is kept because scheduleSave persists
// state.week, so a swap mid-question would mutate one week and save another
test('a week swapped mid-question abandons the clear instead of gutting the one that replaced it', async () => {
  state.week.picks = { mains: ['m1', 'm2'], breakfasts: [] };
  const abandoned = state.week;
  const p = clearPicks('mains');
  state.week = { ...abandoned, picks: { mains: ['m9'], breakfasts: [] }, days: {} };
  settleConfirm(true);
  try {
    assert.equal(await p, null, 'the week the question named is gone — its answer cannot travel');
    assert.deepEqual(abandoned.picks.mains, ['m1', 'm2'], 'the discarded week is left as it was');
    assert.deepEqual(state.week.picks.mains, ['m9'], 'and the fresh one keeps what it arrived with');
    assert.equal(state.saveStatus, 'saved', 'nothing was saved either');
  } finally {
    // deleting the guard is what this test catches, and that path DOES arm the
    // debounce — one red test, not one red test plus a timer loose in the suite
    settleConfirm(false);
    db.client = fakeWeeksClient();
    await flushSave();
  }
});

// the wall's answer is a return value nobody reads, so without this the tap
// that reached it produces nothing. It does paint: confirm-yes only exists
// where render() drew the sheet, so the answer always arrives in a screen phase
test('a wall that fires says so — a confirmed tap is never answered with silence', async () => {
  state.week.picks = { mains: ['m1', 'm2'], breakfasts: [] };
  const p = clearPicks('mains');
  state.week = { ...state.week, picks: { mains: ['m9'], breakfasts: [] }, days: {} };
  settleConfirm(true);
  try {
    await p;
    assert.ok(state.confirm?.notice, 'the tap produced something to look at');
    assert.match(state.confirm.title, /moved on/);
  } finally {
    // deleting the guard reaches scheduleSave, and the assertions above would
    // throw first: beforeEach clears neither the timer nor state.confirm
    settleConfirm(false);
    db.client = fakeWeeksClient();
    await flushSave();
  }
});

test('the question counts what it is about to drop, in the words of the tab it names', async () => {
  state.week.picks = { mains: ['m1', 'm2', 'm3', 'm4'], breakfasts: ['b1'] };
  const many = clearPicks('mains');
  assert.equal(state.confirm.title, 'Clear 4 picked mains?');
  assert.equal(state.confirm.confirmLabel, 'Clear');
  settleConfirm(false);
  await many;

  const one = clearPicks('breakfasts');
  assert.equal(state.confirm.title, 'Clear 1 picked breakfast?', 'one pick is not "1 breakfasts"');
  settleConfirm(false);
  await one;
});

test('the clear action is delegation only — the logic lives where the tests can reach it', () => {
  const at = html.indexOf("'clear-picks':");
  assert.ok(at > 0, 'clear-picks action found in index.html');
  const body = html.slice(at, html.indexOf("'open-add':", at));
  assert.match(body, /^'clear-picks': \(\) => \{ clearPicks\(state\.pickTab\); \},/,
    'anything more here is behaviour the app slice cannot import, so nothing above covers it');
});

test('every error-phase site names its own heading', () => {
  const sites = [...html.matchAll(/state\.phase = 'error';/g)];
  assert.ok(sites.length >= 5, 'the error sites were found');
  for (const m of sites) {
    assert.match(html.slice(m.index, m.index + 260), /state\.errorTitle = /,
      `the error site at index ${m.index} sets a heading to match its body`);
  }
});

test('a back gesture answers an open question before any sheet teardown', () => {
  const s = html.indexOf("window.addEventListener('hashchange'");
  assert.ok(s > 0, 'hashchange wiring found in index.html');
  const live = html.slice(s, html.indexOf('});', s));
  assert.match(live, /settleConfirm\(false\);[\s\S]*?state\.addOpen = false/,
    'an unanswered question would strand the flow awaiting it');
});

// the one teardown that used to strand a question: an open confirm survived
// SIGNED_OUT, and the next SIGNED_IN repainted it over a freshly loaded week
test('signing out answers the open question — it must not outlive the session', () => {
  const s = html.indexOf('client.auth.onAuthStateChange');
  assert.ok(s > 0, 'the auth wiring was found in index.html');
  const live = html.slice(s, html.indexOf('\n  });', s));
  assert.match(live, /SIGNED_OUT'\)\s*\{\s*settleConfirm\(false\);/,
    'answered before the phase flips, so no flow is left awaiting a week that has been replaced');
});

test('the native dialogs are gone from every confirm path', () => {
  assert.doesNotMatch(html, /[^\w]confirm\(/, 'window.confirm has no callers left, dot-qualified or bare');
  assert.doesNotMatch(html, /[^\w]alert\(/, 'alert has no callers left either — the notice does its job');
});

// every write path funnels an abandoned request into one honest outcome
test('a timed-out write locks the app into a resync instead of freeing the sheet', () => {
  const s = html.indexOf('function lockOnUnknownWrite');
  assert.ok(s > 0, 'lockOnUnknownWrite found in index.html');
  const live = html.slice(s, html.indexOf("\n}", s));
  assert.match(live, /if \(!err\?\.timedOut\) return false/, 'only an unknown outcome locks');
  assert.match(live, /settleConfirm\(false\)/, 'the lock answers an open question instead of repainting over it');
  assert.match(live, /state\.errorTitle = /, 'the lock names its own heading — "Can\'t load" would contradict the body');
  assert.match(live, /state\.phase = 'error'/);
  assert.match(live, /state\.editId = null[\s\S]*?state\.addOpen = false/, 'both sheets go');
  assert.match(live, /Try again/, 'the error screen’s resync is the way out');

  // the lock must precede the in-sheet message in every catch, or the sheet
  // reopens with a retry that can race the abandoned write — checked by
  // position inside the catch, so swapping the lines fails, not by proximity
  for (const marker of ["'archive-meal':", "'restore-meal':", "'delete-week':", "if (form.id === 'form-addmeal')", "if (form.id === 'form-editmeal')"]) {
    const at = html.indexOf(marker);
    assert.ok(at > 0, `${marker} found in index.html`);
    const c = html.indexOf('catch (err) {', at);
    assert.ok(c > at, `${marker} has a catch`);
    const fin = html.indexOf('finally', c);
    assert.ok(fin > c, `${marker}'s catch is bounded by its finally — the slice below depends on it`);
    const body = html.slice(c, fin);
    const lock = body.indexOf('if (lockOnUnknownWrite(err)) return;');
    assert.ok(lock >= 0, `${marker} routes an unknown outcome to the lock`);
    const surface = body.search(/state\.errorMsg =|state\.addName =|state\.editName =|noticeSheet\(|el\.disabled/);
    assert.ok(surface > lock,
      `${marker}: the lock precedes every user-visible write in its catch`);
  }
});

test('the restore action re-arms its button on failure and flips archived back off', () => {
  const hStart = html.indexOf("'restore-meal':");
  const hEnd = html.indexOf("'delete-week':");
  assert.ok(hStart > 0 && hEnd > hStart, 'restore-meal handler markers found in index.html');
  const live = html.slice(hStart, hEnd)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.match(live, /el\.disabled = true;[\s\S]{0,100}?await withCeiling\(db\.updateMeal\(meal\.id, \{ archived: false \}\)\)/,
    'the button dies before the request flies, and the request cannot outlive its ceiling');
  assert.match(live, /Object\.assign\(meal, row\);\s*state\.errorMsg = ''/,
    'a stale save failure must not outlive the restore that followed it');
  assert.match(live, /catch[\s\S]{0,120}?el\.disabled = false/, 'a failed restore re-arms the button');
});

test('the edit sheet prefills the kept name, offers photo replace, archive and cancel', async () => {
  const tmplStart = html.indexOf('function viewEditSheet');
  const tmplEnd = html.indexOf('/* ---------- Week');
  assert.ok(tmplStart > 0 && tmplEnd > tmplStart, 'edit-sheet markers found in index.html');
  const escStart = html.indexOf('const esc =');
  const escEnd = html.indexOf('[c]));', escStart);
  const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(
    `const state = { editId: 'm1', editName: 'Kept <edit>', errorMsg: 'boom <err>',
       meals: [{ id: 'm1', kind: 'main', name: 'Steak' },
               { id: 'm4', kind: 'main', name: 'Shelved', archived: true }] };
     const mealById = (id) => state.meals.find((m) => m.id === id);
     ${html.slice(escStart, escEnd + '[c]));'.length)}
     ${html.slice(tmplStart, tmplEnd)}
     export { viewEditSheet, state as estate };`));
  const out = mod.viewEditSheet();
  assert.match(out, /role="dialog" aria-modal="true"/, 'the sheet declares the modality inert enforces');
  assert.match(out, /id="form-editmeal"/);
  assert.match(out, /value="Kept &lt;edit&gt;"/, 'a failed save keeps the typed name, escaped');
  assert.match(out, /type="file"/);
  assert.match(out, /accept="image\/\*"/);
  assert.match(out, /data-action="archive-meal"/);
  assert.match(out, /data-action="close-edit"/);
  assert.match(out, /boom &lt;err&gt;/, 'failures surface inside the sheet, escaped');
  // an archived meal can reach the sheet (picked-but-archived stays on the
  // grid) — offering Archive there would instruct an impossible step
  mod.estate.editId = 'm4';
  const archOut = mod.viewEditSheet();
  assert.doesNotMatch(archOut, /data-action="archive-meal"/, 'no archiving what is already archived');
  assert.match(archOut, /data-action="restore-meal" data-id="m4"/, 'the sheet offers the true inverse');
  mod.estate.editId = 'ghost';
  assert.equal(mod.viewEditSheet(), '', 'an edit sheet for a vanished meal renders nothing');
});

test('openEditSheet seeds the sheet from the meal, closes the add sheet, lands focus in the name', () => {
  const s = html.indexOf('function openEditSheet');
  const e = html.indexOf("document.addEventListener('pointerdown'");
  assert.ok(s > 0 && e > s, 'openEditSheet found in index.html');
  const live = html.slice(s, e)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.match(live, /if \(!meal \|\| mealWriteInFlight\) return/, 'no opening the editor over an airborne meal request');
  assert.match(live, /state\.editId = id/);
  assert.match(live, /state\.editName = meal\.name/);
  assert.match(live, /state\.addOpen = false/);
  assert.match(live, /form-editmeal input\[name="name"\]/, 'focus lands in the name field');

  const ce = html.indexOf("'close-edit':");
  assert.ok(ce > 0, 'close-edit action found in index.html');
  assert.match(html.slice(ce, ce + 200), /state\.editId = null/);
});

test('the long-press wiring: hold opens the editor, movement or release cancels, the trailing click dies in capture', () => {
  const s = html.indexOf('const LONG_PRESS_MS');
  const e = html.indexOf("document.addEventListener('input'");
  assert.ok(s > 0 && e > s, 'long-press block found in index.html');
  const live = html.slice(s, e)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.match(live, /closest\('\.meal-card\[data-id\]'\)/);
  // primary-only reset: a second finger must not disarm the first finger's
  // pending swallow, but any new touch still kills a pending hold timer
  assert.match(live, /if \(e\.isPrimary\) pressConsumed = false;\s*cancelPress\(\);/,
    'a second finger must neither orphan a timer nor forget an armed swallow');
  assert.match(live, /if \(e\.button !== 0\) return/, 'right-button holds belong to contextmenu');
  assert.match(live, /setTimeout\([\s\S]{0,120}?LONG_PRESS_MS\)/, 'the hold is a timer, not a click');
  assert.match(live, /Math\.hypot\([\s\S]{0,80}?\) > \d+\) cancelPress\(\)/, 'a scroll-sized move is not a hold');
  assert.match(live, /addEventListener\('pointerup', cancelPress\)/);
  assert.match(live, /addEventListener\('pointercancel', cancelPress\)/);
  // the capture flag is anchored to the swallow's own body — a listener
  // elsewhere in the block cannot satisfy this pin
  assert.match(live, /pressConsumed = false;\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*\}, true\);/,
    'the swallow itself must run in capture phase, ahead of the action delegate');
  assert.match(live, /addEventListener\('contextmenu'/, 'Android long-press and desktop right-click arrive here');
  assert.match(live, /openEditSheet\(/);
});

test('a route change dismisses both sheets — except an editor whose request is airborne', () => {
  const s = html.indexOf("window.addEventListener('hashchange'");
  const e = html.indexOf("window.addEventListener('online'");
  assert.ok(s > 0 && e > s, 'hashchange wiring found in index.html');
  const live = html.slice(s, e)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  // unconditional dismissal here would bypass the single-flight guard and
  // strand the failure message in a sheet that no longer renders
  assert.match(live,
    /state\.addOpen = false;\s*if \(!mealWriteInFlight\) \{\s*state\.editId = null;\s*state\.editName = '';\s*\}/);
});

// ── render(), executed ─────────────────────────────────────────────────
// The whole views section over the real constants/utilities/domain, so the
// sheet/inert structure is checked by running it, not by grepping its source.
const renderViewsStart = html.indexOf('const ICONS = {');
const renderViewsEnd = html.indexOf('/* ---------- surgical');
assert.ok(renderViewsStart > 0 && renderViewsEnd > renderViewsStart, 'views section markers found in index.html');
const renderMod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(`
  ${html.slice(domStart, domEnd)}
  const state = { phase: 'ready', route: 'pick', pickTab: 'mains', saveStatus: 'saved',
    saveErrorPermanent: false, errorMsg: '', loadingMsg: '', signinEmail: '',
    addOpen: false, addName: '', editId: null, editName: '', lifted: null, staples: [],
    history: null, historyError: '', historyDetail: null,
    meals: [{ id: 'm1', kind: 'main', name: 'Steak', tint: '#123' }],
    week: { id: 'w1', week_start: '2026-08-03', budget: null,
            picks: { mains: [], breakfasts: [] }, days: {}, groceries: [] } };
  const mealById = (id) => state.meals.find((m) => m.id === id);
  const mealName = (id) => mealById(id)?.name ?? '—';
  ${html.slice(renderViewsStart, renderViewsEnd)}
  export { state as rstate, render };`));

// render() reaches #app through the $ helper, i.e. document.querySelector
function renderToHtml() {
  const app = { innerHTML: '' };
  const real = globalThis.document.querySelector;
  globalThis.document.querySelector = (sel) => (sel === '#app' ? app : real(sel));
  try {
    renderMod.render();
  } finally {
    globalThis.document.querySelector = real;
  }
  return app.innerHTML;
}

// Split the output at the inert wrapper's OWN closing tag, found by counting
// div depth — "somewhere in the string" cannot tell inside the wall from out.
function splitAtWall(out) {
  const open = '<div inert>';
  assert.ok(out.startsWith(open), 'the wall opens the document');
  let depth = 1;
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = open.length;
  for (let m; (m = tag.exec(out)); ) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) {
      return { inside: out.slice(open.length, m.index), outside: out.slice(tag.lastIndex) };
    }
  }
  assert.fail('the inert wrapper is never closed');
}

test('render walls the whole page behind inert and leaves exactly one sheet outside it', () => {
  const s = renderMod.rstate;
  s.editId = null; s.addOpen = false;
  const plain = renderToHtml();
  assert.doesNotMatch(plain, /<div inert>/, 'no sheet, no wall');
  assert.match(plain, /class="tabbar"/, 'the background is the page itself');

  s.addOpen = true;
  const { inside, outside } = splitAtWall(renderToHtml());
  // everything reachable must be one side or the other, and on the right side
  assert.match(inside, /class="tabbar"/, 'the tab bar is behind the wall');
  assert.match(inside, /class="header"/, 'so is the header');
  assert.match(inside, /class="pick-grid"/, 'so is the grid');
  assert.doesNotMatch(inside, /role="dialog"/, 'no sheet is trapped behind the wall');
  assert.match(outside, /id="form-addmeal"/, 'state.addOpen alone puts the add sheet outside it');
  assert.match(outside, /aria-modal="true"/, 'and the sheet that is reachable declares modality');

  // both flags set: the editor wins and only one dialog exists — the case a
  // per-action guard used to cover and the root ternary now makes structural
  s.editId = 'm1'; s.editName = 'Steak';
  const both = splitAtWall(renderToHtml());
  assert.equal((both.outside.match(/role="dialog"/g) ?? []).length, 1, 'never two stacked sheets');
  assert.doesNotMatch(both.inside, /role="dialog"/);
  assert.match(both.outside, /id="form-editmeal"/);
  assert.doesNotMatch(both.outside, /id="form-addmeal"/, 'the editor wins');
  s.editId = null; s.editName = ''; s.addOpen = false;
});

test('a notice renders one button — Okay, no Cancel — and its backdrop still dismisses', () => {
  const s = renderMod.rstate;
  s.confirm = { title: '7 already selected', body: 'Unpick one first.', confirmLabel: 'Okay', notice: true };
  const { outside } = splitAtWall(renderToHtml());
  assert.match(outside, /data-action="confirm-yes">Okay</, 'the one answer is Okay');
  assert.doesNotMatch(outside, /btn-quiet/, 'no Cancel on a notice');
  assert.match(outside, /sheet-backdrop is-top" data-action="confirm-no"/, 'tapping outside still dismisses');
  s.confirm = null;
});

test('the sign-in screen renders a reveal button that cannot submit the form', () => {
  const s = renderMod.rstate;
  s.phase = 'signin';
  const out = renderToHtml();
  assert.match(out, /name="password"[^>]*>\s*<button type="button"[^>]*data-action="toggle-password"/,
    'the toggle sits beside the field it reveals, and type="button" keeps it from submitting');
  // the toggle precedes the submit button — the submit guard must select by
  // type, not by position (see the sign-in submit glue test)
  const form = out.slice(out.indexOf('<form id="form-signin"'));
  assert.match(form.match(/<button[^>]*>/)[0], /data-action="toggle-password"/,
    'the first button in the form is the toggle, not Sign in');
  assert.match(out, /aria-pressed="false"/, 'the field starts hidden');
  assert.match(out, /aria-label="Show password"/, 'the control says what it does');
  assert.match(out, /type="password"/, 'the markup itself never ships a revealed password');
  // both icons ship once; CSS picks by pressed state, so no innerHTML swap
  assert.equal((out.match(/class="icon-eye"/g) ?? []).length, 1);
  assert.equal((out.match(/class="icon-eye-off"/g) ?? []).length, 1);
  s.phase = 'ready';
});

test('the error screen wears the heading its site chose, not a hard-coded one', () => {
  const s = renderMod.rstate;
  s.phase = 'error'; s.errorTitle = 'Not loading, something else'; s.errorMsg = 'the body';
  const out = renderToHtml();
  assert.match(out, /<h2>Not loading, something else<\/h2>/, 'the heading comes from state');
  assert.doesNotMatch(out, /Can't load/, 'nothing hard-coded contradicts the body');
  s.phase = 'ready'; s.errorTitle = ''; s.errorMsg = '';
});

test('a confirm outranks the sheets: even the sheet that asked goes behind the wall', () => {
  const s = renderMod.rstate;
  s.editId = 'm1'; s.editName = 'Steak';
  s.confirm = { title: 'Archive Steak?', body: 'It keeps its place in past weeks.', confirmLabel: 'Archive' };
  const { inside, outside } = splitAtWall(renderToHtml());
  assert.match(inside, /id="form-editmeal"/, 'the asking sheet is walled off with the page');
  assert.equal((outside.match(/role="dialog"/g) ?? []).length, 1, 'the question is the only live surface');
  assert.match(outside, /aria-modal="true"/);
  assert.match(outside, /data-action="confirm-yes"/, 'true has exactly one source');
  assert.match(outside, /data-action="confirm-no"/, 'and Cancel is offered');
  s.confirm = null; s.editId = null; s.editName = '';
});

test('render keeps the editor above every screen, not inside the pick grid', () => {
  const s = renderMod.rstate;
  s.editId = 'm1'; s.editName = 'Steak';
  for (const route of ['pick', 'budget', 'summary', 'history']) {
    s.route = route;
    assert.match(renderToHtml(), /id="form-editmeal"/, `an airborne edit survives the ${route} route`);
  }
  s.route = 'pick'; s.editId = null; s.editName = '';
});

test('the edit sheet is single-flight: no dismiss, no double-fire while its request is airborne', () => {
  const ce = html.indexOf("'close-edit':");
  assert.match(html.slice(ce, ce + 220), /if \(mealWriteInFlight\) return/,
    'closing mid-flight would strand the failure message in a sheet that no longer renders');
  const am = html.indexOf("'archive-meal':");
  assert.match(html.slice(am, am + 220), /if \(!meal \|\| mealWriteInFlight\) return/);
  // the arm sits flush against its try — a statement between them that threw
  // would wedge the gate closed for the rest of the session
  assert.match(html.slice(am, html.indexOf("'restore-meal':")), /mealWriteInFlight = true;\s*try \{/,
    'nothing runs between arming the gate and the try that releases it');
  // the add sheet shares the gate: Escape or Cancel mid-add would otherwise
  // strand its failure message in a sheet that no longer renders
  const ca = html.indexOf("'close-add':");
  assert.match(html.slice(ca, ca + 220), /if \(mealWriteInFlight\) return/);
  const am2 = html.slice(html.indexOf("if (form.id === 'form-addmeal')"), html.indexOf("if (form.id === 'form-editmeal')"));
  assert.match(am2, /if \(!name \|\| mealWriteInFlight\) return/);
  assert.match(am2, /mealWriteInFlight = true;\s*let image_url = null;\s*try \{/);
  assert.match(am2, /await withCeiling\(db\.addMeal\(/, 'the insert is bounded too');
  assert.match(am2, /finally \{\s*mealWriteInFlight = false;\s*\}/);

  const em = html.slice(html.indexOf("if (form.id === 'form-editmeal')"), html.indexOf("if (form.id === 'form-additem')"));
  assert.match(em, /if \(!meal \|\| !name \|\| mealWriteInFlight\) return/);
  assert.match(em, /mealWriteInFlight = true;\s*let uploaded = null;\s*try \{/,
    'only the throw-proof declaration sits between the arm and its try');
  assert.match(em, /finally \{\s*mealWriteInFlight = false;\s*\}/, 'the gate releases on every path');
  // the sheet's Restore button routes here too — ungated, it would race a
  // concurrent Save on the same meal and clobber the rename locally
  const rm = html.slice(html.indexOf("'restore-meal':"), html.indexOf("'delete-week':"));
  assert.match(rm, /if \(!meal \|\| mealWriteInFlight\) return/, 'restore is part of the same single flight');
  assert.match(rm, /mealWriteInFlight = true;\s*try \{/);
  assert.match(rm, /finally \{\s*mealWriteInFlight = false;\s*\}/);
});

test('the archive action refuses a meal on this week’s menu, confirms, then flips archived', () => {
  const hStart = html.indexOf("'archive-meal':");
  const hEnd = html.indexOf("'retry-history':");
  assert.ok(hStart > 0 && hEnd > hStart, 'archive-meal handler markers found in index.html');
  const live = html.slice(hStart, hEnd)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.match(live, /picks\.mains\.includes\(meal\.id\) \|\|[\s\S]{0,60}?picks\.breakfasts\.includes\(meal\.id\)/,
    'both pick lists guard the current draft');
  assert.match(live, /unpick it first[\s\S]{0,260}?if \(!\(await confirmSheet\(/, 'guard first, question second');
  assert.match(live, /withCeiling\(db\.updateMeal\(meal\.id, \{ archived: true \}\)\)/);
  assert.match(live, /catch[\s\S]{0,160}?errorMsg/, 'a failed archive stays in the sheet with its reason');
});

test('the edit submit glue uploads then updates, keeps failures in the sheet, never reclaims the replaced photo', () => {
  const hStart = html.indexOf("if (form.id === 'form-editmeal')");
  const hEnd = html.indexOf("if (form.id === 'form-additem')");
  assert.ok(hStart > 0 && hEnd > hStart, 'edit-meal handler markers found in index.html');
  const live = html.slice(hStart, hEnd)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  // every gated request carries a ceiling: the inert background makes this
  // gate app-wide, so a hung request must not become a frozen app
  assert.match(live, /await withCeiling\(uploadPhoto\(file\)\)/);
  assert.match(live, /await withCeiling\(db\.updateMeal\(meal\.id, fields\)\)/);
  assert.match(live, /if \(uploaded\) delete meal\.imageDead/, 'a fresh URL deserves a fresh chance');
  assert.match(live, /Object\.assign\(meal, row\)/, 'the state object keeps its identity — picks point at it');
  assert.match(live, /state\.editName = name/, 'a failed save keeps the typed name');
  assert.match(live, /if \(uploaded && isServerRejection\(err\)\)/, 'reclaim goes through the tested discriminator');
  assert.match(live, /db\.removeMealImage\(uploaded\)/, 'a provably dead update reclaims its fresh upload');
  // seed meals share storage objects (mixed-vegetables.jpg serves two
  // breakfasts) — a replaced URL is not an orphaned one
  assert.doesNotMatch(live, /removeMealImage\(meal\.image_url\)/, 'the replaced photo must never be reclaimed');
});

// ── delete a saved week ────────────────────────────────────────────────

function fakeDeleteTable({ failWith = null } = {}) {
  const deletes = [];
  return {
    deletes,
    from(name) {
      const d = { table: name, filters: [] };
      const b = {
        delete() { deletes.push(d); return b; },
        eq(col, val) { d.filters.push([col, val]); return b; },
        async then(resolve) { resolve(failWith ? { data: null, error: failWith } : { data: null, error: null }); },
      };
      return b;
    },
  };
}

test('deleteWeek deletes exactly the named week and tolerates one already gone', async () => {
  db.client = fakeDeleteTable();
  await db.deleteWeek('w7');
  assert.equal(db.client.deletes[0].table, 'weeks');
  assert.deepEqual(db.client.deletes[0].filters, [['id', 'w7']]);
  // PostgREST answers zero matched rows with no error — the re-run a skew
  // retry performs must land here as success, not an exception
  await db.deleteWeek('w7');
  assert.equal(db.client.deletes.length, 2);
});

test('deleteWeek surfaces server rejections', async () => {
  db.client = fakeDeleteTable({ failWith: { code: '42501', message: 'RLS says no' } });
  await assert.rejects(db.deleteWeek('w7'), (err) => err.code === '42501');
});

test('the history detail offers deletion of exactly the shown week', () => {
  viewsMod.vstate.history = [fullWeek()];
  viewsMod.vstate.historyDetail = '2026-07-27';
  assert.match(viewsMod.viewHistory(), /data-action="delete-week" data-id="w1"/);
  viewsMod.vstate.historyDetail = null;
  assert.doesNotMatch(viewsMod.viewHistory(), /data-action="delete-week"/, 'the list itself deletes nothing');
});

test('the delete-week action confirms, deletes, drops the row from cache and returns to the list', () => {
  const hStart = html.indexOf("'delete-week':");
  const hEnd = html.indexOf("'retry-history':");
  assert.ok(hStart > 0 && hEnd > hStart, 'delete-week handler markers found in index.html');
  const live = html.slice(hStart, hEnd)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.match(live, /if \(!week \|\| weekDeleteInFlight\) return/,
    'the button cannot gate this — the confirm re-render detaches it, so a flag must');
  assert.match(live, /if \(!\(await confirmSheet\(/, 'no silent destruction');
  assert.match(live, /confirmSheet\(\{[\s\S]{0,120}?fmtDate\(week\.week_start\)/,
    'the destruction prompt names its target the way the app writes dates everywhere else');
  // one anchor for the whole order: the cache drop and the navigation sit
  // AFTER the await — moved above it, a failed delete would erase the row
  // from the UI while the server kept it
  assert.match(live,
    /weekDeleteInFlight = true;\s*try \{\s*await withCeiling\(db\.deleteWeek\(week\.id\)\);\s*state\.history = state\.history\.filter[\s\S]{0,80}?location\.hash = '#\/history'/,
    'arm → bounded delete → drop from cache → navigate, in that order');
  assert.match(live, /finally \{\s*weekDeleteInFlight = false;\s*\}/, 'the gate releases on every path');
  assert.match(live, /noticeSheet\(/, 'a failed delete says so');
});

// ── installability: manifest, icons, keyboard focus ────────────────────

test('the page links the manifest and an apple touch icon', () => {
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/icon-180\.png">/);
});

test('every outline declaration is a sanctioned one — the focus ring cannot be suppressed', () => {
  assert.match(html, /:focus-visible \{ outline: 3px solid var\(--mustard\)/);
  // enumerating bad spellings lost four rounds running; this is the closed
  // world instead — an outline not on this list fails, whatever it says.
  // Whitespace-insensitive, so reformatting a legitimate rule stays green.
  const squash = (s) => s.replace(/\s+/g, '');
  const sanctioned = new Set([
    'outline:3pxsolidvar(--mustard)',
    'outline-offset:2px',
    'outline-offset:-4px',
  ].map(squash));
  for (const decl of html.match(/outline[a-z-]*\s*:[^;}]*/g) ?? []) {
    assert.ok(sanctioned.has(squash(decl)), `unsanctioned outline declaration: ${decl.trim()}`);
  }
  // the ring also dies to a reset shorthand or a JS assignment, neither of
  // which is an outline declaration
  assert.doesNotMatch(html, /\ball\s*:\s*(unset|revert|initial|revert-layer)\b/, 'a reset shorthand would wipe the ring');
  assert.doesNotMatch(html, /style\.outline/, 'the ring must not be assignable from script');
});

test('the manifest is standalone, relative-scoped, and every icon it names is a real PNG of its declared size', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './', 'Pages serves from a subpath — an absolute URL would escape it');
  assert.equal(manifest.scope, './');
  // pin the two real copies against each other instead of minting a third
  const metaTheme = /name="theme-color" content="([^"]+)"/.exec(html)?.[1];
  assert.equal(manifest.theme_color, metaTheme, 'the manifest and the meta tag must agree on the theme colour');
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'Android needs a maskable icon');
  for (const icon of manifest.icons) {
    const png = await readFile(new URL('../' + icon.src, import.meta.url));
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${icon.src} is a PNG`);
    const [w, h] = icon.sizes.split('x').map(Number);
    assert.equal(png.readUInt32BE(16), w, `${icon.src} width matches its declaration`);
    assert.equal(png.readUInt32BE(20), h, `${icon.src} height matches its declaration`);
  }
  // iOS reads its icon from the link tag, not the manifest — check it too
  const apple = await readFile(new URL('../icons/icon-180.png', import.meta.url));
  assert.equal(apple.readUInt32BE(16), 180);
});

test('the app wears one name — tab, header, gate, noscript and manifest all say it', async () => {
  const NAME = 'The Weekly Pot';
  const manifestSrc = await readFile(new URL('../manifest.webmanifest', import.meta.url), 'utf8');
  const manifest = JSON.parse(manifestSrc);
  assert.equal(manifest.name, NAME);
  // Android truncates launcher labels around 12 chars — the full name doesn't fit
  assert.equal(manifest.short_name, 'Weekly Pot');
  assert.ok(manifest.short_name.length <= 12, 'short_name must survive a launcher label');
  // compare the words as read, not the markup — the accent span may wrap any of them
  const words = (re, label) => {
    const m = re.exec(html);
    assert.ok(m, `${label} found in index.html`);
    return m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  };
  assert.equal(words(/<title>([\s\S]*?)<\/title>/, 'document title'), NAME);
  assert.equal(words(/<span class="brand">([\s\S]*?)<\/span>\s*<span id="save-state"/, 'header brand').toLowerCase(),
    NAME.toLowerCase());
  assert.equal(words(/<div class="board-title">([\s\S]*?)<\/div>/, 'gate title').toLowerCase(), NAME.toLowerCase());
  assert.match(words(/<noscript>([\s\S]*?)<\/noscript>/, 'noscript fallback'), new RegExp(`^${NAME}\\b`));
  // the debug seam is a name surface too — the only place a script addresses the app
  assert.match(html, /window\.__weeklypot = \{/, 'the debug seam wears the new name');
  // separators optional so identifier spellings (mealshop, meal_and_shop) match;
  // the \b keeps innocent copy like "meal shopping" out
  const oldName = /meal[\s_-]*(?:&amp;|&|and)?[\s_-]*shop\b/i;
  assert.doesNotMatch(html, oldName, 'no half-renamed copy left in the page');
  assert.doesNotMatch(manifestSrc, oldName, 'nor in the manifest');
});

test('the committed icons are pixel-identical to what tools/make-icons.mjs draws', async () => {
  const { renderIcon } = await import('../tools/make-icons.mjs');
  // compare decompressed scanlines, not files — deflate output may drift
  // across node versions while the drawing stays the same
  const rawPixels = (png) => {
    let off = 8;
    const idat = [];
    while (off < png.length) {
      const len = png.readUInt32BE(off);
      const type = png.toString('ascii', off + 4, off + 8);
      if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
      off += 12 + len;
    }
    return inflateSync(Buffer.concat(idat));
  };
  for (const size of [180, 192, 512]) {
    const disk = await readFile(new URL(`../icons/icon-${size}.png`, import.meta.url));
    assert.ok(rawPixels(disk).equals(rawPixels(renderIcon(size))),
      `icon-${size}.png is exactly what its committed source draws`);
  }
});
