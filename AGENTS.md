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

Needs Node 22.6+, and runs without a flag from 23.6 (CI pins 24, and `.nvmrc`
names it). `npm test` goes through
`scripts/test.mjs`, which adds `--experimental-strip-types` on Node 22.6–23.5 and
otherwise says what to install — the raw failure is an `ERR_UNKNOWN_FILE_EXTENSION`
that mentions no version at all.

## File map

| Path | Contains |
|---|---|
| `src/main.tsx`, `src/App.tsx` | Entry point; global key/hash listeners and the initial load. |
| `src/store/OracleStore.ts` | **All application state.** One MobX class; a singleton `store` is imported directly by components. |
| `src/lib/` | Logic with no store import and no mutable application state. A pure core — `feed` (parsing), `pool` (filters), `random` (seeded draws), `css`, and `roster`’s parse/merge half — and a browser edge: `share` (URL + clipboard), `storage` (localStorage), `roster`’s fetching. |
| `src/lib/eggs.ts` | **Every easter egg**, as pure rules and copy. See *Easter eggs* below — spoilers. |
| `src/components/` | Presentation only. Most components are `observer`s; `Controls.tsx` holds plain presentational pieces (`ChipGroup`, `FilterRow`, `ToggleRow`) and `StageArt` reads only its props, so neither needs one. |
| `src/styles.css` | **Plain global stylesheet, not CSS Modules.** See below. |
| `public/` | Favicon, touch icon, the `og.png` share card and `sw.js`. Copied into `dist/` verbatim. |
| `public/sw.js` | The offline shell. Plain JS on purpose — `public/` is not compiled. |
| `scripts/test.mjs` | `npm test` entry point; picks the Node flags, then runs the harness. |
| `scripts/verify.mjs` | The checks themselves — see *Verifying a change*. |
| `scripts/sw-harness.mjs` | A `ServiceWorkerGlobalScope` small enough to run `public/sw.js` under node. |

## The five rules

1. **State lives in `OracleStore`, and only there.** Components read observables
   and call store methods; they hold no state of their own beyond view-local
   concerns (`StageArt`'s decoded-image URL is the one exception, and it is
   derived from a prop). Everything shown is a field or a computed getter — there
   is no repaint step, because observers re-render themselves. That is the point
   of the MobX layer: the old hand-written `render()` plus twelve sync functions
   kept producing bugs where one surface stopped being refreshed.
2. **`src/lib/` never imports the store and never owns mutable application
   state.** That part is absolute. Purity is not: `feed`, `pool`, `random`,
   `css` and `roster`'s parsing and merging are pure functions, and the tests
   exercise them with no setup at all — `drawFrom`/`drawSquad` take the RNG as a
   parameter, `eligibleHeroes` takes a criteria object. But `share` reads
   `location`/`history` and writes the clipboard, `storage` reads
   `localStorage`, and `roster` fetches. Those are the browser edge, and
   `scripts/browser-shims.mjs` exists for them. Put new logic in the core if it
   can go there; if it cannot, it belongs beside `share` and `storage`, not
   smuggled into a module that is currently pure.
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
  `roleFilterUsable()` is true, and `store.showRoleControls` delegates to the same
  function so the control on screen and the rule in force cannot drift. It wants
  **two** distinct roles, not one: a partial merge that turned up a single role
  used to be enough to apply the filter while still being too few for the chips.
  Any future filter fed by enrichment-only data needs the same guard.
- **The address bar is untrusted input.** `#squad=%` is not a valid escape and
  browsers keep it verbatim, so it reaches `parseSquadHash` as typed. It used to
  throw `URIError` from inside `adoptRoster`, where `load()`'s per-source catch
  filed it as a dead feed and left the app on "Loading" for good. Nothing in
  `share.ts` may throw on a hash a user can type. Do not reintroduce
  `URLSearchParams` there either: it decodes before the split, which turns the
  `%2C` protecting an id's own comma back into a separator.
