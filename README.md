# Deadlock Draft Oracle

**[Play it →](https://sergeydus.github.io/deadlock-draft-oracle/)**

A hero randomizer for [Deadlock](https://store.steampowered.com/app/1422450/Deadlock/).
Pulls the live hero roster from the community data feeds and draws you a hero —
or a whole six-stack.

## Features

- **Live roster** from `deadlock.io`, falling back to `deadlock-api.com`, then to a
  local cache when both are unreachable. Neither feed is complete on its own, so
  the second is merged into the first in the background.
- **Squad draws** — pick 1 to 6 heroes at once, never a duplicate, with a per-slot
  reroll so you can redraw one teammate without disturbing the rest.
- **Role coverage** — squad draws can guarantee one hero of each role before
  filling the remaining slots.
- **Filters** — by complexity (the game's own 1–4 rating) and role
  (marksman / assassin / mystic / brawler). Exclude any hero by clicking its card,
  hide unreleased/test characters, and keep your last five picks out of the pool.
- **Shareable draws** — *Copy draw link* produces a URL that reproduces the exact
  result for anyone who opens it.
- **Search in any language** — matches all 17 localized spellings plus
  romanizations, so `火男` and `infa-nasu` both find Infernus.
- **Per-hero colour** — the stage takes on the drawn hero's own accent colour.
- **Draw log** — a lifetime tally of what the oracle actually favours.
- Everything persists in `localStorage`. <kbd>Space</kbd> rerolls.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production bundle into dist/
```

React + TypeScript + MobX, built with Vite.

```bash
npm test              # exercises the draw logic and feed parser against the live APIs
npm run test:offline  # just the deterministic half
npm run typecheck     # tsc --noEmit, strict
```

The test harness imports the source directly and runs under plain `node` via
native TypeScript stripping — no test runner. It needs Node 23.6 or newer.

CI runs the deterministic checks and a production build on every pull request, and
the live-feed checks nightly — the roster APIs are community-run, so that
scheduled run is an early warning that one has changed shape or moved.

## Deploying

Every push to `master` rebuilds and publishes to GitHub Pages
(`.github/workflows/pages.yml`). There is no server: the app is static files that
talk to the roster APIs from the browser. To enable it on a fork, set
**Settings → Pages → Source** to **GitHub Actions**.

## Contributing

See [AGENTS.md](AGENTS.md) for the architecture, the invariants to preserve, and
the manual smoke-test checklist.

## Data sources

Roster data comes from community-run APIs. This project is unofficial and not
affiliated with Valve.
