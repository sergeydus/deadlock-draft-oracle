# AGENTS.md

Orientation for AI coding agents (and new humans). Read this before editing.
`CLAUDE.md` points here — this file is the single source of truth.

## What this is

**Deadlock Draft Oracle** — a hero randomizer for the game *Deadlock*. It pulls the
live hero roster from community APIs, then draws a random hero (or a full squad of
six) with filters, exclusions and a shareable result link.

**React + TypeScript + MobX, built with Vite.** It was vanilla JS with no build
step until the roster grew past what hand-written DOM updates could keep straight;
the migration was done as groundwork for an online-lobby mode.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production bundle into dist/
npm run preview    # serve the built bundle at the origin root
npm run preview:subpath   # …and at the /deadlock-draft-oracle/ path Pages uses
```

Needs Node 23.6+ (CI pins 24, and `.nvmrc` names it). `npm test` goes through
`scripts/test.mjs`, which adds `--experimental-strip-types` on Node 22.6–23.5 and
otherwise says what to install — the raw failure is an `ERR_UNKNOWN_FILE_EXTENSION`
that mentions no version at all.

## File map

| Path | Contains |
|---|---|
| `src/main.tsx`, `src/App.tsx` | Entry point; global key/hash listeners and the initial load. |
| `src/store/OracleStore.ts` | **All application state.** One MobX class; a singleton `store` is imported directly by components. |
| `src/lib/` | Pure logic, no DOM and no store: `feed` (parsing), `random` (seeded draws), `pool` (filters), `roster` (fetch + merge), `storage`, `share`, `css`. |
| `src/components/` | Presentation only. Every component is an `observer`. |
| `src/styles.css` | **Plain global stylesheet, not CSS Modules.** See below. |
| `public/` | Favicon, touch icon and the `og.png` share card. Copied into `dist/` verbatim. |
| `scripts/test.mjs` | `npm test` entry point; picks the Node flags, then runs the harness. |
| `scripts/verify.mjs` | The checks themselves — see *Verifying a change*. |

## The five rules

1. **State lives in `OracleStore`, and only there.** Components read observables
   and call store methods; they hold no state of their own beyond view-local
   concerns (`StageArt`'s decoded-image URL is the one exception, and it is
   derived from a prop). Everything shown is a field or a computed getter — there
   is no repaint step, because observers re-render themselves. That is the point
   of the MobX layer: the old hand-written `render()` plus twelve sync functions
   kept producing bugs where one surface stopped being refreshed.
2. **`src/lib/` stays pure.** No DOM, no store import, no module-level mutable
   state. `drawFrom`/`drawSquad` take the RNG as a parameter and `eligibleHeroes`
   takes a criteria object, which is why the tests need no mocks or stubs.
3. **Feed parsing is defensive.** The two sources return different shapes and both
   change without notice, so `unwrap`/`normalise`/`imageFrom` tolerate missing or
   renamed fields and return `null`/`''` rather than throwing. Do not "simplify"
   them to direct property access.
4. **Anything restored from `localStorage` is untrusted** and passes
   `isHeroRecord()` or an explicit type check first. It may have been written by
   an older schema.
5. **Randomness goes through a seeded `mulberry32`**, never `Math.random()`. A
   draw is reproducible from its seed, which is the hook the lobby mode needs:
   the server broadcasts one seed and every client derives the same draw.

## Styling

`src/styles.css` is **hand-written global CSS applied by class name** — deliberately
not CSS Modules. The design predates the React port and is the app's best asset, so
the port kept the DOM structure and every class name identical and imported the
stylesheet unchanged. Two consequences:

- Class names in components are a **contract with the stylesheet**. Renaming one in
  a component silently unstyles an element. `npm test` asserts that every class
  `styles.css` targets is still produced somewhere in the source.
- Adding a component means adding CSS to the same shared file, in the existing
  section-comment style.

## Data model

One `Hero` shape (`src/types.ts`), normalised out of whichever feed answered.

`id` is the primary key for **everything**: exclusions, the draw tally, roster
lookup and share links. It is deliberately derived from the engine class name
(`hero_inferno` → `inferno`), which **both feeds expose**, so the same hero gets the
same id whichever source answered — a failover must not orphan a user's saved
exclusions or invalidate share links. `npm test` asserts this. Changing how `id` is
derived invalidates every saved `localStorage` and every share link in the wild.

**Neither feed carries every field.** `deadlock-api` has `role` and `accent`;
`deadlock.io` has the 17-language names and search aliases. So the store loads a
base roster from the first source that answers, then `OracleStore.enrich()` fetches the
*other* source in the background and fills in the blanks, merged by `id`. It is
best-effort: if it fails you lose a filter and a colour, never the roster.

## Change recipes

| Goal | Touch |
|---|---|
| New filter on the draw pool | `PoolCriteria` + `eligibleHeroes()` in `lib/pool.ts`, a field and getter on the store, a control in `SettingsPanel` |
| New persisted setting | `PersistedState` in `lib/storage.ts` → `restore()`/`persist()` on the store |
| Something new in recents | `RecentPick` in `types.ts` — keep it to what the chip renders |
| New feed source | Append to `SOURCES`; verify `normalise()` handles its field names |
| Use another feed field | `Hero` → `normalise()` → `isHeroRecord()` → `MERGEABLE_FIELDS` |
| Change the stage | `components/HeroStage.tsx` only |
| Change what a draw announces | `announcement` getter on the store |

## Gotchas

- **A saved role filter outlives the data it needs.** Roles only arrive from
  enrichment, so a filter persisted from a healthy session would match nothing on
  a session where enrichment failed — and the chips are hidden then, leaving no way
  to clear it. `eligibleHeroes()` therefore ignores the role filter unless
  `hasRoleData()` is true. Any future filter fed by enrichment-only data needs the
  same guard.
- **Role data has upstream gaps.** Familiar has never carried a `hero_type`, and a
  hero with `role: ''` is unreachable while a role filter is active — intended
  (filtering to "marksman" must not return an unclassified hero). `npm test` fails
  if more than two released heroes lose their role.
- **Every box showing hero art is shaped to the art's real 280x380 ratio.** That is
  the only portrait size either feed ships, and the characters fill the canvas
  (measured: 90–98% of the height), so a box of the wrong shape makes
  `background-size: cover` throw the character away. Two separate bugs came from
  that. `npm test` checks the CSS ratios, the art opacities, and that upstream is
  still 280x380.
- **Never use the `background` shorthand on an art element.** React sets
  `background-image` inline, and the shorthand resets `repeat`/`size`/`position`,
  which made the portrait tile at natural size. `npm test` guards this.
- **Descriptions can be long lore paragraphs** for newer heroes, which is why
  `.hero-description` is line-clamped to 3.
- **Share links carry hero ids, not the seed** (`#squad=id1,id2,…`). A seed only
  reproduces a draw against an identical pool; ids are exact for every recipient. A
  draw restored from a link is *not* recorded in recents or the tally.
