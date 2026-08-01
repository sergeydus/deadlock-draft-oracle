/**
 * Verification harness — `npm test`.
 *
 * The app has no build step and no module system, so this cannot `import` from
 * app.js. Instead it slices the pure sections out of the real source and runs
 * them in Node against stub `state` / `els` objects, which means these checks
 * exercise the shipped code rather than a copy of it. Nothing is duplicated here.
 *
 * If you rename a `/* ── Section ── *\/` marker or move a function across one,
 * update the slice boundaries below — the script throws rather than silently
 * testing less.
 *
 * The live-feed checks are a canary for upstream API changes (it is how the dead
 * /v1/assets/heroes endpoint was found). Run with --offline to skip them; CI runs
 * the offline half as a merge gate and the network half on a schedule.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'app.js'), 'utf8');
const css = readFileSync(join(root, 'styles.css'), 'utf8');
const offline = process.argv.includes('--offline');

/**
 * The only hero portrait size either feed ships. The boxes that display it are
 * sized to this ratio; the live-feed section asserts upstream still matches.
 */
const ART = { w: 280, h: 380 };

function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`app.js has no section bounded by "${startMarker}" .. "${endMarker}" — update scripts/verify.mjs`);
  return src.slice(start, end);
}

/** Read an array literal constant straight out of app.js. */
function constant(name) {
  const start = src.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`app.js has no "const ${name} = [" — update scripts/verify.mjs`);
  const open = src.indexOf('[', start);
  return new Function(`return ${src.slice(open, src.indexOf('];', open) + 1)}`)();
}

const SOURCES = constant('SOURCES');
const ROLE_ORDER = constant('ROLE_ORDER');
const COMPLEXITY_LEVELS = constant('COMPLEXITY_LEVELS');

/*
 * `state` and `els` stand in for the globals the sliced functions close over.
 * Only the properties those functions actually read are provided; a test mutates
 * them directly to set up a scenario.
 */
const app = new Function(`
  ${slice('function text(value)', '/* ── Small DOM helpers')}
  ${slice('function mulberry32(seed)', '/* ── Storage helpers')}
  ${slice('function isHeroRecord(hero)', 'function loadState()')}
  ${slice('function cssUrl(url)', 'function sourceStatus(')}
  ${slice('function eligibleHeroes(', 'function recordDraw(')}

  const els = { recentToggle: { checked: true }, releasedToggle: { checked: true } };
  const state = {
    heroes: [], excluded: new Set(), recent: [], seed: 0, coverRoles: false,
    filters: { complexity: new Set(${JSON.stringify(COMPLEXITY_LEVELS)}), roles: new Set() },
  };
  return {
    unwrap, normalise, isHeroRecord, mulberry32, drawFrom, drawSquad, aliasesFrom,
    cssUrl, eligibleHeroes, poolFor, hasRoleData, reseed, state, els,
  };
`)();

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const section = (name) => console.log(`\n— ${name} —`);

/** A complete, valid Hero; override just the field under test. */
const hero = (over = {}) => ({
  id: 'someone', name: 'Someone', description: 'does things', image: 'https://x/i.png',
  released: true, complexity: 2, role: 'marksman', weapon: 'Pistol', accent: '#aabbcc',
  aliases: 'someone', ...over,
});

/** Reset the stub globals between scenarios. */
function reset(heroes = []) {
  app.state.heroes = heroes;
  app.state.excluded = new Set();
  app.state.recent = [];
  app.state.coverRoles = false;
  app.state.filters.complexity = new Set(COMPLEXITY_LEVELS);
  app.state.filters.roles = new Set();
  app.els.recentToggle.checked = true;
  app.els.releasedToggle.checked = true;
  app.reseed(20260801);
}

/* ── Seeded PRNG ── */
section('seeded randomness');

const a = app.mulberry32(42);
const b = app.mulberry32(42);
const seqA = [a(), a(), a(), a(), a()];
check('mulberry32 is deterministic for a seed', JSON.stringify(seqA) === JSON.stringify([b(), b(), b(), b(), b()]));
check('mulberry32 stays in [0,1)', seqA.every((n) => n >= 0 && n < 1));
check('different seeds diverge', app.mulberry32(43)() !== seqA[0]);

/* ── Draw mechanics ── */
section('draw mechanics');

const pool = Array.from({ length: 10 }, (_, i) => hero({ id: `h${i}`, name: `H${i}` }));
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

/* ── Role coverage ── */
section('squad role coverage');

const rolePool = ROLE_ORDER.flatMap((role) => Array.from({ length: 5 }, (_, i) => hero({ id: `${role}${i}`, name: `${role}${i}`, role })));
reset(rolePool);

