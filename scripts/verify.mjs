/**
 * Verification harness — `npm test`.
 *
 * The app has no build step and no module system, so this cannot `import` from
 * app.js. Instead it slices the pure sections out of the real source and runs
 * them in Node, which means these checks exercise the shipped code rather than a
 * copy of it. Nothing is duplicated here.
 *
 * If you rename a `/* ── Section ── *\/` marker in app.js, update the slice
 * boundaries below — the script fails loudly rather than silently testing less.
 *
 * Network checks hit the live community feeds, so this needs a connection and is
 * a canary for upstream API changes (it is how the dead /v1/assets/heroes
 * endpoint was found). Run with --offline to skip them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'app.js'), 'utf8');
const offline = process.argv.includes('--offline');

function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`app.js has no section bounded by "${startMarker}" .. "${endMarker}" — update scripts/verify.mjs`);
  return src.slice(start, end);
}

const app = new Function(`
  ${slice('function text(value)', '/* ── Small DOM helpers')}
  ${slice('function mulberry32(seed)', 'let rng = mulberry32(1);')}
  ${slice('function drawFrom(pool, count)', '/* ── Storage helpers')}
  ${slice('function isHeroRecord(hero)', 'function loadState()')}
  let rng = mulberry32(12345);
  return { unwrap, normalise, isHeroRecord, mulberry32, drawFrom, aliasesFrom };
`)();

/** Read an array literal constant straight out of app.js. */
function constant(name) {
  const start = src.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`app.js has no "const ${name} = [" — update scripts/verify.mjs`);
  const open = src.indexOf('[', start);
  return new Function(`return ${src.slice(open, src.indexOf('];', open) + 1)}`)();
}
const ROLE_ORDER = constant('ROLE_ORDER');
const COMPLEXITY_LEVELS = constant('COMPLEXITY_LEVELS');

const sourcesStart = src.indexOf('const SOURCES = [') + 'const SOURCES = '.length;
const SOURCES = new Function(`return ${src.slice(sourcesStart, src.indexOf('];', sourcesStart) + 1)}`)();

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

/* ── Seeded PRNG ── */

const a = app.mulberry32(42);
const b = app.mulberry32(42);
const seqA = [a(), a(), a(), a(), a()];
const seqB = [b(), b(), b(), b(), b()];
check('mulberry32 is deterministic for a seed', JSON.stringify(seqA) === JSON.stringify(seqB));
check('mulberry32 stays in [0,1)', seqA.every((n) => n >= 0 && n < 1));
check('different seeds diverge', app.mulberry32(43)() !== seqA[0]);

/* ── Draw mechanics ── */

const pool = Array.from({ length: 10 }, (_, i) => ({ id: `h${i}`, name: `H${i}` }));
let distinctOk = true;
for (let trial = 0; trial < 500 && distinctOk; trial++) {
  const drawn = app.drawFrom(pool, 6);
  distinctOk = drawn.length === 6 && new Set(drawn.map((h) => h.id)).size === 6;
}
check('drawFrom(6) returns 6 distinct heroes over 500 trials', distinctOk);
check('drawFrom clamps to pool size', app.drawFrom(pool.slice(0, 3), 6).length === 3);
check('drawFrom on an empty pool returns []', app.drawFrom([], 6).length === 0);

const reachable = new Set();
for (let i = 0; i < 3000; i++) reachable.add(app.drawFrom(pool, 1)[0].id);
check('every hero in the pool is reachable', reachable.size === pool.length, `${reachable.size}/${pool.length}`);

/* ── Live feeds through the shipped parser ── */

