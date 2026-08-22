/**
 * A ServiceWorkerGlobalScope small enough to run `public/sw.js` under node.
 *
 * The worker is the one piece of this project that never runs in dev, never
 * runs in preview, and only ever runs in production — exactly the shape of the
 * `href="/"` bug. Static grep can prove it has no root-relative URL; only
 * executing it can prove a navigation falls back to the shell when the network
 * is gone, or that a roster feed is passed through untouched.
 *
 * Node supplies Request/Response/Headers; the rest is here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Enough of the Cache API for a shell cache: keyed by absolute URL string. */
class FakeCache {
  entries = new Map();
  constructor(fetch) { this.fetch = fetch; }
  #key(request) { return typeof request === 'string' ? request : request.url; }
  async put(request, response) { this.entries.set(this.#key(request), response); }
  async match(request) {
    const hit = this.entries.get(this.#key(request));
    return hit ? hit.clone() : undefined;
  }
  async addAll(urls) {
    for (const url of urls) {
      const response = await this.fetch(url);
      if (!response.ok) throw new Error(`addAll: ${url} -> ${response.status}`);
      this.entries.set(url, response);
    }
  }
}

class FakeCacheStorage {
  stores = new Map();
  constructor(fetch) { this.fetch = fetch; }
  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache(this.fetch));
    return this.stores.get(name);
  }
  async keys() { return [...this.stores.keys()]; }
  async delete(name) { return this.stores.delete(name); }
  async match(request) {
    for (const cache of this.stores.values()) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }
    return undefined;
  }
}

/**
 * Load `public/sw.js` into a fresh scope.
 *
 * @param origin where the worker is served from — a subpath by default, since
 *   that is what production does and where the interesting failures live.
 * @param network (url, request) => Response | 'offline'
 */
export function loadWorker({
  scope = 'https://example.test/deadlock-draft-oracle/',
  network,
} = {}) {
  const listeners = new Map();
  const calls = { skipWaiting: 0, claim: 0, fetched: [] };

  const respond = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.fetched.push(request.url);
    const result = await network(request.url, request);
    if (result === 'offline') throw new TypeError('Failed to fetch');
    return result;
  };

  const self = {
    location: new URL('sw.js', scope),
    caches: new FakeCacheStorage(respond),
    registration: { scope },
    clients: { claim: async () => { calls.claim++; } },
    skipWaiting: async () => { calls.skipWaiting++; },
    addEventListener: (type, handler) => listeners.set(type, handler),
    fetch: respond,
  };

  const source = readFileSync(join(root, 'public/sw.js'), 'utf8');
  // `self`, `caches` and `fetch` are globals inside a worker; hand them in as
  // parameters so the file itself needs no test-only seam.
  const run = new Function('self', 'caches', 'fetch', 'location', source);
  run(self, self.caches, respond, self.location);

  /** Dispatch an install/activate event and wait for what it registered. */
  const lifecycle = async (type) => {
    const handler = listeners.get(type);
    if (!handler) throw new Error(`no ${type} listener`);
    let waited;
    handler({ waitUntil: (promise) => { waited = promise; } });
    await waited;
  };

  /**
   * Dispatch a fetch event.
   * @returns the Response the worker chose, or null if it declined to handle it
   *   (which means the browser would go to the network itself).
   */
  const request = async (url, { mode, ...init } = {}) => {
    // 'navigate' is rejected by the Request constructor — only the browser may
    // mint one — so it is layered on afterwards, which is all the worker reads.
    const made = new Request(url, { method: 'GET', ...init });
    if (mode) Object.defineProperty(made, 'mode', { value: mode });
    let answered = null;
    listeners.get('fetch')({ request: made, respondWith: (promise) => { answered = promise; } });
    return answered ? await answered : null;
  };

  return { self, calls, install: () => lifecycle('install'), activate: () => lifecycle('activate'), request };
}

/** A believable built site: hashed bundle, hashed stylesheet, icons. */
export const SHELL_HTML = `<!doctype html><html><head>
<link rel="icon" href="./favicon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="./apple-touch-icon.png" />
<link rel="stylesheet" href="./assets/index-abc123.css" />
<script type="module" src="./assets/index-def456.js"></script>
<meta property="og:image" content="https://sergeydus.github.io/deadlock-draft-oracle/og.png" />
</head><body><div id="root"></div></body></html>`;