- **Every roll writes the hash too, so the hash alone cannot say who wrote it.**
  `writeHash()` therefore stamps `history.state` with a marker naming the exact
  hash it wrote, and `isOwnHash()` compares the two; only a hash without a
  matching marker is treated as somebody else's draw. The marker survives a
  reload and is absent on a fresh navigation, which is the whole trick. Without
  it a reload relabelled your own pick `SHARED DRAW`, suppressed the opening
  draw, and could hand back a hero you had excluded. **Bind the marker to the
  hash being written, never to `location.hash`** — that is still the previous
  value while `replaceState` runs, and a marker that never matches restores the
  bug silently.
  The marker means exactly *this tab produced the draw this hash describes* —
  not "the app has seen this hash". So `commitDraw()` writes the hash only when
  `record` is true, and `copyLink()` only when the draw is not already shared:
  a received link keeps the sender's hash untouched and still reads as
  `SHARED DRAW` after a reload. Rolling or rerolling afterwards makes the draw
  this tab's own, and the next reload opens with a fresh draw as usual.
- **A root-relative URL breaks in production only.** The app is served from a repo
  subpath, so `href="/"` leaves the site; `base: './'` cannot help, because Vite
  rewrites index.html and imported assets but never a runtime attribute. Neither
  `npm run dev` nor `npm run preview` reproduces it — both serve from the origin
  root — so `npm test` asserts no component builds one.
  `npm run preview:subpath` mounts the build where Pages does and is the way to
  check anything base-related by hand, but it does not reproduce *this* bug
  either: `vite preview` redirects the origin root back to the app (302) where
  Pages returns 404, so a root-relative link looks like it works. The static
  check is what actually guards it.
- **The stage owns the app's draw announcement.** The `<h1>` is keyed on the draw,
  so it is replaced rather than updated and no assistive tech reads it. One
  `role="status"` node in `HeroStage` says what was drawn, and it includes the
  pick number so that two identical draws in a row still change the text. Do not
  put `aria-live` back on `.roster-grid`: it holds every card, and a keystroke in
  the search box then announces batches of them.
- **The `Space` shortcut deliberately skips** when a button, link or input has
  focus, so it does not shadow that control's own activation.
