/**
 * localStorage persistence.
 *
 * Anything read back is untrusted: it may have been written by an older schema,
 * and every access can throw in private mode.
 */
import { COMPLEXITY_LEVELS, MAX_SQUAD, RECENT_LIMIT, ROLE_ORDER, ROSTER_KEY, STORAGE_KEY } from '../constants.ts';
import type { CachedRoster, Hero, RecentPick } from '../types.ts';

export interface PersistedState {
  excluded: string[];
  recent: RecentPick[];
  tally: Record<string, number>;
  pickCount: number;
  squadSize: number;
  coverRoles: boolean;
  complexity: number[];
  roles: string[];
  avoidRecent: boolean;
  releasedOnly: boolean;
}

/**
 * Runtime shape guard. The metadata fields are checked too, so a cache written
 * before they existed is rejected and refetched rather than silently disabling
 * the filters.
 */
/**
 * Guard for a persisted recents entry.
 *
 * Deliberately narrower than `isHeroRecord`: a list written by any older
 * version passes, because a full `Hero` record already has both fields, so the
 * migration needs no version check — it just reads less than it used to.
 */
export function isRecentPick(pick: unknown): pick is RecentPick {
  if (pick === null || typeof pick !== 'object') return false;
  const value = pick as Record<string, unknown>;
  return typeof value.id === 'string' && value.id.length > 0
    && typeof value.name === 'string' && value.name.trim().length > 0;
}

export function isHeroRecord(hero: unknown): hero is Hero {
  if (hero === null || typeof hero !== 'object') return false;
  const value = hero as Record<string, unknown>;
  return typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.name === 'string'
    && value.name.trim().length > 0
    && typeof value.description === 'string'
    && typeof value.image === 'string'
    && typeof value.released === 'boolean'
    && typeof value.complexity === 'number'
    && typeof value.role === 'string'
    && typeof value.weapon === 'string'
    && typeof value.accent === 'string'
    && typeof value.aliases === 'string';
}

export function saveState(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* quota or private-mode – silently skip */ }
}

export function loadState(): Partial<PersistedState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    const out: Partial<PersistedState> = {};
    if (Array.isArray(data.excluded)) out.excluded = data.excluded.filter((id: unknown) => typeof id === 'string');
    if (Array.isArray(data.recent)) {
      // Narrowed on the way in, so a list saved as whole Hero records is
      // rewritten in the small shape the next time anything persists.
      out.recent = data.recent.filter(isRecentPick)
        .map(({ id, name }: RecentPick) => ({ id, name }))
        .slice(0, RECENT_LIMIT);
    }
    if (data.tally && typeof data.tally === 'object') {
      out.tally = Object.fromEntries(
        Object.entries(data.tally as Record<string, unknown>)
          .filter(([, count]) => Number.isFinite(count) && (count as number) > 0) as [string, number][],
      );
    }
    if (Number.isFinite(data.pickCount) && data.pickCount >= 0) out.pickCount = data.pickCount;
    if (Number.isFinite(data.squadSize)) out.squadSize = Math.min(MAX_SQUAD, Math.max(1, data.squadSize));
    if (typeof data.coverRoles === 'boolean') out.coverRoles = data.coverRoles;
    // Accepts both the current key names and the pre-2.0 ones.
    const complexity = data.complexity ?? data.complexityFilter;
    if (Array.isArray(complexity)) {
      const levels = complexity.filter((level: number) => COMPLEXITY_LEVELS.includes(level));
      if (levels.length) out.complexity = levels;
    }
    const roles = data.roles ?? data.roleFilter;
    if (Array.isArray(roles)) out.roles = roles.filter((role: string) => ROLE_ORDER.includes(role));
    const avoidRecent = data.avoidRecent ?? data.recentToggle;
    if (typeof avoidRecent === 'boolean') out.avoidRecent = avoidRecent;
    const releasedOnly = data.releasedOnly ?? data.releasedToggle;
    if (typeof releasedOnly === 'boolean') out.releasedOnly = releasedOnly;
    return out;
  } catch {
    return {}; // corrupt data – start fresh
  }
}

export function saveCachedRoster(roster: CachedRoster): void {
  try {
    localStorage.setItem(ROSTER_KEY, JSON.stringify(roster));
  } catch { /* skip */ }
}

export function loadCachedRoster(): CachedRoster | null {
  try {
    const raw = localStorage.getItem(ROSTER_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Array.isArray(data.heroes)
      && data.heroes.length >= 5
      && data.heroes.every(isHeroRecord)
      && typeof data.source === 'string'
      && data.source.trim()) return data as CachedRoster;
  } catch { /* skip */ }
  return null;
}