- **`shared` is a claim about the address bar.** The stage may label a draw
  `SHARED DRAW` only while the hash names *that* draw. A hashchange resolving to
  nothing therefore has to retire the claim whatever it decides about the URL
  itself — otherwise `copyLink()`, which deliberately does not rewrite the hash
  for a received draw, hands out a link to heroes the stage is not showing.
  `applySharedFromHash` reuses `adoptRoster`'s `stranded` rule rather than
  inventing its own, so a live roster replaces a dead hash and a cached one
  leaves it for a reconnect, on both paths alike. The suite sweeps the invariant
  over every shape a hash can change into.
- **`eligible` is not the draw pool.** `eligibleHeroes()` is the strict filter;
  `poolFor()` relaxes avoid-recent rather than starve a draw. Anything the user
  reads about "how many can be drawn" — the settings count, the empty stage —
  must come from `store.drawPool`, or the screen says 0 next to a button that
  draws.
- **An empty pool has more than one cause.** Excluding the whole roster, and a
  complexity or role combination that matches nobody, are different acts. Copy
  that names only exclusions is wrong advice for the second, which reaches
  `mode === 'empty'` with `excluded.size === 0`.
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
  Attributes are only half of it: a URL passed to `serviceWorker.register`,
  `fetch` or `new URL` is just as absolute and just as invisible. `npm test`
  scans those call sites too, across `src/` **and** `public/`. It is
  deliberately a list of call sites rather than "any string starting with
  `/`" — the broad version flags route patterns, regexes and CSS paths, and a
  guard that cries wolf gets deleted. Add your call site to the list when you
  introduce one.
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
  consequences. The live feed arriving means `adoptRoster()` runs a *second*
  time, so it takes a `RosterConfidence` — `provisional`, `cached` or `live`. A
  **provisional** roster does nothing irreversible. It does not prune saved ids — the cache can predate a
  hero, and pruning against it deletes that hero’s exclusion for good — and it
  does not bank its opening draw, which may name someone the live roster no
  longer has. Both happen when a feed confirms the roster, or when every feed
  has failed and the cache becomes all there is. Priming is also skipped when a
  roster is already displayed, so a manual refresh never replaces live data
  with an older copy of itself.
- **The social-card URLs are the one exception to the relative-URL rule.** A
  crawler reading `og:image` has no document to resolve it against, so that tag
  and `og:url` are absolute and hardcoded to the deployed `homepage`. `npm test`
  asserts they still match `package.json` and that `og.png` is really the
  1200x630 the tags claim. Everything else — including the two icon `<link>`s —
  stays relative.
- **Recents persist as `{id, name}`, not whole heroes.** Only those two fields are ever read — the id keeps a hero out of the next draw, the name labels the chip — and storing full records meant every field added to `Hero` made `isHeroRecord` reject the saved list. The name is kept rather than resolved from the roster on purpose: with no roster and no cache, it is the only thing the chips have left to show. A list written by the old schema still loads, since a full `Hero` satisfies `isRecentPick`.
- **The service worker caches the shell and nothing else.** It only ever runs
  in production — never under `npm run dev` or `npm run preview` — which is the
  same blind spot that shipped an `href="/"` to a 404, so
  `scripts/sw-harness.mjs` runs the real `public/sw.js` under node and
  `npm test` drives it through install, activate and fetch.
  **Registration is `'./sw.js'`**, resolved against the document, which is the
  deployed directory; `'/sw.js'` fails its scope check outright, and
  `import.meta.url` would resolve against the hashed bundle in `assets/` and
  scope the worker to a directory no navigation ever reaches.
  **Cross-origin requests are passed straight through**, which is what keeps the
  worker out of the store's way: the roster has exactly one cache, in
  `localStorage`, with one set of rules about how far to trust it, and hero
  portraits are not worth carrying without a roster. **Navigations are
  network-first**, because Pages already serves this HTML with `max-age=600`;
  answering them from the worker's cache as well would put a deploy an unbounded
  distance from its audience. The cache is the offline fallback only.
- **Scope does not extend to storage.** A worker's scope decides which URLs it
  answers for. `CacheStorage` is origin-wide, and `sergeydus.github.io` is one
  origin for *every* Pages project under the account. So caches are named with
  the `draft-oracle-shell-` prefix and activation deletes only those — treating
  "not the current cache" as "stale" would delete a neighbouring project's data.
  For the same reason nothing reads through `caches.match()`, which searches
  every cache on the origin and can hand back a neighbour's copy of a URL we
  also own; open the named cache and match against that.
