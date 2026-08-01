# CLAUDE.md

See **[AGENTS.md](AGENTS.md)** — it is the single source of truth for how this
project is laid out, the invariants to preserve, and how to verify a change.

Three things that are easy to get wrong and worth repeating here:

- **All state lives in `src/store/OracleStore.ts`.** Components are `observer`s
  that read it and call its methods. There is no repaint step.
- **`src/styles.css` is a plain global stylesheet, not CSS Modules.** Class names
  in components are a contract with it — renaming one silently unstyles an element.
- **`src/lib/` is pure.** No DOM, no store import, no module-level mutable state;
  that is what keeps the tests free of mocks.
