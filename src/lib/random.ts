/**
 * Seeded randomness.
 *
 * A seeded PRNG rather than Math.random so a draw is reproducible from its seed.
 * That is the hook the online-lobby mode needs: the server broadcasts one seed
 * and every client derives the same draw.
 *
 * The generator is passed in rather than held at module scope, so a caller (or a
 * test) fully controls the sequence.
 */
import type { Hero } from '../types.ts';

export type Rng = () => number;

/** A deterministic float generator in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Web Crypto is available in every browser React 19 supports, and in Node 19+. */
export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

/**
 * Draw `count` distinct items from `pool`. Called with `count === pool.length`
 * it is simply a shuffle. Returns fewer than `count` if the pool is too small.
 */
export function drawFrom<T>(pool: readonly T[], count: number, rng: Rng): T[] {
  const bag = [...pool];
  const drawn: T[] = [];
  while (drawn.length < count && bag.length) drawn.push(...bag.splice(Math.floor(rng() * bag.length), 1));
  return drawn;
}

/**
 * Draw a squad, optionally guaranteeing role coverage.
 *
 * With coverage on, one hero is taken from each role before the remaining slots
 * are filled at random. Roles are visited in random order so a squad smaller
 * than the number of roles does not always favour the same ones, and the result
 * is shuffled so the featured hero is not always the first role drawn.
 */
export function drawSquad(
  pool: readonly Hero[],
  size: number,
  { coverRoles, rng }: { coverRoles: boolean; rng: Rng },
): Hero[] {
  const roles = [...new Set(pool.map((hero) => hero.role).filter(Boolean))];
  if (!coverRoles || size < 2 || roles.length < 2) return drawFrom(pool, size, rng);

  const picked: Hero[] = [];
  const used = new Set<string>();
  for (const role of drawFrom(roles, roles.length, rng)) {
    if (picked.length >= size) break;
    const candidates = pool.filter((hero) => hero.role === role && !used.has(hero.id));
    if (!candidates.length) continue;
    const [hero] = drawFrom(candidates, 1, rng);
    picked.push(hero);
    used.add(hero.id);
  }
  const rest = drawFrom(pool.filter((hero) => !used.has(hero.id)), size - picked.length, rng);
  return drawFrom([...picked, ...rest], size, rng);
}