- **The roster cache is painted first, not last.** `load()` calls
  `primeFromCache()` synchronously, before its first `await`, so a returning
  visitor has a usable roster on the same tick. It used to be the last resort,
  read only once every source had exhausted `FETCH_TIMEOUT_MS` — measured at 16s
  of "Loading" with a complete roster already in `localStorage`. Two
  consequences: the live feed arriving means `adoptRoster()` runs a *second*
  time, which is safe only because it keeps the pick already on screen; and
  priming is skipped when a roster is already displayed, so a manual refresh
  never replaces live data with an older copy of itself.
- **The social-card URLs are the one exception to the relative-URL rule.** A
  crawler reading `og:image` has no document to resolve it against, so that tag
  and `og:url` are absolute and hardcoded to the deployed `homepage`. `npm test`
  asserts they still match `package.json` and that `og.png` is really the
  1200x630 the tags claim. Everything else — including the two icon `<link>`s —
  stays relative.
- **Recents persist as `{id, name}`, not whole heroes.** Only those two fields are ever read — the id keeps a hero out of the next draw, the name labels the chip — and storing full records meant every field added to `Hero` made `isHeroRecord` reject the saved list. The name is kept rather than resolved from the roster on purpose: with no roster and no cache, it is the only thing the chips have left to show. A list written by the old schema still loads, since a full `Hero` satisfies `isRecentPick`.
- **Two `localStorage` keys**: `draftOracle_v1` (settings/history) and
  `draftOracle_v1_roster` (the offline roster cache). Reading either can throw in
  private mode — every access is already wrapped.

## Verifying a change

```bash
npm test              # imports the real modules; includes the live feeds
npm run test:offline  # same, minus the network checks
npm run typecheck     # tsc --noEmit, strict
```

`scripts/verify.mjs` imports `src/**` directly and runs under plain `node` via
native TypeScript stripping — no test runner, no build. That requires **Node 23.6+**,
or 22.6+ with `--experimental-strip-types`, which `scripts/test.mjs` supplies for
you (CI pins 24). It is why `src/lib` imports use explicit `.ts` extensions: Node's ESM
resolver requires them.

CI (`.github/workflows/ci.yml`) splits deliberately:

- **`verify`** runs typecheck + `test:offline` + `build`. Deterministic, gates merges.
- **`feeds`** runs the live half. `continue-on-error` on pull requests — a
  third-party outage is not a contributor's problem — and on the **daily schedule**
  it retries once and then opens or comments on a `feed-canary` issue. That nightly
  run is the point: it is how you learn a roster API moved before your users do.

`scripts/browser-shims.mjs` supplies the browser globals the store needs — it is
not pure, and leaving it untested is how the share-hash bug survived a suite that
covered every piece it is built from. Import those shims *before* the store.

None of that renders a page, so this manual list still matters (console must stay
clean) — though steps 1, 7 and 8 now have automated cover:

1. Roster loads, status pill goes green, a hero is drawn automatically.
2. `Space` and **PICK MY HERO** both draw; the art crossfades with no empty flash
   and the heading animation replays even on a repeated hero.
3. Squad size 6 → six distinct slots; per-slot `↻` replaces only that slot; a slot
   click features it on the stage.
4. Search filters the grid, including `火男` and `infa-nasu` for Infernus; clicking
   a card toggles exclusion; the eligible count moves.
5. Complexity chips and (a moment after load, once enrichment lands) role chips
   filter the pool; deselecting the last complexity level is refused.
6. The stage ambience changes colour per drawn hero.
7. **Copy draw link** → open the URL in a new tab → the same draw appears labelled
   `SHARED DRAW`, and it does not add to the draw log.
8. Reload → exclusions, recents, draw log, squad size and filters all survive.
9. Offline (devtools → Network → Offline) → refresh → the cached roster appears
   immediately, not after the feeds time out, and the status pill settles on
   `Cached roster · …` once they do.

## Shipping it

Push to `master` and `.github/workflows/pages.yml` builds and publishes to
GitHub Pages: <https://sergeydus.github.io/deadlock-draft-oracle/>. It reruns
`test:offline` before building, so a red `master` cannot ship; the live-feed
checks are excluded on purpose, since an upstream outage must not block a deploy.

The app is served from the repo-name subpath, which is why `vite.config.ts` sets
`base: './'` — **do not change it to `'/'`**, that breaks every asset URL in
production while leaving `npm run dev` looking fine. Anything you add that builds
a URL must stay relative for the same reason.

No 404 fallback is configured and none is needed: navigation state lives in the
hash (`#squad=…`), so Pages only ever serves `index.html`. Introducing real
path-based routing would require adding a `404.html` copy of the entry page.