const parsed = {};
if (offline) {
  console.log('\n(skipping live feed checks: --offline)');
} else {
  for (const source of SOURCES) {
    try {
      const response = await fetch(source.url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const entries = app.unwrap(await response.json());
      const heroes = entries.map((entry, i) => app.normalise(entry, i, source.origin)).filter(Boolean);
      const released = heroes.filter((h) => h.released);
      check(`${source.name}: unwrap found entries`, entries.length > 0, `${entries.length} entries`);
      check(`${source.name}: normalise produced heroes`, heroes.length >= 5, `${heroes.length} heroes`);
      check(`${source.name}: every hero passes isHeroRecord`, heroes.every(app.isHeroRecord));
      check(`${source.name}: ids are unique`, new Set(heroes.map((h) => h.id)).size === heroes.length);
      check(`${source.name}: ids are feed-independent`, heroes.every((h) => /^[a-z0-9_]+$/.test(h.id)),
        heroes.filter((h) => !/^[a-z0-9_]+$/.test(h.id)).map((h) => h.id).join(', ') || 'all slug-like');
      check(`${source.name}: released heroes have art`, released.every((h) => /^https?:\/\//.test(h.image)));
      check(`${source.name}: released heroes have a description`, released.every((h) => h.description),
        `${released.length} released of ${heroes.length}`);
      check(`${source.name}: complexity is one of the known levels`,
        released.every((h) => COMPLEXITY_LEVELS.includes(h.complexity)),
        `levels present: ${[...new Set(released.map((h) => h.complexity))].sort().join(', ')}`);
      check(`${source.name}: roles are all known values`,
        heroes.every((h) => !h.role || ROLE_ORDER.includes(h.role)),
        `${[...new Set(heroes.map((h) => h.role).filter(Boolean))].join(', ') || 'none in this feed'}`);
      check(`${source.name}: accents are valid hex`,
        heroes.every((h) => !h.accent || /^#[0-9a-f]{6}$/i.test(h.accent)),
        `${heroes.filter((h) => h.accent).length}/${heroes.length} have one`);
      parsed[source.name] = heroes;
    } catch (error) {
      check(`${source.name}: reachable`, false, String(error?.message ?? error));
    }
  }

  // A failover must not orphan saved exclusions, tally entries or share links.
  const [primary, fallback] = Object.values(parsed);
  if (primary && fallback) {
    const fallbackIds = new Set(fallback.map((h) => h.id));
    const orphans = primary.map((h) => h.id).filter((id) => !fallbackIds.has(id));
    check('ids are stable across a source failover', orphans.length === 0,
      orphans.length ? `orphaned: ${orphans.join(', ')}` : `all ${primary.length} primary ids present in fallback`);
    check('both sources agree on the released roster',
      Math.abs(fallback.filter((h) => h.released).length - primary.filter((h) => h.released).length) <= 3,
      `primary ${primary.filter((h) => h.released).length}, fallback ${fallback.filter((h) => h.released).length}`);

    // Neither feed carries every metadata field, so enrichRoster() merges them by
    // id. Mirror that merge here and assert the union is actually complete —
    // this is what the role filter and the accent colour depend on.
    const extras = new Map(fallback.map((h) => [h.id, h]));
    const merged = primary.map((hero) => {
      const extra = extras.get(hero.id) ?? {};
      const filled = { ...hero };
      for (const field of ['role', 'weapon', 'accent', 'aliases', 'description', 'image']) {
        if (!filled[field] && extra[field]) filled[field] = extra[field];
      }
      if (!filled.complexity && extra.complexity) filled.complexity = extra.complexity;
      return filled;
    });
    const mergedReleased = merged.filter((h) => h.released);
    for (const field of ['accent', 'aliases', 'complexity']) {
      const missing = mergedReleased.filter((h) => !h[field]).map((h) => h.id);
      check(`after the cross-feed merge every released hero has \`${field}\``, missing.length === 0,
        missing.length ? `missing for: ${missing.join(', ')}` : `all ${mergedReleased.length}`);
    }
    // `hero_type` has genuine upstream gaps (Familiar has never carried one), so
    // this tolerates a couple of stragglers but still fails if the feed drops the
    // field wholesale. Heroes without a role are unreachable while a role filter
    // is active, which is why the count is worth watching.
    const roleless = mergedReleased.filter((h) => !h.role).map((h) => h.id);
    check('after the cross-feed merge nearly every released hero has `role`',
      roleless.length <= 2,
      `${mergedReleased.length - roleless.length}/${mergedReleased.length}${roleless.length ? ` — no role: ${roleless.join(', ')}` : ''}`);
    check('sources never disagree on complexity',
      merged.every((h) => !extras.get(h.id)?.complexity || !h.complexity || extras.get(h.id).complexity === h.complexity));

    const alias = merged.find((h) => h.id === 'inferno');
    check('aliases carry non-English spellings',
      Boolean(alias) && /[^\x00-\x7f]/.test(alias.aliases) && alias.aliases.includes('infernus'),
      alias ? `${alias.aliases.split(' ').length} tokens` : 'inferno not found');
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
