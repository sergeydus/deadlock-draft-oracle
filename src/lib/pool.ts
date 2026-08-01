/** Which heroes a draw may pick from. Pure — the store passes its state in. */
import type { Hero } from '../types.ts';

export interface PoolCriteria {
  heroes: readonly Hero[];
  excluded: ReadonlySet<string>;
  recent: readonly Hero[];
  complexity: ReadonlySet<number>;
  roles: ReadonlySet<string>;
  avoidRecent: boolean;
  releasedOnly: boolean;
  /** Relax the avoid-recent rule for this call only. */
  ignoreRecent?: boolean;
}

/** True once any hero has a role, i.e. the enrichment pass found role data. */
export function hasRoleData(heroes: readonly Hero[]): boolean {
  return heroes.some((hero) => hero.role);
}

export function eligibleHeroes(criteria: PoolCriteria): Hero[] {
  const { heroes, excluded, recent, complexity, roles, avoidRecent, releasedOnly, ignoreRecent = false } = criteria;
  const avoid = !ignoreRecent && avoidRecent ? new Set(recent.map((hero) => hero.id)) : new Set<string>();
  // A saved role filter outlives the data it depends on: roles only arrive from
  // the enrichment pass, so if that fails (offline, or the other feed is down)
  // no hero has one. Applying the filter then empties the pool — and the role
  // chips are hidden in that state, so there is no control left to clear it.
  const roleFilter = roles.size && hasRoleData(heroes) ? roles : null;
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
