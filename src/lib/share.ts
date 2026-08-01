/**
 * Share links.
 *
 * The hash carries the drawn hero ids rather than the seed: a seed only
 * reproduces a draw against an identical pool, but ids are exact for everyone.
 */
import { MAX_SQUAD } from '../constants.ts';
import type { Hero } from '../types.ts';

export function squadToHash(squad: readonly Hero[]): string {
  return squad.map((hero) => encodeURIComponent(hero.id)).join(',');
}

/** Hero ids named by a `#squad=` value, in order. */
export function parseSquadHash(hash: string): string[] {
  const raw = new URLSearchParams(hash.replace(/^#/, '')).get('squad');
  if (!raw) return [];
  return raw.split(',').slice(0, MAX_SQUAD).map((id) => decodeURIComponent(id));
}

export function writeHash(squad: readonly Hero[]): void {
  if (!squad.length) return;
  history.replaceState(null, '', `${location.pathname}${location.search}#squad=${squadToHash(squad)}`);
}

export function readSharedDraw(byId: ReadonlyMap<string, Hero>): Hero[] {
  return parseSquadHash(location.hash)
    .map((id) => byId.get(id))
    .filter((hero): hero is Hero => hero !== undefined);
}

/** @returns true when the URL made it to the clipboard. */
export async function copyToClipboard(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    // The Clipboard API needs a secure context; fall back to a throwaway selection.
    const field = document.createElement('textarea');
    field.value = url;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    const copied = document.execCommand?.('copy') ?? false;
    field.remove();
    return copied;
  }
}
