/**
 * Browser globals for the verification harness.
 *
 * `src/lib/` is pure and needs none of this, which is why the draw, pool and
 * feed checks run with no setup at all. But the store is not pure — it reads
 * `localStorage`, writes the URL through `history` and talks to the clipboard —
 * and leaving it untested is how the share-hash bug survived: every piece it is
 * built from was covered, the way it wires them together was not.
 *
 * These are the smallest shims that let the real `OracleStore` run under node.
 * Import this module *before* anything that touches the globals; ESM evaluates
 * imports in source order.
 */

/** Backing store for the localStorage shim, so a test can inspect what was written. */
export const storage = new Map();

globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
};

/** Mirrors the parts of `location` the app reads. `hash` is kept in sync by replaceState. */
export const location = {
  pathname: '/deadlock-draft-oracle/', // the Pages subpath, not the origin root
  search: '',
  hash: '',
  get href() { return `https://example.test${this.pathname}${this.search}${this.hash}`; },
};
globalThis.location = location;

globalThis.history = {
  state: null,
  replaceState(state, _title, url) {
    this.state = state;
    const at = String(url).indexOf('#');
    location.hash = at === -1 ? '' : String(url).slice(at);
  },
};

// `navigator` is a getter-only global in node, so it has to be redefined.
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
});

/**
 * Reset every global between scenarios.
 * @param hash the address bar the app should wake up to.
 * @param state `history.state` for that entry — null is what a pasted link has.
 * @param keepStorage survive the reset, for scenarios that reload the same profile.
 */
export function resetBrowser({ hash = '', state = null, keepStorage = false } = {}) {
  if (!keepStorage) storage.clear();
  location.hash = hash;
  location.search = '';
  globalThis.history.state = state;
}

/**
 * Replace `fetch`. Pass a feed payload to serve it to every source, or a
 * function for per-URL control. `'fail'` rejects; `'hang'` never settles until
 * the caller's AbortController fires, which is how the timeout path is timed.
 */
export function stubFetch(behaviour) {
  globalThis.fetch = async (url, { signal } = {}) => {
    const result = typeof behaviour === 'function' ? behaviour(String(url)) : behaviour;
    if (result === 'fail') throw new Error('stubbed network failure');
    if (result === 'hang') {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return { ok: true, json: async () => result };
  };
}

/** The real fetch, so the live-feed checks still work after a scenario stubbed it. */
const realFetch = globalThis.fetch;
export function restoreFetch() { globalThis.fetch = realFetch; }