app.state.coverRoles = false;
let sawRepeatedRole = false;
for (let i = 0; i < 300 && !sawRepeatedRole; i++) {
  sawRepeatedRole = new Set(app.drawSquad(rolePool, 4).map((h) => h.role)).size < 4;
}
check('coverage off: a squad of 4 may repeat a role', sawRepeatedRole);

app.state.coverRoles = true;
const coverage = (size, trials = 300) => {
  const seenRoles = new Set();
  let minRoles = Infinity;
  let allDistinct = true;
  for (let i = 0; i < trials; i++) {
    const squad = app.drawSquad(rolePool, size);
    if (squad.length !== size || new Set(squad.map((h) => h.id)).size !== size) allDistinct = false;
    const roles = new Set(squad.map((h) => h.role));
    minRoles = Math.min(minRoles, roles.size);
    for (const role of roles) seenRoles.add(role);
  }
  return { minRoles, seenRoles, allDistinct };
};

const four = coverage(4);
check('coverage on: a squad of 4 always has all 4 roles', four.minRoles === 4, `worst case ${four.minRoles}`);
check('coverage on: squad members are always distinct', four.allDistinct);
const six = coverage(6);
check('coverage on: a squad of 6 still covers all 4 roles', six.minRoles === 4, `worst case ${six.minRoles}`);
check('coverage on: a squad of 6 returns 6 heroes', six.allDistinct);
const two = coverage(2);
check('coverage on: a squad of 2 gets 2 different roles', two.minRoles === 2);
// Roles are visited in random order, so a short squad must not always favour the
// same ones — otherwise slot 1 would be a marksman forever.
check('coverage on: a squad of 2 can draw any role', two.seenRoles.size === ROLE_ORDER.length,
  `${[...two.seenRoles].join(', ')}`);

const rolelessPool = Array.from({ length: 8 }, (_, i) => hero({ id: `x${i}`, role: '' }));
check('coverage on with no role data: falls back to a plain draw',
  app.drawSquad(rolelessPool, 4).length === 4);
check('coverage on with a single role: falls back to a plain draw',
  app.drawSquad(rolePool.filter((h) => h.role === 'mystic'), 3).length === 3);

/* ── Pool filters ── */
section('pool filters');

const mixed = [
  hero({ id: 'released', released: true, complexity: 1, role: 'marksman' }),
  hero({ id: 'unreleased', released: false, complexity: 1, role: 'marksman' }),
  hero({ id: 'complex', released: true, complexity: 4, role: 'assassin' }),
  hero({ id: 'unrated', released: true, complexity: 0, role: 'mystic' }),
  hero({ id: 'roleless', released: true, complexity: 2, role: '' }),
];
const ids = (options) => app.eligibleHeroes(options).map((h) => h.id).sort();

reset(mixed);
check('released-only excludes unreleased heroes', !ids().includes('unreleased'), ids().join(', '));
app.els.releasedToggle.checked = false;
check('released-only off includes them', ids().includes('unreleased'));

reset(mixed);
app.state.excluded = new Set(['complex']);
check('excluded heroes are removed', !ids().includes('complex'));

reset(mixed);
app.state.recent = [mixed[0]];
check('avoid-recent removes recent picks', !ids().includes('released'));
check('ignoreRecent overrides it', ids({ ignoreRecent: true }).includes('released'));
app.els.recentToggle.checked = false;
check('avoid-recent off keeps them', ids().includes('released'));

reset(mixed);
app.state.filters.complexity = new Set([1]);
check('complexity filter keeps only the selected levels', !ids().includes('complex'), ids().join(', '));
check('an unrated hero is never filtered out by complexity', ids().includes('unrated'));

reset(mixed);
app.state.filters.roles = new Set(['assassin']);
check('role filter keeps only the selected roles', ids().join(',') === 'complex', ids().join(', '));
check('a hero with no role is excluded while a role filter is active', !ids().includes('roleless'));
app.state.filters.roles = new Set();
check('an empty role filter means every role', ids().length === mixed.length - 1, ids().join(', '));

reset(mixed);
check('hasRoleData detects roles', app.hasRoleData());
reset(rolelessPool);
check('hasRoleData is false when the merge found none', !app.hasRoleData());

reset(mixed);
app.state.recent = [mixed[0], mixed[2]];
check('poolFor relaxes avoid-recent rather than starving a draw',
  app.poolFor(4).length >= 4, `${app.poolFor(4).length} available`);

/* ── Cache and parsing guards ── */
section('cache and parsing guards');

