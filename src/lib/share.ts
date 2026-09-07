/**
 * Share links.
 *
 * The hash carries the drawn hero ids rather than the seed: a seed only
 * reproduces a draw against an identical pool, but ids are exact for everyone.
 *
 * Every roll writes the hash too, so it doubles as a permalink for the current
 * tab — which means the hash alone cannot tell "the draw I just rolled" from
 * "a link somebody sent me". A marker in `history.state` separates them: it is
 * restored on reload but absent on a fresh navigation, so a pasted link never
 * carries one. See `isOwnHash`.
 */
import { MAX_SQUAD } from '../constants.ts';
import type { Hero } from '../types.ts';

/** Namespaced so the marker cannot collide with state another library owns. */
const STATE_KEY = 'draftOracle';

interface OwnHashMarker { hash: string }

export function squadToHash(squad: readonly Hero[]): string {
  return squad.map((hero) => encodeURIComponent(hero.id)).join(',');
}

/**
 * The still-encoded value of one `key=` in a hash, or null.
 *
 * Deliberately not `URLSearchParams`, which decodes the whole value before we
 * can split it. Ids are encoded individually and joined with `,`, so decoding
 * first turns the `%2C` protecting an id's own comma back into a separator and
 * splits one hero into two. Splitting first and decoding after is the only
 * order that round-trips.
 */
function rawParam(hash: string, key: string): string | null {
  for (const pair of hash.replace(/^#/, '').split('&')) {
    const at = pair.indexOf('=');
    if (at !== -1 && pair.slice(0, at) === key) return pair.slice(at + 1);
  }
  return null;
}

/**
 * `decodeURIComponent` that cannot throw.
 *
 * The address bar is untrusted input and a lone `%` is not a valid escape —
 * browsers keep it verbatim, so `#squad=%` arrives here exactly as typed. This
 * used to throw URIError from inside the roster load, where the per-source catch
 * mistook it for a feed failure and left the app on "Loading" for good. A
 * malformed escape now decodes to itself, finds no hero, and takes the ordinary
 * "this link names nobody we know" path.
 */
function decodeOnce(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Hero ids named by a `#squad=` value, in order. */
export function parseSquadHash(hash: string): string[] {
  const raw = rawParam(hash, 'squad');
  if (!raw) return [];
  return raw.split(',').slice(0, MAX_SQUAD).map(decodeOnce).filter(Boolean);
}

function currentMarker(): OwnHashMarker | null {
  try {
    const state = history.state as Record<string, unknown> | null;
    const marker = state?.[STATE_KEY];
    return marker && typeof marker === 'object' && typeof (marker as OwnHashMarker).hash === 'string'
      ? marker as OwnHashMarker
      : null;
  } catch {
    return null;
  }
}

/**
 * True when the hash in the address bar is one this tab wrote by rolling, so it
 * must not be presented as somebody else's draw.
 *
 * The marker records the exact hash it was written for. Anything that changes
 * the hash without going through `writeHash` — a pasted link, a back/forward to
 * an entry we never wrote — leaves the two out of step, and the draw is treated
 * as shared, which is the safe direction to fail.
 */
export function isOwnHash(): boolean {
  const marker = currentMarker();
  return marker !== null && marker.hash === location.hash;
}

/** An absolute share URL for exactly the supplied squad, independent of the current hash. */
export function squadUrl(squad: readonly Hero[]): string {
  const base = location.href.split('#', 1)[0];
  return `${base}#squad=${squadToHash(squad)}`;
}

/** @returns false when the browser refuses the History API update. */
export function writeHash(squad: readonly Hero[]): boolean {
  if (!squad.length) return false;
  // Bind the marker to the hash being written, NOT to `location.hash`: that is
  // still the previous value here, and a stale marker never matches, which
  // silently turns every draw back into a "shared" one.
  const hash = `#squad=${squadToHash(squad)}`;
  try {
    const state = { ...(history.state as Record<string, unknown> | null), [STATE_KEY]: { hash } };
    history.replaceState(state, '', `${location.pathname}${location.search}${hash}`);
    return true;
  } catch {
    // Safari can rate-limit replaceState with SecurityError. A draw must remain
    // usable and banked even when the browser refuses to update its permalink.
    return false;
  }
}

/** Drop a `#squad=` that no longer describes anything, marker included. */
export function clearHash(): boolean {
  if (!location.hash) return true;
  try {
    const { [STATE_KEY]: _dropped, ...rest } = (history.state ?? {}) as Record<string, unknown>;
    history.replaceState(rest, '', `${location.pathname}${location.search}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the address bar names a draw that *this* roster cannot resolve
 * exactly, including a duplicated id.
 *
 * The third state between "no share link" and "a share link we restored": a
 * link with an id the roster in hand has never heard of, or one repeated twice.
 * Only a live roster is entitled to conclude that an unknown hero is gone — a
 * cached or incomplete one must leave the hash alone, or a link that would work
 * again on reconnect is destroyed while offline.
 */
export function hasUnresolvedShare(byId: ReadonlyMap<string, Hero>): boolean {
  if (isOwnHash()) return false;
  const ids = parseSquadHash(location.hash);
  return ids.length > 0
    && (new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id)));
}

export function readSharedDraw(byId: ReadonlyMap<string, Hero>): Hero[] {
  const ids = parseSquadHash(location.hash);
  if (!ids.length || new Set(ids).size !== ids.length) return [];
  const heroes: Hero[] = [];
  for (const id of ids) {
    const hero = byId.get(id);
    if (!hero) return [];
    heroes.push(hero);
  }
  return heroes;
}

/** @returns true when the URL made it to the clipboard. */
export async function copyToClipboard(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    // The Clipboard API needs a secure context; fall back to a throwaway selection.
    const previousFocus = document.activeElement as HTMLElement | null;
    const field = document.createElement('textarea');
    field.value = url;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    try {
      field.select();
      return document.execCommand?.('copy') ?? false;
    } catch {
      return false;
    } finally {
      field.remove();
      previousFocus?.focus?.();
    }
  }
}
