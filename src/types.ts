/** A hero, normalised out of whichever community feed answered. */
export interface Hero {
  /** Stable id from the engine class name; the key for exclusions, tally and share links. */
  id: string;
  /** Display name, already stripped of `hero_` prefixes. */
  name: string;
  /** May be empty; the stage falls back to filler copy. */
  description: string;
  /** Absolute URL, or empty when the feed had no art. */
  image: string;
  /** False for unreleased/test characters. */
  released: boolean;
  /** 1-4 as rated by the game, or 0 when unknown. */
  complexity: number;
  /** One of ROLE_ORDER, or '' when unknown. */
  role: string;
  /** Gun archetype ('Pistol', 'Spreadshot', …), or ''. */
  weapon: string;
  /** Hero accent colour as '#rrggbb', or ''. */
  accent: string;
  /** Lowercased localized names + romanizations, for search. */
  aliases: string;
}

export interface Source {
  url: string;
  name: string;
  origin: string;
}

export interface CachedRoster {
  heroes: Hero[];
  source: string;
}

export type StatusKind = '' | 'live' | 'error';
