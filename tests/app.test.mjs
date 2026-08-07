// App-layer tests. Sections 2–7 of index.html are sliced out and imported
// with document stubbed. Run with: node --test tests/app.test.mjs

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
export { state, db, scheduleSave, flushSave, signIn, resizeImage, isServerRejection,
         markDeadImage, reviveDeadImages, performSaveWeek };`;

const { state, db, scheduleSave, flushSave, signIn, resizeImage, isServerRejection,
        markDeadImage, reviveDeadImages, performSaveWeek } =
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
  assert.match(live, /outcome === 'dirty'\)[\s\S]{0,160}?alert\("The week wasn't saved/,
    'an explicitly invoked action must acknowledge its failure');
  assert.match(live, /outcome === 'save-failed'\)[\s\S]{0,80}?error\?\.message/, 'the rejection reason reaches the user');
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
  assert.doesNotMatch(out, /data-action="save-week"/);
  assert.match(out, /KSh 700/, 'remaining is computed from THAT week');
  assert.match(out, /href="#\/history"/, 'a way back to the list');
  viewsMod.vstate.historyDetail = '1999-01-04';
  assert.match(viewsMod.viewHistory(), /No saved week for that date/);
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

test('viewPick buries archived meals and writes the hidden gesture down', async () => {
  const tmplStart = html.indexOf('function viewPick');
  const tmplEnd = html.indexOf('function viewAddSheet');
  assert.ok(tmplStart > 0 && tmplEnd > tmplStart, 'viewPick markers found in index.html');
  const escStart = html.indexOf('const esc =');
  const escEnd = html.indexOf('[c]));', escStart);
  const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(
    `const PICK_TARGET = 7;
     const TINTS = ['#111'];
     const state = { pickTab: 'mains', addOpen: false, editId: null,
       week: { picks: { mains: [], breakfasts: [] } },
       meals: [
         { id: 'm1', kind: 'main', name: 'Alive', tint: '#123' },
         { id: 'm2', kind: 'main', name: 'Buried', tint: '#123', archived: true },
       ] };
     ${html.slice(escStart, escEnd + '[c]));'.length)}
     ${html.slice(tmplStart, tmplEnd)}
     export { viewPick };`));
  const out = mod.viewPick();
  assert.match(out, /Alive/);
  assert.doesNotMatch(out, /Buried/, 'archived meals leave the grid');
  assert.match(out, /Hold a meal/, 'long-press is invisible — the hint is the only signpost');
});

test('the edit sheet prefills the kept name, offers photo replace, archive and cancel', async () => {
  const tmplStart = html.indexOf('function viewEditSheet');
  const tmplEnd = html.indexOf('/* ---------- Week');
  assert.ok(tmplStart > 0 && tmplEnd > tmplStart, 'edit-sheet markers found in index.html');
  const escStart = html.indexOf('const esc =');
  const escEnd = html.indexOf('[c]));', escStart);
  const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(
    `const state = { editId: 'm1', editName: 'Kept <edit>', errorMsg: 'boom <err>' };
     const mealById = (id) => (id === 'm1' ? { id: 'm1', kind: 'main', name: 'Steak' } : undefined);
     ${html.slice(escStart, escEnd + '[c]));'.length)}
     ${html.slice(tmplStart, tmplEnd)}
     export { viewEditSheet, state as estate };`));
  const out = mod.viewEditSheet();
  assert.match(out, /id="form-editmeal"/);
  assert.match(out, /value="Kept &lt;edit&gt;"/, 'a failed save keeps the typed name, escaped');
  assert.match(out, /type="file"/);
  assert.match(out, /accept="image\/\*"/);
  assert.match(out, /data-action="archive-meal"/);
  assert.match(out, /data-action="close-edit"/);
  assert.match(out, /boom &lt;err&gt;/, 'failures surface inside the sheet, escaped');
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
  assert.match(live, /if \(e\.button !== 0\) return/, 'right-button holds belong to contextmenu');
  assert.match(live, /setTimeout\([\s\S]{0,120}?LONG_PRESS_MS\)/, 'the hold is a timer, not a click');
  assert.match(live, /Math\.hypot\([\s\S]{0,80}?\) > \d+\) cancelPress\(\)/, 'a scroll-sized move is not a hold');
  assert.match(live, /addEventListener\('pointerup', cancelPress\)/);
  assert.match(live, /addEventListener\('pointercancel', cancelPress\)/);
  assert.match(live, /pressConsumed[\s\S]{0,160}?stopPropagation/, 'the trailing click must be swallowed');
  assert.match(live, /\}, true\);/, 'the swallow must run in capture phase, ahead of the action delegate');
  assert.match(live, /addEventListener\('contextmenu'/, 'Android long-press and desktop right-click arrive here');
  assert.match(live, /openEditSheet\(/);
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
  assert.match(live, /unpick it first[\s\S]{0,220}?if \(!confirm\(/, 'guard first, question second');
  assert.match(live, /db\.updateMeal\(meal\.id, \{ archived: true \}\)/);
  assert.match(live, /catch[\s\S]{0,160}?errorMsg/, 'a failed archive stays in the sheet with its reason');
});

test('the edit submit glue uploads then updates, keeps failures in the sheet, never reclaims the replaced photo', () => {
  const hStart = html.indexOf("if (form.id === 'form-editmeal')");
  const hEnd = html.indexOf("if (form.id === 'form-additem')");
  assert.ok(hStart > 0 && hEnd > hStart, 'edit-meal handler markers found in index.html');
  const live = html.slice(hStart, hEnd)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.match(live, /await db\.uploadMealImage\(await resizeImage\(file\)\)/);
  assert.match(live, /db\.updateMeal\(meal\.id, fields\)/);
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
  assert.match(live, /if \(!confirm\([\s\S]{0,120}?\)\) return/, 'no silent destruction');
  assert.match(live, /el\.disabled = true;[\s\S]{0,80}?await db\.deleteWeek\(week\.id\)/,
    'the button dies before the request flies');
  assert.match(live, /state\.history = state\.history\.filter/, 'the cached list drops the record');
  assert.match(live, /location\.hash = '#\/history'/, 'deletion lands back on the list');
  assert.match(live, /catch[\s\S]{0,120}?el\.disabled = false/, 'a failed delete re-arms the button');
  assert.match(live, /alert\(/, 'a failed delete says so');
});

// ── installability: manifest, icons, keyboard focus ────────────────────

test('the page links the manifest and an apple touch icon', () => {
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/icon-180\.png">/);
});

test('keyboard focus has one loud treatment', () => {
  assert.match(html, /:focus-visible \{ outline: 3px solid var\(--mustard\)/);
});

test('the manifest is standalone, relative-scoped, and every icon it names is a real PNG of its declared size', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './', 'Pages serves from a subpath — an absolute URL would escape it');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.theme_color, '#1B5B9E');
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
