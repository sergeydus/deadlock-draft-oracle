/**
 * A ServiceWorkerGlobalScope small enough to run `public/sw.js` under node.
 *
 * The worker is the one piece of this project that never runs in dev, never
 * runs in preview, and only ever runs in production — exactly the shape of the
 * `href="/"` bug. Static grep can prove it has no root-relative URL; only
 * executing it can prove a navigation falls back to the shell when the network
 * is gone, or that a roster feed is passed through untouched.
 *
 * Two things it models on purpose, because both hid real bugs:
 *
 *   - CacheStorage is **origin-wide**, not scope-wide. `seedCaches` puts a
 *     neighbouring project's cache alongside ours, so a worker that tidies up
 *     too enthusiastically is caught here rather than on github.io.
 *   - a cache write only lands if the worker stays alive for it. `defer()` holds
 *     writes open, `settle()` then commits them, and `terminate()` throws away
 *     everything not registered with `event.waitUntil()` — which is what a
 *     browser does to a worker the moment it stops being busy.
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

  constructor(shared) { this.shared = shared; }

  #key(request) { return typeof request === 'string' ? request : request.url; }

  /** Apply a write now, or hold it until settle()/terminate() decides its fate. */
  #write(apply) {
    if (!this.shared.deferring) { apply(); return Promise.resolve(); }
    return new Promise((resolve) => this.shared.held.push(() => { apply(); resolve(); }));
  }

  async put(request, response) { return this.#write(() => this.entries.set(this.#key(request), response)); }

  async match(request) {
    const hit = this.entries.get(this.#key(request));
    return hit ? hit.clone() : undefined;
  }

  async delete(request) {
    const key = this.#key(request);
    const had = this.entries.has(key);
    this.entries.delete(key);
    return had;
  }

  async keys() { return [...this.entries.keys()].map((url) => new Request(url)); }

  /** Atomic like the real thing: one bad response and nothing is written. */
  async addAll(urls) {
    const fetched = [];
    for (const url of urls) {
      const response = await this.shared.fetch(url);
      if (!response.ok) throw new TypeError('addAll: ' + url + ' -> ' + response.status);
      fetched.push([url, response]);
    }
    return this.#write(() => { for (const [url, response] of fetched) this.entries.set(url, response); });
  }
}

class FakeCacheStorage {
  stores = new Map();

  constructor(shared) { this.shared = shared; }

  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache(this.shared));
    return this.stores.get(name);
  }

  async keys() { return [...this.stores.keys()]; }

  async delete(name) { return this.stores.delete(name); }

  /** Origin-wide, exactly like the real one — every cache, not only ours. */
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
 * @param scope where the worker is served from — a subpath by default, since
 *   that is what production does and where the interesting failures live.
 * @param network (url, request) => Response | 'offline'
 * @param seedCaches {name: {url: body}} laid down before the worker runs.
 */
export function loadWorker({
  scope = 'https://example.test/deadlock-draft-oracle/',
  network,
  seedCaches = {},
} = {}) {
  const listeners = new Map();
  const calls = { skipWaiting: 0, claim: 0, fetched: [] };
  const shared = { deferring: false, held: [], fetch: null };
  /** Work a fetch handler asked the browser to keep it alive for. */
  const background = [];

  const respond = async (input, init) => {
    const made = input instanceof Request ? input : new Request(input, init);
    calls.fetched.push(made.url);
    const result = await network(made.url, made);
    if (result === 'offline') throw new TypeError('Failed to fetch');
    return result;
  };
  shared.fetch = respond;

  const caches = new FakeCacheStorage(shared);
  for (const [name, entries] of Object.entries(seedCaches)) {
    const cache = new FakeCache(shared);
    for (const [url, body] of Object.entries(entries)) cache.entries.set(url, new Response(body));
    caches.stores.set(name, cache);
  }

  const self = {
    location: new URL('sw.js', scope),
    caches,
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
  run(self, caches, respond, self.location);

  /** Dispatch an install/activate event and wait for what it registered. */
  const lifecycle = async (type) => {
    const handler = listeners.get(type);
    if (!handler) throw new Error('no ' + type + ' listener');
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
    listeners.get('fetch')({
      request: made,
      respondWith: (promise) => { answered = promise; },
      waitUntil: (promise) => { background.push(promise); },
    });
    return answered ? await answered : null;
  };

  /** Hold cache writes open, so it starts to matter whether the worker lives. */
  const defer = () => { shared.deferring = true; };
  /** Let the held writes through — the worker stayed alive for them. */
  const settle = async () => {
    for (const commit of shared.held.splice(0)) commit();
    await Promise.allSettled(background.splice(0));
  };
  /** Kill the worker: anything not registered with waitUntil is simply lost. */
  const terminate = () => { shared.held.splice(0); background.splice(0); };

  return {
    self, calls, caches, background,
    install: () => lifecycle('install'),
    activate: () => lifecycle('activate'),
    request, defer, settle, terminate,
  };
}

/** A believable built site: hashed bundle, hashed stylesheet, icons. */
export const shellHtml = (build = 'abc123') => [
  '<!doctype html><html><head>',
  '<link rel="icon" href="./favicon.svg" type="image/svg+xml" />',
  '<link rel="apple-touch-icon" href="./apple-touch-icon.png" />',
  '<link rel="stylesheet" href="./assets/index-' + build + '.css" />',
  '<script type="module" src="./assets/index-' + build + '.js"></script>',
  '<meta property="og:image" content="https://sergeydus.github.io/deadlock-draft-oracle/og.png" />',
  '</head><body><div id="root"></div></body></html>',
].join('\n');

export const SHELL_HTML = shellHtml();
