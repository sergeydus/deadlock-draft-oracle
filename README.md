# Deadlock Draft Oracle

A hero randomizer for [Deadlock](https://store.steampowered.com/app/1422450/Deadlock/).
Pulls the live hero roster from the community data feeds and draws you a hero —
or a whole six-stack.

## Features

- **Live roster** from `deadlock.io`, falling back to `deadlock-api.com`, then to a
  local cache when both are unreachable.
- **Squad draws** — pick 1 to 6 heroes at once, never a duplicate, with a per-slot
  reroll so you can redraw one teammate without disturbing the rest.
- **Shareable draws** — *Copy draw link* produces a URL that reproduces the exact
  result for anyone who opens it.
- **Filters** — by complexity (the game's own 1–4 rating) and role
  (marksman / assassin / mystic / brawler). Exclude any hero by clicking its card,
  hide unreleased/test characters, and keep your last five picks out of the pool.
- **Role coverage** — squad draws can guarantee one hero of each role before
  filling the remaining slots.
- **Search in any language** — the roster search matches all 17 localized
  spellings plus romanizations, so `火男` and `infa-nasu` both find Infernus.
- **Per-hero colour** — the stage takes on the drawn hero's own accent colour.
- **Draw log** — a lifetime tally of what the oracle actually favours.
- Everything persists in `localStorage`. <kbd>Space</kbd> rerolls.

## Run it

```bash
npm start          # http://localhost:5173
# or, without npm:
python -m http.server 5173
```

Serve it over http rather than opening `index.html` directly — the roster fetch is
CORS-blocked from a `file://` origin.

There is no build step and no runtime dependencies: `index.html`, `app.js` and
`styles.css` are loaded straight by the browser.

```bash
npm test            # exercises the feed parser and draw logic against the live APIs
npm run typecheck   # type-checks app.js through its JSDoc annotations
```

## Contributing

See [AGENTS.md](AGENTS.md) for the architecture, the invariants to preserve, and
the manual smoke-test checklist.

## Data sources

Roster data comes from community-run APIs. This project is unofficial and not
affiliated with Valve.
