/** Loading the roster from the community feeds. */
import { FETCH_TIMEOUT_MS, SOURCES } from '../constants.ts';
import type { Hero, Source } from '../types.ts';
import { MERGEABLE_FIELDS, normalise, unwrap } from './feed.ts';

/** Fetch JSON with a hard timeout so one dead provider cannot stall the app. */
export async function fetchJson(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Parse one feed payload into a sorted, de-duplicated roster. */
export function parseRoster(raw: unknown, origin: string): Hero[] {
  const seen = new Set<string>();
  return unwrap(raw)
    .map((entry, index) => normalise(entry, index, origin))
    .filter((hero): hero is Hero => hero !== null)
    .filter((hero) => !seen.has(hero.id) && Boolean(seen.add(hero.id)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchRoster(source: Source): Promise<Hero[]> {
  const heroes = parseRoster(await fetchJson(source.url), source.origin);
  if (heroes.length < 5) throw new Error('The feed returned too few heroes');
  return heroes;
}

/**
 * Copy metadata the base feed did not carry from another source, keyed by id.
 *
 * Neither feed is complete on its own: deadlock-api has `hero_type` and the
 * accent colour, deadlock.io has the 17-language names and search aliases. Ids
 * are derived from the engine class name so they match across both, which is
 * what makes this merge possible.
 *
 * Mutates `heroes` in place so every reference to a hero sees the update.
 * @returns whether anything changed.
 */
export function mergeInto(heroes: Hero[], extras: ReadonlyMap<string, Hero>): boolean {
  let changed = false;
  for (const hero of heroes) {
    const extra = extras.get(hero.id);
    if (!extra) continue;
    for (const field of MERGEABLE_FIELDS) {
      if (!hero[field] && extra[field]) { hero[field] = extra[field]; changed = true; }
    }
    if (!hero.complexity && extra.complexity) { hero.complexity = extra.complexity; changed = true; }
  }
  return changed;
}

/**
 * Fetch the sources that did not supply the roster, for their metadata.
 *
 * Deliberately returns the extras rather than merging them: the caller holds
 * observable heroes, and mutating those has to happen inside a MobX action.
 * Best-effort — a failure costs a filter or a colour, never the roster.
 * @param skip sources that just failed; no point asking again.
 * @returns the other feed's heroes by id, or null if none could be reached.
 */
export async function fetchEnrichment(
  baseSourceName: string,
  skip: ReadonlySet<string> = new Set(),
): Promise<Map<string, Hero> | null> {
  for (const source of SOURCES.filter((candidate) => candidate.name !== baseSourceName && !skip.has(candidate.name))) {
    try {
      return new Map(parseRoster(await fetchJson(source.url), source.origin).map((hero) => [hero.id, hero]));
    } catch { /* enrichment is optional – keep the base roster as-is */ }
  }
  return null;
}
