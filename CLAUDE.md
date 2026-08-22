# CLAUDE.md

See **[AGENTS.md](AGENTS.md)** — it is the single source of truth for how this
project is laid out, the invariants to preserve, and how to verify a change.

Three things that are easy to get wrong and worth repeating here:

- **All state lives in `src/store/OracleStore.ts`.** Components are `observer`s
  that read it and call its methods. There is no repaint step.
- **`src/styles.css` is a plain global stylesheet, not CSS Modules.** Class names
  in components are a contract with it — renaming one silently unstyles an element.
- **`src/lib/` imports no store and holds no mutable app state.** Its core —
  `feed`, `pool`, `random`, `css` — is pure and tests with no setup. Its edge —
  `share`, `storage`, `roster`'s fetching — talks to the browser, which is what
  `scripts/browser-shims.mjs` is for. Do not assume a `lib` module is pure.
