/**
 * Offline shell for the Draft Oracle.
 *
 * Scope is everything this file can reach, and it is served from the site root
 * (`public/` is copied verbatim by Vite), so on Pages that is
 * `/deadlock-draft-oracle/` — the whole app and nothing else. Every URL in here
 * is relative to this script for the same reason `base: './'` exists: the site
 * is not at an origin root in production.
 *
 * What it deliberately does NOT cache:
 *   - the roster feeds. The store already caches the roster in localStorage and
 *     knows how far to trust it; a second, dumber copy in here would fight it.
 *   - hero portraits. Cross-origin, numerous, and worthless without a roster.
 * Both fall out of one rule: cross-origin requests are passed straight through.
 *
 * Scope does NOT extend to storage. CacheStorage is origin-wide, and every
 * Pages project under the same account shares `sergeydus.github.io` — so this
 * worker names its own caches with a prefix, deletes only those, and never
 * reads through `caches.match()`, which searches all of them.
 *
 * Bump CACHE when the shell's caching behaviour changes. Hashed asset names
 * make content staleness a non-issue, so this is only for wholesale eviction.
 */
const CACHE_PREFIX = 'draft-oracle-shell-';
const CACHE = CACHE_PREFIX + 'v2';

/** The document itself — the URL a navigation falls back to when offline. */
const SHELL = new URL('./', self.location).href;

/**
 * The same-origin files a shell document cannot boot without.
 *
 * Vite emits the bundle under a content hash, so its name cannot be written
 * down here. Rather than generate a manifest at build time, read it out of the
 * shell — always in step with the build, with no plugin to keep in sync.
 *
 * This does assume Vite keeps emitting double-quoted `src`/`href` attributes,
 * which it does today. The offline-shell checks in scripts/verify.mjs run this
 * against a realistic shell, so a change in that would surface as a precache
 * that suddenly holds nothing but the document.
 */
const shellAssets = (html) => [...new Set(
  [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => new URL(match[1], SHELL))
    .filter((url) => url.origin === self.location.origin && !url.pathname.endsWith('.png'))
    .map((url) => url.href),
)];

/**
 * Make `response` the shell we fall back to — assets first, document last.
 *
 * The order is the whole point. A deployment does not necessarily reinstall the
 * worker, since `sw.js` is often byte-identical between builds; the running
 * worker learns about it from an online navigation instead. Writing the new
 * HTML first and picking up its assets as they happen to be requested leaves a
 * window where the cached document names hashes that are not in the cache, and
 * anything that ends the window early — the tab closing, the worker being
 * terminated, one asset failing — leaves an offline app that cannot boot.
 *
 * So: fetch what the new document needs, and only once all of it is stored
 * does the document itself change. `addAll` is all-or-nothing, so a half-broken
 * deploy throws here and the previous working shell simply stays.
 */
async function adoptShell(response) {
  const cache = await caches.open(CACHE);
  const html = await response.text();

  const current = await cache.match(SHELL);
  if (current && (await current.text()) === html) return; // same build, nothing to do

  const assets = shellAssets(html);
  const missing = [];
  for (const url of assets) if (!(await cache.match(url))) missing.push(url);
  await cache.addAll(missing);
  await cache.put(SHELL, new Response(html, { headers: response.headers }));

  // Only now is the previous build unreferenced and safe to drop. This runs on
  // a real change of build, so runtime-cached extras survive in between.
  const keep = new Set([SHELL, ...assets]);
  const spent = (await cache.keys()).filter((request) => !keep.has(request.url));
  await Promise.all(spent.map((request) => cache.delete(request)));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const response = await fetch(SHELL, { cache: 'reload' });
    if (!response.ok) throw new Error('shell ' + response.status);
    await adoptShell(response);
    // Take over at once. The app is a single bundle with no lazy chunks, so
    // there is no half-updated state for a claimed page to trip over.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Our own older versions, and nothing else: the caches next to ours on this
    // origin belong to other projects.
    const outgrown = (await caches.keys()).filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE);
    await Promise.all(outgrown.map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // feeds and portraits: not ours

  // Navigations go to the network first. GitHub Pages serves this HTML with
  // `max-age=600`, so it can already be up to ten minutes stale; serving it
  // from a service-worker cache on top of that would mean a deploy takes an
  // unbounded time to reach anyone. The cache is the offline fallback only.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        // A reachable server can still be temporarily unable to serve the app.
        // Keep genuine 404s as 404s, but prefer the last working shell over a
        // transient server failure.
        if (fresh.status >= 500) {
          const cache = await caches.open(CACHE);
          return (await cache.match(SHELL)) ?? fresh;
        }
        // Behind the navigation, not in front of it — and held open with
        // waitUntil, because the browser may terminate this worker the moment
        // the response settles, and a detached write is simply lost. A failure
        // here is the half-broken-deploy case: keep the shell we have.
        if (fresh.ok) event.waitUntil(adoptShell(fresh.clone()).catch(() => {}));
        return fresh;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match(SHELL)) ?? Response.error();
      }
    })());
    return;
  }

  // Everything else the site owns is content-hashed or an icon: cache-first,
  // filling on the way past.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request);
    if (hit) return hit;
    const fresh = await fetch(request);
    if (fresh.ok) event.waitUntil(cache.put(request, fresh.clone()));
    return fresh;
  })());
});
