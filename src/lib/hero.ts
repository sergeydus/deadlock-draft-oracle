/** Runtime guards for the hero domain. */
import { COMPLEXITY_LEVELS } from '../constants.ts';
import type { HeroComplexity } from '../types.ts';

/** True for the game's 1-4 rating, plus 0 for an unknown rating. */
export function isHeroComplexity(value: unknown): value is HeroComplexity {
  return typeof value === 'number'
    && Number.isInteger(value)
    && (value === 0 || COMPLEXITY_LEVELS.some((level) => level === value));
}
