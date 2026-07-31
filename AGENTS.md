# AGENTS.md

Orientation for AI coding agents (and new humans). Read this before editing.
`CLAUDE.md` points here — this file is the single source of truth.

## What this is

**Deadlock Draft Oracle** — a hero randomizer for the game *Deadlock*. It pulls the
live hero roster from community APIs, then draws a random hero (or a full squad of
six) with filters, exclusions and a shareable result link.

**Three files, no build step, no dependencies.** `index.html` + `app.js` +
`styles.css`, loaded directly by the browser. There is no bundler, no transpiler
and no framework. Do not add `import`/`export`, JSX, TypeScript syntax or npm
runtime dependencies without first converting the project to a real build — that
is a deliberate architectural choice, not an oversight.

## Run it

```bash
npm start          # npx serve on http://localhost:5173
# or, with no npm at all:
python -m http.server 5173
```

Then open <http://localhost:5173>.

Opening `index.html` as a `file://` URL mostly works but the roster fetch may be
blocked by CORS (the page origin is `null`), so it will fall back to the cached
roster or the offline state. **Always test over http.**

## File map

| File | Contains |
|---|---|
| `index.html` | Markup + three `<template>` elements (hero card, squad slot, tally row). Every element JS touches has an `id`. |
| `app.js` | All logic, organised into labelled `/* ── Section ── */` blocks. |
| `styles.css` | All styling. Design tokens in `:root`. Same section-comment convention. |
| `scripts/verify.mjs` | `npm test` — see *Verifying a change*. The only file that is not shipped to the browser. |

`app.js` sections, in file order: Randomness → Storage helpers → Feed parsing →
Small DOM helpers → Pool selection → Share links → Rendering → Roster loading →
Wiring.

## Data model

One `Hero` shape, normalised out of whichever feed answered:

```js
{ id: string, name: string, description: string, image: string, released: boolean }
```

`id` is the primary key for **everything**: exclusions, the draw tally, roster card
lookup and share links. It is deliberately derived from the engine class name
(`hero_inferno` → `inferno`), which **both feeds expose**, so the same hero gets
the same id whichever source answered — a failover must not orphan a user's saved
exclusions or invalidate share links. `npm test` asserts this. If you change how
`id` is derived in `normalise()`, you invalidate every user's saved `localStorage`
and every share link in the wild.

All app state lives in the single `state` object at the top of `app.js`. It is
documented with a JSDoc typedef — update that typedef when you add a field.

## The five rules

1. **`state` is the only source of truth.** `render()` derives every visible
   surface from it and never mutates it. Event handlers mutate `state`, then call
   `render()`.
2. **The roster grid is built once** by `buildRoster()` per roster load.
   `syncRosterState()` and `applySearch()` only toggle classes and `hidden` on
   existing cards. Never rebuild the grid on a keystroke or a toggle.
3. **Feed parsing is defensive.** The two sources return different shapes and both
   change without notice, so `unwrap()` / `normalise()` / `imageFrom()` tolerate
   missing or renamed fields and return `null`/`''` rather than throwing. Keep it
   that way; do not "simplify" them to direct property access.
4. **Anything restored from `localStorage` is untrusted** and passes
   `isHeroRecord()` or an explicit type check first. It may have been written by an
   older version of the schema.
5. **Randomness goes through `rng()`**, the seeded PRNG — never `Math.random()`
   directly. `reseed()` is called at the start of each draw. This exists so a draw
   is reproducible from a seed, which is the hook an online-lobby mode would need.

## Change recipes

| Goal | Touch |
|---|---|
| New filter on the draw pool | `eligibleHeroes()` — plus a control in `index.html` and a field in `saveState`/`loadState` |
| New persisted setting | `state` typedef → `saveState()` → `loadState()` → `render()` |
| New feed source | Append to `SOURCES`; verify `normalise()` handles its field names |
| Change the stage display | `updateStage()` only |
| New derived UI | Add a `renderX()` and call it from `render()` |

## Gotchas

- **`[hidden]` needs the CSS override** at the top of `styles.css` — several
  components set `display`, which otherwise beats the UA `[hidden]` rule.
- **Share links carry hero ids, not the seed** (`#squad=id1,id2,…`). A seed only
  reproduces a draw against an identical pool; ids are exact for every recipient.
  A draw restored from a link is *not* recorded in recents or the tally.
- **The `Space` shortcut deliberately skips** when a button, link or input has
  focus, so it does not shadow that control's own activation.
- **`setStageArt()` uses a token guard** so a slow image from an earlier roll can
  never overwrite a newer one.
- **The two feeds differ a lot.** `deadlock.io` wraps heroes under a `heroes` key
  and uses localized objects (`displayName.english`, `playstyle.english`);
  `deadlock-api.com` returns a bare array with `description.{lore,role,playstyle}`
  and art under `images.icon_hero_card`. `normalise()` handles both — check
  `npm test` output after touching it.
- **Descriptions can be long lore paragraphs** for newer heroes (they have no
  short blurb), which is why `.hero-description` is line-clamped to 3.
- **Two `localStorage` keys**: `draftOracle_v1` (settings/history) and
  `draftOracle_v1_roster` (the offline roster cache). Reading either can throw in
  private mode — every access is already wrapped.

## Verifying a change

```bash
npm test            # runs scripts/verify.mjs against the live feeds
npm run test:offline  # same, minus the network checks
npm run typecheck   # TypeScript over the JSDoc annotations; no TS files, no emit
```

`scripts/verify.mjs` cannot `import` from `app.js` (no module system), so it
**slices the pure sections out of the real source** by their `/* ── Section ── */`
markers and runs them in Node. If you rename a marker, update the slice bounds —
it throws rather than testing less. The network half doubles as an upstream canary:
it is what caught `deadlock-api.com` moving its heroes endpoint.

Neither check touches the DOM, so this manual smoke list still matters. Run it
over http with devtools open — the console must stay clean:

1. Roster loads, status pill goes green, a hero is drawn automatically.
2. `Space` and **PICK MY HERO** both draw; the art crossfades with no empty flash.
3. Squad size 6 → six distinct slots; per-slot `↻` replaces only that slot; a slot
   click features it on the stage.
4. Search filters the grid; clicking a card toggles exclusion; the eligible count
   moves.
5. **Copy draw link** → open the URL in a new tab → the same draw appears labelled
   `SHARED DRAW`, and it does not add to the draw log.
6. Reload → exclusions, recents, draw log and squad size all survive.
7. Offline (devtools → Network → Offline) → refresh → falls back to the cached
   roster instead of hanging.
