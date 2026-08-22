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
 * Bump CACHE when the shell's caching behaviour changes. Hashed asset names
 * make content staleness a non-issue, so this is only for wholesale eviction.
 */
const CACHE = 'draft-oracle-shell-v1';

/** The document itself — the URL a navigation falls back to when offline. */
const SHELL = new URL('./', self.location).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Vite emits the bundle under a content hash, so its name cannot be written
    // down here. Rather than generate a manifest at build time, read the shell
    // we just fetched and precache exactly what it asks for — always in step
    // with the build, with no plugin to keep in sync.
    const response = await fetch(SHELL, { cache: 'reload' });
    if (!response.ok) throw new Error(`shell ${response.status}`);
    const html = await response.text();
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => new URL(match[1], SHELL))
      .filter((url) => url.origin === self.location.origin && !url.pathname.endsWith('.png'))
      .map((url) => url.href);
    await cache.put(SHELL, new Response(html, { headers: response.headers }));
    await cache.addAll([...new Set(refs)]);
    // Take over at once. The app is a single bundle with no lazy chunks, so
    // there is no half-updated state for a claimed page to trip over.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const stale = (await caches.keys()).filter((key) => key !== CACHE);
    await Promise.all(stale.map((key) => caches.delete(key)));
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
        if (fresh.ok) (await caches.open(CACHE)).put(SHELL, fresh.clone());
        return fresh;
      } catch {
        return (await caches.match(SHELL)) ?? Response.error();
      }
    })());
    return;
  }

  // Everything else the site owns is content-hashed or an icon: cache-first,
  // filling on the way past.
  event.respondWith((async () => {
    const hit = await caches.match(request);
    if (hit) return hit;
    const fresh = await fetch(request);
    if (fresh.ok) (await caches.open(CACHE)).put(request, fresh.clone());
    return fresh;
  })());
});