- **A cache write has to be registered with `event.waitUntil()`.** Once the
  promise passed to `respondWith()` settles, the browser is free to terminate
  the worker, and a detached `cache.put()` is simply lost — intermittently, and
  only in production. A fake cache that resolves instantly cannot show this, so
  `sw-harness.mjs` models it directly: `defer()` holds writes open and
  `background` records what the worker asked the browser to wait for.
- **A deploy updates the shell assets-first, document-last.** `sw.js` is usually
  byte-identical between builds, so a deployment does not reinstall the worker —
  the running one meets the new build through an online navigation instead. If
  it cached the new HTML and picked up the new hashes as they happened to be
  requested, then anything ending that window early (the tab closing, the worker
  being terminated, one asset failing) would leave a cached document naming
  assets nobody has, and the offline app would stop booting. `adoptShell()`
  therefore fetches everything the new document references, and only then
  replaces the document; `addAll` is all-or-nothing, so a half-broken deploy
  keeps the last shell that worked. The previous build's assets are dropped only
  after the swap succeeds. Bump `CACHE` when the caching behaviour changes;
  content staleness is already handled by the hashed names.
- **The `Space` shortcut ignores auto-repeat.** Without that guard a held key
  fires `keydown` continuously: one press measured **21 draws** on production,
  inflating a lifetime tally that persists and flushing recents in a second.
  Anything else bound to a key needs the same `event.repeat` check.
- **Two `localStorage` keys**: `draftOracle_v1` (settings/history) and
  `draftOracle_v1_roster` (the offline roster cache). Reading either can throw in
  private mode — every access is already wrapped.

## Easter eggs

**Spoilers.** They are listed because an undocumented egg is indistinguishable
from a bug, and the next person to read `OracleStore` will otherwise "clean up"
a counter that looks dead.

All seven live in `src/lib/eggs.ts` — pure rules and copy, no DOM — with the
store holding the counters and the components rendering the result. **None of
them touches a draw.** No egg changes the pool, the RNG, or the odds; a user who
never finds one loses nothing, and `npm test` asserts that finding one leaves
the eligible pool identical.

| Egg | How it is found | Where |
|---|---|---|
| **Arcane mode** | The Konami code, typed outside a text field. Toggles. | `arcane` on the store, persisted; `.hero-stage.arcane` in the stylesheet |
| **Secret searches** | Twelve words typed into the hero search. | `SECRETS`; `secretSignal` getter → `RosterPanel` |
| **The insistent oracle** | The same hero drawn three times running. | `noteStreak()` |
| **Milestones** | Crossing 50 / 100 / 250 / 500 / 1000 lifetime draws. | `milestoneCrossed()` in `recordDraw()` |
| **Prophecy** | Seven quick taps on the stage eyebrow, or typing `oracle`. | `tapEyebrow()`, `INVOCATION` |
| **Impatience** | Five rolls inside three seconds. | `noteRollPace()` |
| **Nobody left** | Excluding every hero in the roster. | `everyoneExcluded` getter → `HeroStage` |

Five of these have a trap that is easy to reintroduce:

- **Milestones must test crossing, not equality.** A squad draw adds up to six
  at once, so counts step `43 → 49 → 55` and hit 50 exactly never.
- **The streak cannot be read off `recent`**, which de-duplicates on write. It
  needs its own counter, and it deliberately ignores slot rerolls — those draw
  from a pool with the current hero removed, so they can never repeat one.
- **A secret search term must match no hero.** The search box matches names *and*
  aliases, and aliases carry seventeen languages plus romanizations and
  nicknames. A collision silently un-hides the egg: the user gets a hero card and
  never sees the answer. The live-feed half of `npm test` checks all twelve
  against both feeds — as it does that no prophecy names a hero, since the roster
  changes with the game.
- **"Everyone excluded" is not "the pool is empty."** A complexity or role filter
  empties the pool too, and telling that user to un-exclude heroes they never
  excluded is worse than saying nothing.
