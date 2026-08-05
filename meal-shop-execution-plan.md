# Weekly Meal & Shop — Execution Plan

*Revision 2 — Supabase required from the start*

---

## 1. What this replaces

Four Google Keep notes and a calculator:

1. **Meals** — checklist of mains you pick from each week
2. **Breakfast options** — 15 numbered options
3. **Menu** — Mon–Sun, a breakfast and a main per day, each main cooked for dinner and carried into the next day's lunch
4. **Grocery note** — items with rough prices, tallied by hand against the week's budget

The app keeps that exact rhythm. It removes the retyping, the jumping between notes, and the manual arithmetic.

---

## 2. Decisions locked

| Question | Decision |
|---|---|
| Images | You curate — paste a URL or pick a photo. App works fully with none. |
| Groceries | Staples list you tick, plus free manual rows. No ingredient auto-suggestion. |
| History | Read-only look-back at past weeks |
| Data | **Supabase from day one.** Same weeks on every device. |
| Sign-in | Email magic link, once per device |
| Hosting | Netlify, static |
| Budget | Never blocks. Goes negative, colour warns. |
| Theme | Bright, menu-board |
| Swapping | Tap two dinners to trade days. Monday lunch implicit. |

---

## 3. Stack

A **single `index.html`** — markup, styles and script in one file. No React, no bundler, no `npm install`.

The Supabase client loads from CDN as an ES module:

```html
<script type="module">
  import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
</script>
```

Why still one file: the app is four screens and about a dozen interactive pieces. A build step would double your deployment friction and buy nothing. One file means Netlify accepts it directly, and changing a default price later is a text edit rather than a rebuild.

Fonts come from Google Fonts over CDN. Everything else is hand-written.

Accepted trade-off: the file lands around 1,600–1,900 lines with the Supabase layer in. Organised into clearly marked sections, but it is one file.

---

## 4. Why Supabase changes more than the storage line

Worth being blunt about this before you commit, because it is the one decision in the plan with a real cost attached.

**What you gain.** Plan on a laptop, shop from your phone, same data. Nothing to export or re-enter. Clearing your browser wipes nothing. History survives a lost phone.

**What it costs you.**

- **Sign-in exists now.** A magic link per device, once. The session persists for weeks, so in practice you'll rarely see it — but it's a screen that didn't exist before.
- **No network, no app.** This matters more than it sounds: the moment you most need the grocery list is standing in a market, which is exactly where connectivity is worst.
- **Setup before first use.** Roughly 15 minutes: create the project, run one SQL script, paste two values into the file.
- **A project that can go idle.** Supabase pauses free projects after a week of no requests. Weekly use keeps it awake; a month away means unpausing from the dashboard first.

**The mitigation, built into Phase 1.** Every successful load writes a copy of the current week to browser storage. If the app opens without a connection it renders that copy read-only, with a plain banner: *"Offline — showing last saved copy. Changes won't save."* You can always read your list in the market. You just can't tick things off until you're back on data.

That's a deliberate compromise. Full offline editing means conflict resolution — two devices, two versions of Tuesday — and that is a much larger build than everything else in this plan put together. Not worth it for one person planning one week.

---

## 5. Data model

Three tables — `meals`, `staples`, `weeks`. Every row is scoped to your user id, enforced by row-level security in the database rather than trusted to the app.

The DDL lives in **`schema.sql`** at the repo root — that file is the single source of truth, and it's what you run in the SQL Editor. Beyond the three tables it carries the production details: RLS policies scoped `to authenticated` using the cached `(select auth.uid())` form, `user_id` defaults, indexes on the policy columns, and a trigger that maintains `weeks.updated_at`. (An earlier revision inlined the SQL here; it drifted from the real file, so the copy was removed.)

### Shapes inside the JSON columns

```
picks      { mains: [mealId], breakfasts: [mealId] }
days       { mon: { breakfast: mealId, dinner: mealId }, tue: {...}, ... }
groceries  [ { name, price, checked, stapleId } ]
```

### Two modelling decisions worth naming

**Lunch is never stored.** It's computed at render time as the previous day's dinner. That single choice means a swap can never leave your lunches inconsistent — there's no second copy to fall out of step. Monday carries no lunch row at all.

**Days and groceries are `jsonb`, not normalised rows.** A week saves in one round trip instead of twenty, and the shape maps straight onto the screen. The cost: you can't easily query *"how often did I cook pasta this year."* Since history is read-only look-back, that query isn't on the table. If you ever want it, the JSON is still queryable in Postgres — just less pleasantly.

### Writes

Every change writes to the current week's row, debounced at 800ms so typing a price doesn't fire eight requests. A small state dot in the header reads **Saved** / **Saving** / **Offline**, so you're never guessing.

### Images

Phase 1 takes a pasted URL only, stored as text. Nothing to configure.

Phase 2 adds photo upload through a public Supabase Storage bucket called `meal-images`, resized to 400px wide JPEG in the browser before it leaves your phone — roughly 30–50KB each, well inside the 1GB free tier.

---

## 6. Screens

Bottom tab bar, four tabs, hash routing so your phone's back button behaves.

### Sign in
One field, one button: *"Email me a link."* Then *"Check your email — the link signs you in on this device."* On first-ever sign-in the app seeds your library and staples, so you land on a full Pick screen rather than an empty one.

### Pick
Mains / Breakfasts toggle. Two-column card grid — image if you've added one, coloured name tile if not. Tap to select, tap again to drop. Sticky header counts `4 / 7` for the active tab. Last tile is **Add a meal**: name, kind, image, done. Long-press a card to edit or remove it.