check('isHeroRecord accepts a current record', app.isHeroRecord(hero()));
// The metadata fields were added after the first release; a roster cached before
// then must be rejected and refetched, not loaded with the filters dead.
const { complexity, role, weapon, accent, aliases, ...legacy } = hero();
check('isHeroRecord rejects a pre-metadata cached record', !app.isHeroRecord(legacy));
for (const field of ['complexity', 'role', 'weapon', 'accent', 'aliases']) {
  check(`isHeroRecord rejects a record missing \`${field}\``, !app.isHeroRecord({ ...hero(), [field]: undefined }));
}
check('isHeroRecord rejects junk', [null, undefined, 42, 'x', [], {}].every((v) => !app.isHeroRecord(v)));
check('isHeroRecord rejects a blank name', !app.isHeroRecord(hero({ name: '   ' })));

const origin = 'https://deadlock.io';
check('normalise rejects an entry with no name', app.normalise({}, 0, origin) === null);
check('normalise rejects dota leftovers', app.normalise({ name: 'npc_dota_hero_axe' }, 0, origin) === null);
check('normalise rejects raw internal names', app.normalise({ name: 'hero_inferno' }, 0, origin) === null);

const dynamo = app.normalise({ class_name: 'HERO_Sumo', name: 'Dynamo', complexity: 2, colors: { style_hex: '#D0B945' } }, 0, origin);
check('normalise derives a lowercase slug id from the class name', dynamo.id === 'sumo', dynamo.id);
check('normalise keeps the display name', dynamo.name === 'Dynamo');
check('normalise reads complexity and accent', dynamo.complexity === 2 && dynamo.accent === '#D0B945');
check('normalise rejects a malformed accent',
  app.normalise({ name: 'X', colors: { style_hex: 'goldenrod' } }, 0, origin).accent === '');
check('normalise defaults complexity to 0 when absent', app.normalise({ name: 'X' }, 0, origin).complexity === 0);
check('normalise marks disabled heroes unreleased', app.normalise({ name: 'X', disabled: true }, 0, origin).released === false);
check('normalise resolves relative art against the feed origin',
  app.normalise({ name: 'X', image: '/a/b.png' }, 0, origin).image === 'https://deadlock.io/a/b.png');

check('aliasesFrom flattens a localized object',
  app.aliasesFrom({ displayName: { english: 'Infernus', byLanguage: { english: 'Infernus', schinese: '炽焱' } } }) === 'infernus 炽焱');
check('aliasesFrom handles a plain string name', app.aliasesFrom({ name: 'Dynamo' }) === 'dynamo');
check('aliasesFrom returns empty for a nameless entry', app.aliasesFrom({}) === '');

// cssUrl output is interpolated straight into a CSS url("…"), so a quote in a
// feed-supplied path must not be able to close it.
check('cssUrl escapes double quotes', app.cssUrl('a"b') === 'url("a\\"b")', app.cssUrl('a"b'));
check('cssUrl escapes backslashes', app.cssUrl('a\\b') === 'url("a\\\\b")', app.cssUrl('a\\b'));

/* ── Art boxes vs the art's real shape ──
   Portraits have twice been cropped by a box shaped nothing like the source, so
   the coupling is asserted rather than left to eyeballing. */
section('art layout');

const bareCss = css.replace(/\/\*[\s\S]*?\*\//g, ''); // comments mention selectors too

function cssRule(selector) {
  const start = bareCss.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`styles.css has no "${selector}" rule — update scripts/verify.mjs`);
  return bareCss.slice(start, bareCss.indexOf('}', start));
}
/** Every rule whose selector mentions `.className`, as {selector, body}. */
function rulesFor(className) {
  const found = [];
  const pattern = new RegExp(`([^{}]*\\.${className}\\b[^{}]*)\\{([^}]*)\\}`, 'g');
  let match;
  while ((match = pattern.exec(bareCss))) found.push({ selector: match[1].trim().replace(/\s+/g, ' '), body: match[2] });
  return found;
}
function cssAspect(selector) {
  const match = cssRule(selector).match(/aspect-ratio:\s*([\d.]+)\s*\/\s*([\d.]+)/);
  return match ? Number(match[1]) / Number(match[2]) : null;
}

const artRatio = ART.w / ART.h;
const stageRatio = cssAspect('.hero-art');
check('.hero-art is shaped exactly like the portrait', stageRatio !== null && Math.abs(stageRatio - artRatio) < 1e-9,
  stageRatio === null ? 'no aspect-ratio declared' : stageRatio.toFixed(4));
// `cover` crops the overflow, so a card far from the art's ratio throws the
// character away — which is exactly how the roster ended up showing only heads.
const cardRatio = cssAspect('.hero-card');
check('.hero-card is close enough to the portrait ratio to keep the character',
  cardRatio !== null && Math.abs(cardRatio / artRatio - 1) <= 0.15,
  cardRatio === null ? 'no aspect-ratio declared' : `${cardRatio.toFixed(2)} vs art ${artRatio.toFixed(2)} (${((cardRatio / artRatio - 1) * 100).toFixed(0)}% off, crops ${((1 - artRatio / cardRatio) * 100).toFixed(0)}% of the height)`);