- **The eggs share one toast between them.** `noteStreak()` runs after
  `recordDraw()`, so when a draw both completes a three-run *and* crosses a
  milestone, the streak line is the one left standing. `npm test` pins that, so
  reordering it is a visible decision rather than a silent change.
- **Every egg is reachable without a mouse.** The eyebrow tap cannot be — it is a
  decorative `div`, and making it a button would put a tab stop in front of the
  app's primary control and announce "button, THE ORACLE CHOOSES" without
  explaining what it does. So the prophecy has a second trigger instead, the
  `INVOCATION` key sequence, and the two routes are the same egg. Neither is
  discoverable — that is the point — but both are operable, which is the actual
  requirement. Any new egg bound to a pointer needs the same treatment.
  The eyebrow also carries `user-select: none`, because seven quick clicks on
  text otherwise selects it and looks broken.
- **An egg that only shows text has to reach the live region too.** A secret
  search paints the oracle's reply into the roster grid, and `rosterAnnouncement`
  returns that reply instead of "0 heroes match" — otherwise the egg exists only
  for people who can see it.
- **Only a roll that can draw counts toward impatience.** `Space` stays live on an
  empty stage, so the pace check is gated on a non-empty pool; without that,
  five presses that drew nothing still earned a scolding.

Two things make egg tests flaky if you forget them, and both cost a run to find:

- **`load()` draws before your test does anything.** A test that narrows the pool
  to one hero and counts a streak starts at two, not one, whenever that opening
  draw happened to pick the same hero — one run in eight. Pin the pool to a hero
  the opening draw did *not* produce.
- **Leave `avoidRecent` on unless the test is about turning it off.** With it off,
  a three-run can happen inside any warm-up loop, and its toast overwrites
  whichever line the test was actually checking. With it on and a healthy roster
  the pool cannot repeat a hero, so nothing else can fire.

## Verifying a change

```bash
npm test              # imports the real modules; includes the live feeds
npm run test:offline  # same, minus the network checks
npm run typecheck     # tsc --noEmit, strict
```

`scripts/verify.mjs` imports `src/**` directly and runs under plain `node` via
native TypeScript stripping — no test runner, no build. The floor is **Node 22.6**,
which `package.json` declares; `scripts/test.mjs` adds `--experimental-strip-types`
below 23.6, where stripping is still behind a flag (CI pins 24). It is why
`src/lib` imports use explicit `.ts` extensions: Node's ESM resolver requires them.

CI (`.github/workflows/ci.yml`) splits deliberately:

- **`verify`** runs `test:offline` + `build`. Deterministic, gates merges. There
  is no separate typecheck step because `build` is `tsc --noEmit && vite build` —
  `npm run typecheck` is for the quicker local loop.
- **`feeds`** runs the live half. `continue-on-error` on pull requests — a
  third-party outage is not a contributor's problem — and on the **daily schedule**
  it retries once and then opens or comments on a `feed-canary` issue. That nightly
  run is the point: it is how you learn a roster API moved before your users do.

`scripts/browser-shims.mjs` supplies the browser globals — for the store, and for
the `lib` modules at the browser edge that it leans on. Leaving that layer
untested is how the share-hash bug survived a suite that covered every pure piece
it was built from. Import the shims *before* the store.

None of that renders a page, so this manual list still matters (console must stay
clean) — though steps 1 and 7 through 9 now have automated cover. Step 10 has
none, which is the point of it:

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
9. Offline (devtools → Network → Offline) → refresh. Two separate things have to
   work: the **shell** loads at all, which is the service worker's cache, and a
   hero is drawn from the **roster** cache in `localStorage` — appearing
   immediately rather than after the feeds time out, with the status pill
   settling on `Cached roster · …` once they do. Before the worker existed only
   the second half was ours; the first was whatever the browser had kept.
10. After a deploy: load the live site, wait, then reload twice. The second
    reload should be running the new build. `sw.js` is usually byte-identical
    between builds, so the worker is not reinstalled — it picks the new build up
    through a navigation, which is the path worth eyeballing by hand until the
    browser E2E is committed.
11. Tab through the page from the address bar. Every control takes a visible
    acid ring, the search box included — it suppresses its own outline, so it is
    the one that regresses silently. The suite checks the rule exists; only this
    checks it is actually painted.

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