### Week
Held behind a message until you have 7 mains and 7 breakfasts: *"Pick 7 mains and 7 breakfasts to build your week."*

Then seven day cards, each showing breakfast, **cooking tonight**, and lunch in muted type noting it came from yesterday's pot. Monday shows no lunch.

Tap a dinner to lift it, tap another to trade — lunches shift with them automatically. Breakfasts swap the same way, independently.

### Budget
Amount at top: *"To spend this week."*

Then your staples, each a tick and an editable price prefilled from last time. Below, **Add an item** for anything off-list. Editing a staple's price updates its remembered value for next week.

Sticky footer, always visible: total, then remaining in large mono numerals. Green while there's room, amber inside the last 10%, red and negative past zero. A **Fruits — whatever's left** toggle claims the remainder as its own line.

### Summary
The single page you shop from. Week table, grocery list with prices, total against budget. **Save this week** flips the row to `saved` and opens a fresh draft.

### History
Saved weeks newest first — date, spend, budget. Tap for that week's summary, read-only.

---

## 7. Design direction

Grounded in a hand-painted hoteli menu board. Bright enamel paint, not muted wellness pastels.

**Palette**

| Role | Hex |
|---|---|
| Enamel blue | `#1B5B9E` |
| Mustard | `#F2B21B` |
| Tomato | `#E23E2C` |
| Leaf | `#2E7D46` |
| Chalk | `#FBF6EA` |
| Ink | `#17140F` |

**Type** — `Anton` for display and day names, tight and shouty. `Work Sans` for body. `DM Mono` for every price and total, so money columns align and read like a receipt.

**Signature** — the Week screen as a painted board: each day a ruled line item, day name in condensed caps at left, meal lettered across, prices in mono. It's the screen you'll open most, so it gets the boldness.

Everything else stays quiet. Motion limited to slot-lift on swap and a count-up on the remaining figure, both disabled under reduced-motion.

---

## 8. Seed data

Written on first sign-in, all editable, none permanent.

**Mains (12)** — chapo + chicken stew, rice biriani, chapo + maini stew, fish fillet, meat balls, tumbukiza + chapo, steak, pasta salad, potato salad, noodles, matoke, cheesy hot dogs

**Breakfasts (15)** — weetabix; nwaci + egg + avocado; oats; uji + peanuts; boiled maize + egg; liver + vegetables; mandizi + vegetables; mushroom + scrambled; bone soup + buns; pumpkin soup + buns; butter soup + buns; smoothie + cake; grape salad; cornflakes + egg; mbaazi + mahamri

**Staples** — maize 50, eggs 100, beans (1kg), carrots, spinach, bell peppers, lettuce, chicken 400, pork 350, beef 200

---

## 9. Build phases

**Phase 1 — usable end to end.**
Supabase schema, magic link sign-in, seeding, offline read-only fallback, design tokens, nav, Pick, Week with swapping, Budget, Summary. Images by pasted URL. You can plan a real week and deploy the same day.

**Phase 2 — the rest of the promise.**
Photo upload to Storage, staple price memory, save to history, History screen.

**Phase 3 — polish.**
Library editing and archiving, delete a saved week, keyboard focus states, web manifest so it installs to your home screen with a proper icon.

---

## 10. Setup, in order

The sequence matters — magic links need to know your live URL, so the app gets deployed before auth is finished.

1. **Create the Supabase project** at supabase.com. Free tier, no card. Note the region closest to you.
2. **Run `schema.sql`** in the SQL Editor. One paste, one run.
3. **Copy two values** from Project Settings → API: the project URL and the `anon` public key. Paste them into the `CONFIG` block at the top of `index.html`. Both are safe to have in a public file — row-level security is what protects your data, not key secrecy.
4. **Deploy to Netlify.** Either drag the file onto `netlify.com/drop`, or put it in a GitHub repo and connect Netlify to it. The repo route means editing the file on github.com redeploys automatically, including from your phone.
5. **Point auth at the live URL.** Supabase → Authentication → URL Configuration: set Site URL to your Netlify address. Without this, magic links land on localhost and fail.
6. **Sign in and seed.** First sign-in writes your library and staples.
7. **Add to Home Screen** from your browser menu. After Phase 3 it opens without browser chrome.

---

## 11. Limits to know now

- **No network, no editing.** You can read the last-loaded week offline; you can't change it. Section 4 explains why.
- **Free tier pauses after a week idle.** Weekly use avoids this. A long break means unpausing from the dashboard.
- **No ingredient auto-suggestion.** Choosing seven mains tells the grocery screen nothing — you still tick and type. Your call, and it keeps the app honest, but it's the one place work isn't removed.
- **Magic links need a working inbox.** Supabase's free email sending is rate-limited and occasionally slow. If it becomes annoying, the fix is pointing Supabase at a free Resend account, about 10 minutes.

---

## 12. Resolved (2026-08-05)

1. Week starts **Monday**.
2. Breakfasts do **not** repeat within a week — seven distinct picks, tap-to-select stays as designed.
3. Currency — **`KSh 1,200`** on totals and the budget figure; plain `1,200` on individual line items.
4. Offline check-offs — **allowed**. Ticking items on Summary works offline: ticks queue in browser storage and replay on reconnect. Everything else stays read-only offline. This amends the "no editing offline" line in sections 4 and 11 — a tick is a one-way flag, so it merges without the conflict-resolution cost that ruled out full offline editing.
