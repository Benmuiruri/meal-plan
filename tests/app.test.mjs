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
export { state, db, scheduleSave, flushSave, signIn, resizeImage };`;

const { state, db, scheduleSave, flushSave, signIn, resizeImage } =
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

test('the lunch change glue trims typed text and deletes the override when emptied', () => {
  const hStart = html.indexOf("if (el.dataset.change === 'lunch')");
  const hEnd = html.indexOf("if (el.dataset.change === 'tick')");
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
  return {
    uploads,
    storage: {
      from: (bucket) => ({
        upload: async (path, blob, opts) => {
          uploads.push({ bucket, path, blob, opts });
          return failWith ? { data: null, error: failWith } : { data: { path }, error: null };
        },
        getPublicUrl: (path) => ({ data: { publicUrl: `https://cdn.example/${bucket}/${path}` } }),
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
  assert.equal(url, `https://cdn.example/meal-images/${up.path}`);
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
  // nesting pins the order — upload receives resizeImage's awaited result,
  // so the calls cannot be reordered or the inner await dropped
  assert.match(live, /await db\.uploadMealImage\(await resizeImage\(file\)\)/);
  assert.match(live, /db\.addMeal\(/);
  assert.match(live, /state\.addName = name/, 'a failed add must keep the typed name');
  assert.match(live, /db\.removeMealImage\(image_url\)/, 'a failed add must reclaim its upload');
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

test('resizeImage scales the longest edge to 400 — width for landscape, height for tall shots', async () => {
  await withCanvasWorld({ w: 800, h: 600 }, async (world) => {
    const out = await resizeImage({ size: 1000 });
    assert.equal(world.canvas.width, 400);
    assert.equal(world.canvas.height, 300);
    assert.equal(world.toBlobArgs.type, 'image/jpeg');
    assert.equal(out.type, 'image/jpeg');
    assert.ok(world.closed, 'bitmap memory is released');
  });
  await withCanvasWorld({ w: 600, h: 6000 }, async (world) => {
    await resizeImage({ size: 1000 });
    assert.equal(world.canvas.width, 40, 'a tall screenshot must not stay 400px wide and huge');
    assert.equal(world.canvas.height, 400);
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

test('resizeImage fails loudly when the canvas cannot encode', async () => {
  await withCanvasWorld({ w: 800, h: 600, blob: null }, async () => {
    await assert.rejects(resizeImage({ size: 1000 }), /process/);
  });
});
