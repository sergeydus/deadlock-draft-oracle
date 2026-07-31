# CLAUDE.md

See **[AGENTS.md](AGENTS.md)** — it is the single source of truth for how this
project is laid out, the invariants to preserve, and how to verify a change.

Two things that are easy to get wrong and worth repeating here:

- **No build step.** Three files loaded straight by the browser. No `import` /
  `export`, no JSX, no npm runtime dependencies.
- **Serve over http** (`npm start`), not `file://` — the roster fetch is
  CORS-blocked from a `null` origin.
