/** Which heroes a draw may pick from. Pure — the store passes its state in. */
import { ROLE_ORDER } from '../constants.ts';
import type { Hero } from '../types.ts';

export interface PoolCriteria {
  heroes: readonly Hero[];
  excluded: ReadonlySet<string>;
  /** Only ids are read; a full Hero or a RecentPick both satisfy this. */
  recent: readonly { id: string }[];
  complexity: ReadonlySet<number>;
  roles: ReadonlySet<string>;
  avoidRecent: boolean;
  releasedOnly: boolean;
  /** Relax the avoid-recent rule for this call only. */
  ignoreRecent?: boolean;
}

/** Roles the roster actually carries, in canonical order. */
export function availableRoles(heroes: readonly Hero[]): string[] {
  return ROLE_ORDER.filter((role) => heroes.some((hero) => hero.role === role));
}

/**
 * Whether a role filter may be applied at all.
 *
 * This is the same predicate the UI uses to decide whether to show the role
 * chips, and that is the whole point: filtering by a control the user cannot
 * see leaves them with an empty pool and no way out. The store's
 * `showRoleControls` delegates here so the two can never drift.
 *
 * Two roles, not one. Roles arrive from the enrichment pass, so a failure there
 * leaves every hero roleless and a saved filter would empty the pool; a partial
 * merge that turned up a single role used to be enough to apply the filter while
 * still being too few for the chips to appear.
 */
export function roleFilterUsable(heroes: readonly Hero[]): boolean {
  return availableRoles(heroes).length > 1;
}

export function eligibleHeroes(criteria: PoolCriteria): Hero[] {
  const { heroes, excluded, recent, complexity, roles, avoidRecent, releasedOnly, ignoreRecent = false } = criteria;
  const avoid = !ignoreRecent && avoidRecent ? new Set(recent.map((pick) => pick.id)) : new Set<string>();
  // A saved role filter outlives the data it depends on: roles only arrive from
  // the enrichment pass, so if that fails (offline, or the other feed is down)
  // no hero has one. Applying the filter then empties the pool — and the role
  // chips are hidden in that state, so there is no control left to clear it.
  const roleFilter = roles.size && roleFilterUsable(heroes) ? roles : null;
  return heroes.filter((hero) => (!releasedOnly || hero.released)
    && !excluded.has(hero.id)
    && !avoid.has(hero.id)
    // An unrated hero is never filtered out by complexity.
    && (!hero.complexity || complexity.has(hero.complexity))
    && (!roleFilter || roleFilter.has(hero.role)));
}

/** The pool for a draw of `size`, relaxing avoid-recent only if it would starve the draw. */
export function poolFor(size: number, criteria: PoolCriteria): Hero[] {
  const strict = eligibleHeroes(criteria);
  return strict.length >= size ? strict : eligibleHeroes({ ...criteria, ignoreRecent: true });
}

/** Candidates for one squad slot, relaxing recents but never the squad's uniqueness. */
export function replacementPool(
  size: number,
  currentId: string,
  held: ReadonlySet<string>,
  criteria: PoolCriteria,
): Hero[] {
  const available = (heroes: readonly Hero[]) => heroes.filter((hero) => !held.has(hero.id) && hero.id !== currentId);
  const strict = available(poolFor(size, criteria));
  return strict.length ? strict : available(eligibleHeroes({ ...criteria, ignoreRecent: true }));
}