// Art below ~.35 opacity disappears into the card background; dark clothing goes
// first, so only faces read.
for (const [selector, floor] of [['.card-art', 0.4], ['.slot-art', 0.4]]) {
  const opacity = Number(cssRule(selector).match(/opacity:\s*([\d.]+)/)?.[1] ?? 0);
  check(`${selector} is opaque enough for the character to read`, opacity >= floor, `opacity ${opacity}`);
}

// JS sets `background-image` inline on these, so any rule that reaches them with
// the `background` SHORTHAND silently resets repeat/size/position and the
// portrait tiles at natural size from the top-left. That is exactly what
// `.hero-art:empty { background: … }` did — and because the div is always empty,
// it always applied.
for (const className of ['hero-art', 'card-art', 'slot-art']) {
  const offenders = rulesFor(className).filter(({ body }) => /(?:^|[;])\s*background\s*:/.test(body));
  check(`no rule on .${className} uses the background shorthand`, offenders.length === 0,
    offenders.map((rule) => rule.selector).join(' / ') || 'longhands only');
}
check('.hero-art disables background tiling', /background-repeat:\s*no-repeat/.test(cssRule('.hero-art')));
check('.hero-art scales the portrait to fit', /background-size:\s*contain/.test(cssRule('.hero-art')));

/* ── Live feeds through the shipped parser ── */

const parsed = {};
if (offline) {
  console.log('\n(skipping live feed checks: --offline)');
} else {
  section('live feeds');
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

  const [primary, fallback] = Object.values(parsed);
  if (primary && fallback) {
    section('cross-feed merge');
    // A failover must not orphan saved exclusions, tally entries or share links.
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
    const merged = primary.map((base) => {
      const extra = extras.get(base.id) ?? {};
      const filled = { ...base };
      for (const field of ['role', 'weapon', 'accent', 'aliases', 'description', 'image']) {
        if (!filled[field] && extra[field]) filled[field] = extra[field];
      }
      if (!filled.complexity && extra.complexity) filled.complexity = extra.complexity;
      return filled;
    });
    const mergedReleased = merged.filter((h) => h.released);
    for (const field of ['accent', 'aliases', 'complexity']) {
      const missing = mergedReleased.filter((h) => !h[field]).map((h) => h.id);
      check(`after the merge every released hero has \`${field}\``, missing.length === 0,
        missing.length ? `missing for: ${missing.join(', ')}` : `all ${mergedReleased.length}`);
    }
    // `hero_type` has genuine upstream gaps (Familiar has never carried one), so
    // this tolerates a couple of stragglers but still fails if the feed drops the
    // field wholesale. Heroes without a role are unreachable while a role filter
    // is active, which is why the count is worth watching.
    const roleless = mergedReleased.filter((h) => !h.role).map((h) => h.id);
    check('after the merge nearly every released hero has `role`', roleless.length <= 2,
      `${mergedReleased.length - roleless.length}/${mergedReleased.length}${roleless.length ? ` — no role: ${roleless.join(', ')}` : ''}`);
    check('sources never disagree on complexity',
      merged.every((h) => !extras.get(h.id)?.complexity || !h.complexity || extras.get(h.id).complexity === h.complexity));

    const alias = merged.find((h) => h.id === 'inferno');
    check('aliases carry non-English spellings',
      Boolean(alias) && /[^\x00-\x7f]/.test(alias.aliases) && alias.aliases.includes('infernus'),
      alias ? `${alias.aliases.split(' ').length} tokens` : 'inferno not found');

    // The art boxes checked above are sized to ART; confirm upstream still ships it.
    section('upstream art dimensions');
    // One flaky image request should not fail the run; only a real size change
    // (or a total outage) should.
    const sizes = [];
    for (const { image } of merged.filter((h) => h.released).slice(0, 5)) {
      try {
        const res = await fetch(image, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(20000) });
        const buf = Buffer.from(await res.arrayBuffer());
        const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        sizes.push(isPng ? `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}` : 'not-png');
      } catch (_) { /* skipped, see below */ }
    }
    check(`hero art is still the ${ART.w}x${ART.h} portrait the CSS is sized for`,
      sizes.length > 0 && sizes.every((size) => size === `${ART.w}x${ART.h}`),
      sizes.length ? `${sizes.join(' ')}${sizes.length < 5 ? ` (${5 - sizes.length} unreachable)` : ''}` : 'no art reachable');
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
// Setting exitCode rather than calling process.exit(): an abrupt exit while
// keep-alive sockets are still open trips a libuv assertion on Windows, which
// would mask the real result.
process.exitCode = failures ? 1 : 0;
