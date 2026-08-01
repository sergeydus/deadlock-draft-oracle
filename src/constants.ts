import type { Source } from './types.ts';

export const SOURCES: Source[] = [
  { url: 'https://deadlock.io/api/v1/heroes.json', name: 'deadlock.io', origin: 'https://deadlock.io' },
  { url: 'https://assets.deadlock-api.com/v2/heroes', name: 'deadlock-api.com', origin: 'https://assets.deadlock-api.com' },
];

export const RECENT_LIMIT = 5;
/** Deadlock is 6v6, so a full stack is six heroes. */
export const MAX_SQUAD = 6;
/** The game's own rating; both feeds agree on it for every released hero. */
export const COMPLEXITY_LEVELS = [1, 2, 3, 4];
/** deadlock-api `hero_type`. Only that feed carries it, so it arrives via enrichment. */
export const ROLE_ORDER = ['marksman', 'assassin', 'mystic', 'brawler'];
export const TALLY_ROWS = 6;
export const FETCH_TIMEOUT_MS = 8000;
export const STORAGE_KEY = 'draftOracle_v1';
export const ROSTER_KEY = `${STORAGE_KEY}_roster`;

export const NO_DESCRIPTION = 'No signals, no scripts — just commit to the draw and make it work.';
