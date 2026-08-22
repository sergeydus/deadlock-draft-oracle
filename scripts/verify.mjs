/**
 * Verification harness — `npm test`.
 *
 * This imports the real modules. Before the React migration there was no module
 * system, so it had to slice functions out of app.js by their section comments;
 * that hack is gone. It runs under plain `node` via native TypeScript stripping,
 * so there is still no test runner and no build step to run the tests.
 *
 * The live-feed checks are a canary for upstream API changes (it is how the dead
 * /v1/assets/heroes endpoint was found). Run with --offline to skip them; CI runs
 * the offline half as a merge gate and the network half on a schedule.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { COMPLEXITY_LEVELS, ROLE_ORDER, SOURCES } from '../src/constants.ts';
import { aliasesFrom, normalise, unwrap } from '../src/lib/feed.ts';
import { drawFrom, drawSquad, mulberry32 } from '../src/lib/random.ts';
import { eligibleHeroes, hasRoleData, poolFor } from '../src/lib/pool.ts';
import { mergeInto, parseRoster } from '../src/lib/roster.ts';
import { isHeroRecord, isRecentPick, loadState } from '../src/lib/storage.ts';
import { clearHash, isOwnHash, parseSquadHash, squadToHash, writeHash } from '../src/lib/share.ts';
import { cssUrl } from '../src/lib/css.ts';
// The store is not pure: it reads localStorage and writes the URL. These shims
// stand in for the browser so it can be exercised here. The import has to come
// before the store's, which constructs a singleton as it is evaluated.
import { resetBrowser, restoreFetch, storage, stubFetch } from './browser-shims.mjs';
import { OracleStore } from '../src/store/OracleStore.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'src/styles.css'), 'utf8');
const offline = process.argv.includes('--offline');

/**
 * The only hero portrait size either feed ships. The boxes that display it are
 * sized to this ratio; the live-feed section asserts upstream still matches.
 */
const ART = { w: 280, h: 380 };

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const section = (name) => console.log(`\n— ${name} —`);
/** Run something whose failure path logs on purpose, without the noise. */
const quietly = async (run) => {
  const spoke = console.error;
  console.error = () => {};
  try { return await run(); } finally { console.error = spoke; }
};

/** A complete, valid Hero; override just the field under test. */
const hero = (over = {}) => ({
  id: 'someone', name: 'Someone', description: 'does things', image: 'https://x/i.png',
  released: true, complexity: 2, role: 'marksman', weapon: 'Pistol', accent: '#aabbcc',
  aliases: 'someone', ...over,
});

/** Baseline pool criteria; override what a scenario needs. */
const criteria = (over = {}) => ({
  heroes: [], excluded: new Set(), recent: [],
  complexity: new Set(COMPLEXITY_LEVELS), roles: new Set(),
  avoidRecent: true, releasedOnly: true, ...over,
});

const rngFor = (seed = 20260801) => mulberry32(seed);

/* ── Seeded PRNG ── */
section('seeded randomness');

const a = mulberry32(42);
const b = mulberry32(42);
const seqA = [a(), a(), a(), a(), a()];
check('mulberry32 is deterministic for a seed', JSON.stringify(seqA) === JSON.stringify([b(), b(), b(), b(), b()]));
check('mulberry32 stays in [0,1)', seqA.every((n) => n >= 0 && n < 1));
check('different seeds diverge', mulberry32(43)() !== seqA[0]);

/* ── Draw mechanics ── */
section('draw mechanics');

const pool = Array.from({ length: 10 }, (_, i) => hero({ id: `h${i}`, name: `H${i}` }));
const rng = rngFor();
let distinctOk = true;
for (let trial = 0; trial < 500 && distinctOk; trial++) {
  const drawn = drawFrom(pool, 6, rng);
  distinctOk = drawn.length === 6 && new Set(drawn.map((h) => h.id)).size === 6;
}
check('drawFrom(6) returns 6 distinct heroes over 500 trials', distinctOk);
check('drawFrom clamps to pool size', drawFrom(pool.slice(0, 3), 6, rng).length === 3);
check('drawFrom on an empty pool returns []', drawFrom([], 6, rng).length === 0);

const reachable = new Set();
for (let i = 0; i < 3000; i++) reachable.add(drawFrom(pool, 1, rng)[0].id);
check('every hero in the pool is reachable', reachable.size === pool.length, `${reachable.size}/${pool.length}`);

// Same seed, same draw — the property the lobby mode will depend on.
check('a draw is reproducible from its seed',
  JSON.stringify(drawFrom(pool, 6, mulberry32(7)).map((h) => h.id))
  === JSON.stringify(drawFrom(pool, 6, mulberry32(7)).map((h) => h.id)));

/* ── Role coverage ── */
section('squad role coverage');

const rolePool = ROLE_ORDER.flatMap((role) => Array.from({ length: 5 }, (_, i) => hero({ id: `${role}${i}`, name: `${role}${i}`, role })));

let sawRepeatedRole = false;
for (let i = 0; i < 300 && !sawRepeatedRole; i++) {
  sawRepeatedRole = new Set(drawSquad(rolePool, 4, { coverRoles: false, rng }).map((h) => h.role)).size < 4;
}
check('coverage off: a squad of 4 may repeat a role', sawRepeatedRole);

const coverage = (size, trials = 300) => {
  const seenRoles = new Set();
  let minRoles = Infinity;
  let allDistinct = true;
  for (let i = 0; i < trials; i++) {
    const squad = drawSquad(rolePool, size, { coverRoles: true, rng });
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
check('coverage on: a squad of 2 can draw any role', two.seenRoles.size === ROLE_ORDER.length, [...two.seenRoles].join(', '));

const rolelessPool = Array.from({ length: 8 }, (_, i) => hero({ id: `x${i}`, role: '' }));
check('coverage on with no role data: falls back to a plain draw',
  drawSquad(rolelessPool, 4, { coverRoles: true, rng }).length === 4);
check('coverage on with a single role: falls back to a plain draw',
  drawSquad(rolePool.filter((h) => h.role === 'mystic'), 3, { coverRoles: true, rng }).length === 3);

/* ── Pool filters ── */
section('pool filters');

const mixed = [
  hero({ id: 'released', released: true, complexity: 1, role: 'marksman' }),
  hero({ id: 'unreleased', released: false, complexity: 1, role: 'marksman' }),
  hero({ id: 'complex', released: true, complexity: 4, role: 'assassin' }),
  hero({ id: 'unrated', released: true, complexity: 0, role: 'mystic' }),
  hero({ id: 'roleless', released: true, complexity: 2, role: '' }),
];
const ids = (over) => eligibleHeroes(criteria({ heroes: mixed, ...over })).map((h) => h.id).sort();

check('released-only excludes unreleased heroes', !ids().includes('unreleased'), ids().join(', '));
check('released-only off includes them', ids({ releasedOnly: false }).includes('unreleased'));
check('excluded heroes are removed', !ids({ excluded: new Set(['complex']) }).includes('complex'));
check('avoid-recent removes recent picks', !ids({ recent: [mixed[0]] }).includes('released'));
check('ignoreRecent overrides it', ids({ recent: [mixed[0]], ignoreRecent: true }).includes('released'));
check('avoid-recent off keeps them', ids({ recent: [mixed[0]], avoidRecent: false }).includes('released'));
check('complexity filter keeps only the selected levels',
  !ids({ complexity: new Set([1]) }).includes('complex'), ids({ complexity: new Set([1]) }).join(', '));
check('an unrated hero is never filtered out by complexity', ids({ complexity: new Set([1]) }).includes('unrated'));
check('role filter keeps only the selected roles', ids({ roles: new Set(['assassin']) }).join(',') === 'complex');
check('a hero with no role is excluded while a role filter is active', !ids({ roles: new Set(['assassin']) }).includes('roleless'));
check('an empty role filter means every role', ids().length === mixed.length - 1, ids().join(', '));

check('hasRoleData detects roles', hasRoleData(mixed));
check('hasRoleData is false when the merge found none', !hasRoleData(rolelessPool));

// Roles only exist after the enrichment pass. A role filter saved from a healthy
// session must not apply on a later one where enrichment failed: it would match
// nothing, and the role chips are hidden in that state, so the user would be
// stranded on "No hero left" with no control to clear it.
const stranded = eligibleHeroes(criteria({ heroes: rolelessPool, roles: new Set(['assassin']) }));
check('a saved role filter is ignored when no role data arrived',
  stranded.length === rolelessPool.length, `${stranded.length}/${rolelessPool.length} still eligible`);

check('poolFor relaxes avoid-recent rather than starving a draw',
  poolFor(4, criteria({ heroes: mixed, recent: [mixed[0], mixed[2]] })).length >= 4);

/* ── Cross-feed merge ── */
section('metadata merge');

const base = [hero({ id: 'inferno', role: '', accent: '', aliases: '', complexity: 0, image: '' })];
const changed = mergeInto(base, new Map([['inferno', hero({ id: 'inferno', role: 'mystic', accent: '#c93c26', aliases: '火男', complexity: 3, image: 'https://x/a.png' })]]));
check('mergeInto reports that it filled blanks', changed);
check('mergeInto fills every missing field',
  base[0].role === 'mystic' && base[0].accent === '#c93c26' && base[0].aliases === '火男' && base[0].complexity === 3 && base[0].image === 'https://x/a.png');
const kept = [hero({ id: 'inferno', role: 'brawler' })];
check('mergeInto never overwrites a value the base feed had',
  !mergeInto(kept, new Map([['inferno', hero({ id: 'inferno', role: 'mystic' })]])) && kept[0].role === 'brawler');

/* ── Share links ── */
section('share links');

check('a squad round-trips through the hash',
  JSON.stringify(parseSquadHash(`#squad=${squadToHash([hero({ id: 'inferno' }), hero({ id: 'sumo' })])}`)) === '["inferno","sumo"]');
check('a hash without a squad yields nothing', parseSquadHash('#seed=4').length === 0);
check('the hash is capped at a full squad', parseSquadHash(`#squad=${'a,b,c,d,e,f,g,h'}`).length === 6);

/* ── Telling your own hash from somebody else's ──
   Every roll writes the hash, so it doubles as a permalink for the current tab
   and the hash alone can no longer say who wrote it. A marker in history.state
   settles it: restored on reload, absent on a fresh navigation. It has to name
   the hash it was written for — binding it to `location.hash` reads the
   *previous* value, and a marker that never matches turns every draw back into
   a "shared" one with nothing to notice. */
section('share-link identity');

resetBrowser();
const rolled = [hero({ id: 'abrams' }), hero({ id: 'bebop' })];
history.replaceState({ router: 'state another library owns' }, '', '/deadlock-draft-oracle/#squad=previous');
writeHash(rolled);

check('writeHash puts the squad in the address bar', location.hash === '#squad=abrams,bebop', location.hash);
check('writeHash marks the hash it wrote, not the one it replaced', isOwnHash(),
  `marker=${JSON.stringify(history.state?.draftOracle)} hash=${location.hash}`);
check('writeHash leaves state it does not own alone', history.state.router === 'state another library owns');

location.hash = '#squad=someone,else';
check('a hash changed underneath the marker is not ours', !isOwnHash(), location.hash);

resetBrowser({ hash: '#squad=abrams,bebop', state: null });
check('a pasted link carries no marker, so it is not ours', !isOwnHash());

writeHash(rolled);
clearHash();
check('clearHash empties the address bar', location.hash === '');
check('clearHash drops the marker with it', !isOwnHash() && history.state?.draftOracle === undefined);

/* ── Store behaviour ──
   Every piece the store is built from was covered while the way it wires them
   together was not, which is how a reload came to relabel your own pick as a
   shared draw and hand back heroes you had already excluded. These are the
   seams between those pieces. */
section('store behaviour');

const rosterIds = ['abrams', 'bebop', 'dynamo', 'haze', 'infernus', 'lash', 'mcginnis', 'seven'];
const feed = rosterIds.map((id, index) => ({
  name: id,
  class_name: `hero_${id}`,
  complexity: (index % COMPLEXITY_LEVELS.length) + 1,
  hero_type: ROLE_ORDER[index % ROLE_ORDER.length],
  images: { icon_hero_card: `https://assets.test/${id}.png` },
  description: 'a blurb',
}));
const squadIds = (store) => store.squad.map((member) => member.id).join(',');

// A cold start: nothing in the address bar, nothing in storage.
resetBrowser();
stubFetch(feed);
const cold = new OracleStore();
await cold.load();
check('a cold start draws a hero by itself', cold.mode === 'draw' && cold.squad.length === 1, squadIds(cold));
check('the opening draw is not labelled shared', cold.shared === false, cold.stageLabel);
check('the opening draw is recorded', cold.pickCount === 1 && cold.recent.length === 1);
check('rolling leaves a shareable hash behind', location.hash.startsWith('#squad='), location.hash);

// Reloading that same tab: the hash is still there, and so is its marker.
resetBrowser({ hash: location.hash, state: history.state, keepStorage: true });
stubFetch(feed);
const reloaded = new OracleStore();
await reloaded.load();
check('reloading your own tab is never a SHARED DRAW', reloaded.shared === false, reloaded.stageLabel);
check('reloading still draws a hero automatically', reloaded.mode === 'draw' && reloaded.squad.length === 1, squadIds(reloaded));
// Deliberate, and the direct consequence of restoring the opening roll: a
// reload is a new draw and is tallied like one. Pinned here because it is the
// kind of thing a later change would "fix" without realising it is the point.
check('a reload counts as a new draw, because it is one',
  reloaded.pickCount === cold.pickCount + 1, `${cold.pickCount} -> ${reloaded.pickCount}`);

// Somebody else's link: the same shape of hash, with no marker behind it.
resetBrowser({ hash: '#squad=haze,lash', state: null });
stubFetch(feed);
const recipient = new OracleStore();
await recipient.load();
check("a pasted link restores the sender's draw", squadIds(recipient) === 'haze,lash', squadIds(recipient));
check('a pasted link IS labelled SHARED DRAW', recipient.shared && recipient.stageLabel.includes('SHARED DRAW'),
  recipient.stageLabel);
check('a shared draw is kept out of the tally', Object.keys(recipient.tally).length === 0);
check('a shared draw is kept out of recents', recipient.recent.length === 0);

// The refresh button re-runs load() against a roster that is already on screen.
resetBrowser();
stubFetch(feed);
const refreshed = new OracleStore();
await refreshed.load();
const heldPick = squadIds(refreshed);
const heldCount = refreshed.pickCount;
await refreshed.load();
check('a manual refresh keeps the pick on screen', squadIds(refreshed) === heldPick, `${heldPick} -> ${squadIds(refreshed)}`);
check('a manual refresh does not relabel it shared', refreshed.shared === false, refreshed.stageLabel);
check('a manual refresh does not inflate the draw count', refreshed.pickCount === heldCount);

// Excluding the whole roster empties the pool; the URL must not still name a draw.
resetBrowser();
stubFetch(feed);
const emptied = new OracleStore();
await emptied.load();
const banished = emptied.squad[0].id;
for (const id of rosterIds) emptied.toggleExcluded(id);
emptied.roll();
check('excluding every hero empties the stage', emptied.mode === 'empty' && emptied.squad.length === 0, emptied.mode);
check('an empty pool clears the stale hash', location.hash === '', location.hash);

resetBrowser({ hash: location.hash, state: history.state, keepStorage: true });
stubFetch(feed);
const afterEmpty = new OracleStore();
await afterEmpty.load();
check('reloading does not resurrect an excluded hero', !afterEmpty.squad.some((member) => member.id === banished), squadIds(afterEmpty));
check('reloading an emptied pool stays empty', afterEmpty.mode === 'empty', afterEmpty.mode);

// Settings round-trip, and ids the roster no longer has are pruned.
resetBrowser();
stubFetch(feed);
const before = new OracleStore();
await before.load();
before.toggleExcluded('bebop');
before.toggleExcluded('seven');
before.setSquadSize(3);

resetBrowser({ keepStorage: true });
stubFetch(feed);
const after = new OracleStore();
await after.load();
check('exclusions survive a reload', after.excluded.has('bebop'), [...after.excluded].join(','));
check('squad size survives a reload', after.squadSize === 3, String(after.squadSize));

resetBrowser({ keepStorage: true });
stubFetch(feed.filter((entry) => entry.name !== 'seven'));
const shrunk = new OracleStore();
await shrunk.load();
check('an exclusion for a hero the roster dropped is pruned', !shrunk.excluded.has('seven'), [...shrunk.excluded].join(','));
check('exclusions the roster still has are kept', shrunk.excluded.has('bebop'));

/* ── Recents persistence ──
   Recents used to be stored as whole Hero records — measured at 3.5KB for five
   typical heroes, 7.8KB for five with long lore, against ~160B as id+name. The
   size was the smaller problem: isHeroRecord rejects a record missing any
   field, so every field added to Hero silently wiped the saved list. Only the
   id and the name are ever read, so only those are kept. */
section('recents persistence');

check('isRecentPick accepts the small shape', isRecentPick({ id: 'haze', name: 'Haze' }));
// A list written by any older version passes unchanged, so the migration needs
// no version flag — it just reads fewer fields than it used to.
check('isRecentPick accepts a legacy full Hero record', isRecentPick(hero({ id: 'haze', name: 'Haze' })));
check('isRecentPick still rejects junk',
  [null, undefined, 42, 'x', [], {}, { id: 'a' }, { name: 'b' }, { id: '', name: 'b' }, { id: 'a', name: '  ' }]
    .every((value) => !isRecentPick(value)));

resetBrowser();
// Exactly what the old schema wrote.
storage.set('draftOracle_v1', JSON.stringify({
  recent: [hero({ id: 'haze', name: 'Haze' }), hero({ id: 'lash', name: 'Lash' })],
  pickCount: 2,
}));
const migrated = loadState();
check('a legacy recents list still loads', migrated.recent.length === 2, JSON.stringify(migrated.recent));
check('and is narrowed on the way in',
  migrated.recent.every((pick) => Object.keys(pick).sort().join(',') === 'id,name'),
  JSON.stringify(migrated.recent));
check('the names survive the narrowing', migrated.recent.map((pick) => pick.name).join(',') === 'Haze,Lash');

// Round-trip through a real store.
resetBrowser();
stubFetch(feed);
const remembering = new OracleStore();
await remembering.load();
remembering.roll();
const written = JSON.parse(storage.get('draftOracle_v1')).recent;
check('a draw persists recents in the small shape',
  written.length > 0 && written.every((pick) => Object.keys(pick).sort().join(',') === 'id,name'),
  JSON.stringify(written));
check('recents still keep the last draws out of the pool',
  remembering.eligible.every((member) => !remembering.recent.some((pick) => pick.id === member.id)),
  `recent=${remembering.recent.map((pick) => pick.id).join(',')}`);

// The behaviour the small shape had to preserve: with no roster and no cache,
// the recent chips still have something to render. Storing bare ids would have
// left them blank in exactly the state where the app can show nothing else.
const remembered = remembering.recent.map((pick) => pick.name);
resetBrowser({ keepStorage: true });
storage.delete('draftOracle_v1_roster');
stubFetch('fail');
const strandedStore = await quietly(async () => {
  const store = new OracleStore();
  await store.load();
  return store;
});
check('with no roster at all the app is offline', strandedStore.mode === 'offline' && strandedStore.heroes.length === 0);
check('and the recent chips still have names to show',
  strandedStore.recent.length > 0 && strandedStore.recent.every((pick) => pick.name.length > 0),
  strandedStore.recent.map((pick) => pick.name).join(', '));
check('the same names as before the roster went away',
  strandedStore.recent.map((pick) => pick.name).join(',') === remembered.join(','),
  `${strandedStore.recent.map((pick) => pick.name).join(',')} vs ${remembered.join(',')}`);

restoreFetch();

/* ── Provisional rosters ──
   Priming calls adoptRoster with a roster the network has not confirmed, and
   adoptRoster does irreversible things: it prunes saved ids and banks the
   opening draw. Against a cache that predates the live roster, both are wrong
   — a hero the cache has not heard of loses its exclusion, and a pick that
   does not survive the handover is left in the tally.

   These use DISJOINT cached and live rosters, so the provisional pick is
   guaranteed absent upstream and the handover always has to do something. */
section('provisional rosters');

const CACHED_IDS = ['abrams', 'bebop', 'dynamo', 'haze', 'infernus', 'lash'];
const LIVE_IDS = ['mcginnis', 'seven', 'talon', 'vindicta', 'warden', 'wraith'];
const feedFor = (list) => list.map((id) => ({
  name: id, class_name: `hero_${id}`, complexity: 2, hero_type: 'mystic',
  images: { icon_hero_card: `https://assets.test/${id}.png` }, description: 'a blurb',
}));
const cachedFeed = feedFor(CACHED_IDS);
const liveFeed = feedFor(LIVE_IDS);

/** Leave a CACHED_IDS roster in the cache, with settings under the test's control. */
const seedRosterCache = async () => {
  resetBrowser();
  stubFetch(cachedFeed);
  const warm = new OracleStore();
  await warm.load();
  storage.delete('draftOracle_v1');
};

await seedRosterCache();
resetBrowser({ keepStorage: true });
stubFetch(liveFeed);
const handover = new OracleStore();
await handover.load();
check('one draw is recorded even when the primed pick is not in the live roster',
  handover.pickCount === 1, `pickCount=${handover.pickCount}`);
check('the tally holds only the hero actually drawn', Object.keys(handover.tally).length === 1, JSON.stringify(handover.tally));
check('and the drawn hero is a live one', LIVE_IDS.includes(handover.squad[0].id), squadIds(handover));

// Saved state must not be reconciled against a roster that merely predates it.
await seedRosterCache();
resetBrowser({ keepStorage: true });
storage.set('draftOracle_v1', JSON.stringify({ excluded: ['wraith', 'abrams'], recent: [], tally: {}, pickCount: 0 }));
stubFetch(liveFeed);
const reconciled = new OracleStore();
await reconciled.load();
check('an exclusion the cache has never heard of survives priming', reconciled.excluded.has('wraith'),
  `excluded=[${[...reconciled.excluded].join(',')}]`);
check('it survives in localStorage too',
  JSON.parse(storage.get('draftOracle_v1')).excluded.includes('wraith'));
check('an exclusion the LIVE roster dropped is still pruned', !reconciled.excluded.has('abrams'),
  `excluded=[${[...reconciled.excluded].join(',')}]`);

// A share link naming a hero the stale cache lacks must not be trampled by the
// provisional opening draw writing its own hash over it.
await seedRosterCache();
resetBrowser({ hash: '#squad=wraith', state: null, keepStorage: true });
storage.delete('draftOracle_v1');
stubFetch(liveFeed);
const lateGuest = await quietly(async () => { const store = new OracleStore(); await store.load(); return store; });
check('a share link the cache cannot resolve survives until the live roster can',
  squadIds(lateGuest) === 'wraith', squadIds(lateGuest));
check('and is still labelled SHARED DRAW', lateGuest.shared, lateGuest.stageLabel);
check('the sender hash was never overwritten', location.hash === '#squad=wraith', location.hash);

// With no feed at all the cache becomes authoritative, and everything priming
// deferred has to happen then.
await seedRosterCache();
resetBrowser({ keepStorage: true });
storage.set('draftOracle_v1', JSON.stringify({ excluded: ['nobody'], recent: [], tally: {}, pickCount: 0 }));
stubFetch('fail');
const promoted = await quietly(async () => { const store = new OracleStore(); await store.load(); return store; });
check('a dead network promotes the cache and banks its draw', promoted.pickCount === 1, `pickCount=${promoted.pickCount}`);
check('and reconciles saved state against it', !promoted.excluded.has('nobody'), [...promoted.excluded].join(','));
check('the draw is in the address bar once it is real', location.hash.startsWith('#squad='), location.hash);

// A link naming a hero this roster cannot resolve is not a dead link — it may
// just predate the roster. Overwriting the hash there loses it for good: the
// user reconnects and the link is no longer in the address bar to retry.
await seedRosterCache();
resetBrowser({ hash: '#squad=wraith', state: null, keepStorage: true });
storage.delete('draftOracle_v1');
stubFetch('fail');
const strandedLink = await quietly(async () => { const store = new OracleStore(); await store.load(); return store; });
check('an unresolvable share link keeps its place in the address bar', location.hash === '#squad=wraith', location.hash);
check('the fallback draw is shown', strandedLink.mode === 'draw' && strandedLink.squad.length === 1, squadIds(strandedLink));
check('but is not banked over the link it stands in for', strandedLink.pickCount === 0, `pickCount=${strandedLink.pickCount}`);
check('so the tally stays clean', Object.keys(strandedLink.tally).length === 0, JSON.stringify(strandedLink.tally));

// …and reconnecting recovers it, which is the whole point of preserving it.
resetBrowser({ hash: location.hash, state: history.state, keepStorage: true });
stubFetch(feedFor([...CACHED_IDS, 'wraith']));
const reconnected = new OracleStore();
await reconnected.load();
check('reconnecting recovers the sender\u2019s draw', squadIds(reconnected) === 'wraith', squadIds(reconnected));
check('and it is still SHARED DRAW', reconnected.shared, reconnected.stageLabel);

// A live roster that genuinely does not have the hero is a different case: the
// link is dead, and the app is entitled to take the address bar back.
resetBrowser({ hash: '#squad=nobody', state: null });
stubFetch(liveFeed);
const deadLink = new OracleStore();
await deadLink.load();
check('a live roster may conclude an unknown hero is gone',
  deadLink.pickCount === 1 && location.hash !== '#squad=nobody' && location.hash.startsWith('#squad='),
  `${location.hash} pickCount=${deadLink.pickCount}`);

// Back/forward onto an entry this tab wrote.
resetBrowser();
stubFetch(liveFeed);
const navigating = new OracleStore();
await navigating.load();
const ownHash = location.hash;
const ownState = history.state;
const ownSquad = squadIds(navigating);
location.hash = '#squad=talon';
history.state = null;
navigating.applySharedFromHash();
check('navigating to a pasted link shows it', squadIds(navigating) === 'talon', squadIds(navigating));
location.hash = ownHash;
history.state = ownState;
navigating.applySharedFromHash();
check('going back to our own entry re-shows that draw', squadIds(navigating) === ownSquad,
  `${squadIds(navigating)} vs ${ownSquad}`);
check('and does not relabel it as shared', !navigating.shared, navigating.stageLabel);

// An emptied stage belongs to nobody.
resetBrowser({ hash: '#squad=talon', state: null });
stubFetch(liveFeed);
const emptiedShare = new OracleStore();
await emptiedShare.load();
check('the pasted draw starts out shared', emptiedShare.shared, emptiedShare.stageLabel);
for (const id of LIVE_IDS) emptiedShare.toggleExcluded(id);
emptiedShare.roll();
check('emptying the pool drops the SHARED DRAW label',
  !emptiedShare.shared && !emptiedShare.stageLabel.includes('SHARED'), emptiedShare.stageLabel);

restoreFetch();

/* ── A received link stays received ──
   The marker means "this tab produced the draw this hash describes", not "the
   app has seen this hash". Restoring a shared draw therefore leaves the address
   bar alone: stamping it would make this tab the author, and the recipient
   would get a fresh roll on reload instead of the draw they were sent — while
   the link they were given was quietly rewritten out of their address bar. */
section('a received link stays received');

const SHARED_HASH = '#squad=haze,lash';

// 1. Fresh navigation to a shared link.
resetBrowser({ hash: SHARED_HASH, state: null });
stubFetch(feed);
const guest = new OracleStore();
await guest.load();
check('a shared link opens as a shared draw', guest.shared && squadIds(guest) === 'haze,lash', guest.stageLabel);
check('restoring it leaves the address bar untouched', location.hash === SHARED_HASH, location.hash);
check('and does not stamp the tab as its author', !isOwnHash(), JSON.stringify(history.state));

// 2. Reloading that page.
resetBrowser({ hash: location.hash, state: history.state, keepStorage: true });
stubFetch(feed);
const guestAgain = new OracleStore();
await guestAgain.load();
check('reloading a received link keeps the same heroes', squadIds(guestAgain) === 'haze,lash', squadIds(guestAgain));
check('reloading a received link is still SHARED DRAW', guestAgain.shared, guestAgain.stageLabel);

// 3. Copying the received link must not claim it either.
await guestAgain.copyLink();
check('copying a received link does not claim its hash', !isOwnHash(), JSON.stringify(history.state));
check('and the hash it copied is the one that arrived', location.hash === SHARED_HASH, location.hash);
resetBrowser({ hash: location.hash, state: history.state, keepStorage: true });
stubFetch(feed);
const guestAfterCopy = new OracleStore();
await guestAfterCopy.load();
check('still shared after copying and reloading', guestAfterCopy.shared && squadIds(guestAfterCopy) === 'haze,lash',
  guestAfterCopy.stageLabel);

// 4. Rolling makes the tab the author again.
resetBrowser({ hash: SHARED_HASH, state: null });
stubFetch(feed);
const guestWhoRolls = new OracleStore();
await guestWhoRolls.load();
guestWhoRolls.roll();
check('rolling after a shared draw drops the shared label', !guestWhoRolls.shared, guestWhoRolls.stageLabel);
check('rolling writes a hash this tab owns', isOwnHash(), `${location.hash} ${JSON.stringify(history.state)}`);

resetBrowser({ hash: location.hash, state: history.state, keepStorage: true });
stubFetch(feed);
const afterRolling = new OracleStore();
await afterRolling.load();
check('reloading after that rolls again rather than restoring', !afterRolling.shared && afterRolling.mode === 'draw',
  afterRolling.stageLabel);

// Rerolling one slot of a received squad is equally an act of authorship.
resetBrowser({ hash: SHARED_HASH, state: null });
stubFetch(feed);
const guestWhoRerolls = new OracleStore();
await guestWhoRerolls.load();
guestWhoRerolls.rerollSlot(1);
check('rerolling a slot of a received squad claims it', !guestWhoRerolls.shared && isOwnHash(),
  `${guestWhoRerolls.stageLabel} ${location.hash}`);

restoreFetch();

/* ── Cache-first loading ──
   The cached roster used to be the last resort, read only after every source
   had exhausted FETCH_TIMEOUT_MS — a returning visitor waited a measured 16s
   staring at "Loading" with a complete roster already in localStorage. It is
   now painted first and replaced when the network answers, which puts a second
   adoptRoster() pass on the hot path: these checks are mostly about that pass
   not disturbing what the first one put on screen. */
section('cache-first loading');

// Warm the cache with a successful load, then keep only the roster half of it.
resetBrowser();
stubFetch(feed);
const warming = new OracleStore();
await warming.load();
check('a successful load writes the roster cache', storage.has('draftOracle_v1_roster'));

resetBrowser({ keepStorage: true });
storage.delete('draftOracle_v1');
stubFetch('fail');
const offlineStart = new OracleStore();
const pendingLoad = quietly(() => offlineStart.load());
// The prime runs before load() reaches its first await, so this is observable
// without waiting for the network at all — which is the entire point.
check('the cached roster is on screen before any feed answers',
  offlineStart.heroes.length === rosterIds.length && offlineStart.mode === 'draw',
  `${offlineStart.heroes.length} heroes, mode=${offlineStart.mode}`);
check('and it has already drawn from it', offlineStart.squad.length === 1, squadIds(offlineStart));
check('the status says it is provisional', /checking for updates/.test(offlineStart.statusMessage), offlineStart.statusMessage);
await pendingLoad;
check('when every feed fails the cached roster simply stays', offlineStart.mode === 'draw' && offlineStart.heroes.length === rosterIds.length);
check('and the status settles on the cached source', offlineStart.statusMessage.startsWith('Cached roster ·') && offlineStart.statusKind === 'error',
  `${offlineStart.statusMessage} (${offlineStart.statusKind})`);

// Cache primes, then the live feed answers and takes over.
resetBrowser({ keepStorage: true });
storage.delete('draftOracle_v1');
stubFetch(feed);
const primedLive = new OracleStore();
await primedLive.load();
check('a live feed replaces the primed roster', primedLive.statusKind === 'live' && primedLive.source === SOURCES[0].name,
  `${primedLive.statusMessage} (${primedLive.source})`);
check('priming then going live records exactly one draw', primedLive.pickCount === 1, String(primedLive.pickCount));
check('and keeps the hero the primed roster drew', primedLive.squad.length === 1 && primedLive.mode === 'draw', squadIds(primedLive));

// A roster that shrank upstream must not leave the primed copy behind.
resetBrowser({ keepStorage: true });
storage.delete('draftOracle_v1');
stubFetch(feed.filter((entry) => entry.name !== 'seven'));
const shrunkLive = new OracleStore();
await shrunkLive.load();
check('the live roster replaces the primed one wholesale', shrunkLive.heroes.length === rosterIds.length - 1,
  `${shrunkLive.heroes.length} heroes`);
check('a hero dropped upstream is gone from the roster', !shrunkLive.heroes.some((member) => member.id === 'seven'));

// A share link opened against a primed roster is still somebody else's draw.
resetBrowser({ hash: '#squad=haze,lash', state: null, keepStorage: true });
storage.delete('draftOracle_v1');
stubFetch(feed);
const primedShare = new OracleStore();
await primedShare.load();
check('a share link survives the prime-then-live handover', squadIds(primedShare) === 'haze,lash', squadIds(primedShare));
check('and is still labelled SHARED DRAW', primedShare.shared && primedShare.stageLabel.includes('SHARED DRAW'), primedShare.stageLabel);

// A manual refresh that fails keeps the live roster, and does not fall back to
// an older cached copy of it.
resetBrowser();
stubFetch(feed);
const refreshFails = new OracleStore();
await refreshFails.load();
const liveCount = refreshFails.heroes.length;
stubFetch('fail');
await quietly(() => refreshFails.load());
check('a failed refresh keeps the roster on screen', refreshFails.heroes.length === liveCount && refreshFails.mode === 'draw');
check('a failed refresh says so rather than claiming a cache', refreshFails.statusMessage === 'Refresh failed — keeping current roster',
  refreshFails.statusMessage);

// Nothing cached and nothing reachable is still the offline stage.
resetBrowser();
stubFetch('fail');
const nothing = new OracleStore();
await quietly(() => nothing.load());
check('no cache and no network is the offline stage', nothing.mode === 'offline' && nothing.heroes.length === 0, nothing.mode);
check('the offline stage explains itself', nothing.announcement.includes('Live roster unavailable'), nothing.announcement);

restoreFetch();

/* ── What the screen reader is told ──
   The stage heading is keyed on the draw, so it is replaced rather than
   updated and announces nothing; the roster grid was the only live region and
   it spoke for thirty cards at once. One sentence, in one place, is the fix —
   and it has to differ between consecutive draws or a live region stays
   silent. */
section('draw announcements');

resetBrowser();
stubFetch(feed);
const spoken = new OracleStore();
await spoken.load();
const firstSaid = spoken.announcement;
check('a solo draw is announced by name', firstSaid.includes(spoken.squad[0].name), firstSaid);
check('the announcement carries the pick number', /^Pick \d+:/.test(firstSaid), firstSaid);

// Force the same hero twice: the text must still change, or nothing is read out.
const only = spoken.squad[0];
for (const member of rosterIds.filter((id) => id !== only.id)) spoken.toggleExcluded(member);
spoken.roll();
const repeatOne = spoken.announcement;
spoken.roll();
const repeatTwo = spoken.announcement;
check('drawing the same hero twice still changes the announcement',
  repeatOne !== repeatTwo && repeatOne.includes(only.name) && repeatTwo.includes(only.name),
  `${repeatOne} -> ${repeatTwo}`);

resetBrowser({ hash: '#squad=haze,lash', state: null });
stubFetch(feed);
const spokenShare = new OracleStore();
await spokenShare.load();
check('a shared draw says so', spokenShare.announcement.startsWith('Shared draw:'), spokenShare.announcement);
check('a squad announcement names every member',
  spokenShare.squad.every((member) => spokenShare.announcement.includes(member.name)),
  spokenShare.announcement);

resetBrowser();
stubFetch(feed);
const spokenEmpty = new OracleStore();
await spokenEmpty.load();
for (const id of rosterIds) spokenEmpty.toggleExcluded(id);
spokenEmpty.roll();
check('an empty pool explains itself', spokenEmpty.announcement.includes('No hero is eligible'), spokenEmpty.announcement);

resetBrowser();
stubFetch(feed);
const searched = new OracleStore();
await searched.load();
check('the roster announces its size', searched.rosterAnnouncement === `${rosterIds.length} heroes.`, searched.rosterAnnouncement);
searched.setSearch('haze');
check('searching announces the match count', searched.rosterAnnouncement === '1 hero matches.', searched.rosterAnnouncement);
searched.setSearch('zzzz');
check('a search with no matches says zero', searched.rosterAnnouncement === '0 heroes match.', searched.rosterAnnouncement);

restoreFetch();

/* ── Cache and parsing guards ── */
section('cache and parsing guards');

check('isHeroRecord accepts a current record', isHeroRecord(hero()));
// The metadata fields were added after the first release; a roster cached before
// then must be rejected and refetched, not loaded with the filters dead.
const { complexity: _c, role: _r, weapon: _w, accent: _a, aliases: _al, ...legacy } = hero();
check('isHeroRecord rejects a pre-metadata cached record', !isHeroRecord(legacy));
for (const field of ['complexity', 'role', 'weapon', 'accent', 'aliases']) {
  check(`isHeroRecord rejects a record missing \`${field}\``, !isHeroRecord({ ...hero(), [field]: undefined }));
}
check('isHeroRecord rejects junk', [null, undefined, 42, 'x', [], {}].every((v) => !isHeroRecord(v)));
check('isHeroRecord rejects a blank name', !isHeroRecord(hero({ name: '   ' })));

const origin = 'https://deadlock.io';
check('normalise rejects an entry with no name', normalise({}, 0, origin) === null);
check('normalise rejects dota leftovers', normalise({ name: 'npc_dota_hero_axe' }, 0, origin) === null);
check('normalise rejects raw internal names', normalise({ name: 'hero_inferno' }, 0, origin) === null);

const dynamo = normalise({ class_name: 'HERO_Sumo', name: 'Dynamo', complexity: 2, colors: { style_hex: '#D0B945' } }, 0, origin);
check('normalise derives a lowercase slug id from the class name', dynamo.id === 'sumo', dynamo.id);
check('normalise keeps the display name', dynamo.name === 'Dynamo');
check('normalise reads complexity and accent', dynamo.complexity === 2 && dynamo.accent === '#D0B945');
check('normalise rejects a malformed accent', normalise({ name: 'X', colors: { style_hex: 'goldenrod' } }, 0, origin).accent === '');
check('normalise defaults complexity to 0 when absent', normalise({ name: 'X' }, 0, origin).complexity === 0);
check('normalise marks disabled heroes unreleased', normalise({ name: 'X', disabled: true }, 0, origin).released === false);
check('normalise resolves relative art against the feed origin',
  normalise({ name: 'X', image: '/a/b.png' }, 0, origin).image === 'https://deadlock.io/a/b.png');

check('parseRoster de-duplicates and sorts', (() => {
  const heroes = parseRoster([{ class_name: 'hero_b', name: 'Beta' }, { class_name: 'hero_a', name: 'Alpha' }, { class_name: 'hero_b', name: 'Beta' }], origin);
  return heroes.length === 2 && heroes[0].name === 'Alpha';
})());
check('unwrap finds heroes under a wrapper key', unwrap({ source: {}, heroes: [{ name: 'A' }] }).length === 1);
check('unwrap passes a bare array through', unwrap([{ name: 'A' }, { name: 'B' }]).length === 2);

check('aliasesFrom flattens a localized object',
  aliasesFrom({ displayName: { english: 'Infernus', byLanguage: { english: 'Infernus', schinese: '炽焱' } } }) === 'infernus 炽焱');
check('aliasesFrom handles a plain string name', aliasesFrom({ name: 'Dynamo' }) === 'dynamo');
check('aliasesFrom returns empty for a nameless entry', aliasesFrom({}) === '');

// cssUrl output is interpolated straight into a CSS url("…"), so a quote in a
// feed-supplied path must not be able to close it.
check('cssUrl escapes double quotes', cssUrl('a"b') === 'url("a\\"b")', cssUrl('a"b'));
check('cssUrl escapes backslashes', cssUrl('a\\b') === 'url("a\\\\b")', cssUrl('a\\b'));

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
  cardRatio === null ? 'no aspect-ratio declared' : `${cardRatio.toFixed(2)} vs art ${artRatio.toFixed(2)} (crops ${((1 - artRatio / cardRatio) * 100).toFixed(0)}% of the height)`);
// Art below ~.35 opacity disappears into the card background; dark clothing goes
// first, so only faces read.
for (const [selector, floor] of [['.card-art', 0.4], ['.slot-art', 0.4]]) {
  const opacity = Number(cssRule(selector).match(/opacity:\s*([\d.]+)/)?.[1] ?? 0);
  check(`${selector} is opaque enough for the character to read`, opacity >= floor, `opacity ${opacity}`);
}
// React sets `background-image` inline on these, so any rule that reaches them
// with the `background` SHORTHAND silently resets repeat/size/position and the
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

/* ── Styled-class coverage ──
   styles.css is shared, hand-written CSS applied by class name, so a component
   that drops or renames a class silently unstyles an element — and nothing here
   can see a rendered page. Assert instead that every class the stylesheet
   targets is still produced somewhere in the source. */
section('styled-class coverage');

const walk = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));

const markup = [
  ...walk(join(root, 'src')).filter((file) => /\.tsx?$/.test(file)).map((file) => readFileSync(file, 'utf8')),
  readFileSync(join(root, 'index.html'), 'utf8'),
].join('\n');

const styledClasses = new Set([...bareCss.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]));
// Every string literal in the source, split on whitespace — className values,
// classes() arguments and conditional state classes all land here.
const renderedTokens = new Set(
  [...markup.matchAll(/['"`]([^'"`\n]*)['"`]/g)].flatMap((match) => match[1].split(/\s+/)).filter(Boolean),
);
const unstyled = [...styledClasses].filter((name) => !renderedTokens.has(name)).sort();
check('every class styles.css targets is still rendered', unstyled.length === 0,
  unstyled.length ? `no component produces: ${unstyled.map((n) => `.${n}`).join(', ')}` : `all ${styledClasses.size} classes`);

/* ── Social metadata ──
   Every share link used to unfurl as a bare URL. The card assets live in
   public/ and are copied verbatim, so nothing else validates them: this checks
   the tags exist, that the two URLs a crawler cannot resolve for itself are
   absolute and agree with package.json, and that og.png is still the size the
   tags claim. */
section('social metadata');

const html = readFileSync(join(root, 'index.html'), 'utf8');
const homepage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).homepage;
const meta = (name) => html.match(new RegExp(`(?:property|name)="${name}" content="([^"]*)"`))?.[1] ?? null;

for (const tag of ['og:title', 'og:description', 'og:url', 'og:image', 'twitter:card', 'twitter:image']) {
  check(`index.html declares ${tag}`, Boolean(meta(tag)), meta(tag) ?? 'missing');
}
check('og:url is absolute and matches package.json homepage', meta('og:url') === homepage,
  `${meta('og:url')} vs ${homepage}`);
check('og:image is absolute', /^https:\/\//.test(meta('og:image') ?? ''), meta('og:image') ?? 'missing');
check('og:image sits under the deployed homepage', (meta('og:image') ?? '').startsWith(homepage), meta('og:image') ?? '');
check('twitter:image matches og:image', meta('twitter:image') === meta('og:image'));
check('the card is a summary_large_image', meta('twitter:card') === 'summary_large_image', meta('twitter:card') ?? '');

const card = readFileSync(join(root, 'public/og.png'));
const cardIsPng = card.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const cardSize = cardIsPng ? { w: card.readUInt32BE(16), h: card.readUInt32BE(20) } : null;
check('public/og.png is a PNG', cardIsPng);
// Below 200x200 a crawler drops the card entirely; the declared size has to be
// the real one or the preview is letterboxed.
check('og.png is the size the tags declare',
  cardSize?.w === Number(meta('og:image:width')) && cardSize?.h === Number(meta('og:image:height')),
  cardSize ? `${cardSize.w}x${cardSize.h}` : 'unreadable');
check('og.png is within the 5MB most crawlers accept', card.length < 5_000_000, `${(card.length / 1024).toFixed(0)}KB`);
check('a favicon and a touch icon ship with it',
  readFileSync(join(root, 'public/favicon.svg')).length > 0 && readFileSync(join(root, 'public/apple-touch-icon.png')).length > 0);

/* ── Subpath safety ──
   Production is served from a repo subpath, so a root-relative URL in a
   component leaves the site entirely — an `href="/"` in the header shipped a
   link to a 404. `base: './'` cannot catch it: Vite rewrites index.html and
   imported assets, never a runtime attribute. Neither `npm run dev` nor
   `npm run preview` reproduces it either, since both serve from the origin
   root — so this check is the only thing between that bug and production. */
section('subpath safety');

const rootRelative = walk(join(root, 'src'))
  .filter((file) => /\.tsx?$/.test(file))
  .flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/(?:href|src|action)=["']\/(?!\/)[^"']*["']/g)]
    .map((match) => `${file.slice(root.length + 1)} ${match[0]}`));
check('no component builds a root-relative URL', rootRelative.length === 0,
  rootRelative.length ? rootRelative.join('; ') : 'every link is relative to the deployed base');

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
      const payload = await response.json();
      const entries = unwrap(payload);
      const heroes = parseRoster(payload, source.origin);
      const released = heroes.filter((h) => h.released);
      check(`${source.name}: unwrap found entries`, entries.length > 0, `${entries.length} entries`);
      check(`${source.name}: parseRoster produced heroes`, heroes.length >= 5, `${heroes.length} heroes`);
      check(`${source.name}: every hero passes isHeroRecord`, heroes.every(isHeroRecord));
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
        [...new Set(heroes.map((h) => h.role).filter(Boolean))].join(', ') || 'none in this feed');
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
    section('cross-feed merge against live data');
    // A failover must not orphan saved exclusions, tally entries or share links.
    const fallbackIds = new Set(fallback.map((h) => h.id));
    const orphans = primary.map((h) => h.id).filter((id) => !fallbackIds.has(id));
    check('ids are stable across a source failover', orphans.length === 0,
      orphans.length ? `orphaned: ${orphans.join(', ')}` : `all ${primary.length} primary ids present in fallback`);
    check('both sources agree on the released roster',
      Math.abs(fallback.filter((h) => h.released).length - primary.filter((h) => h.released).length) <= 3,
      `primary ${primary.filter((h) => h.released).length}, fallback ${fallback.filter((h) => h.released).length}`);

    // Run the real merge and assert the union is complete — this is what the role
    // filter and the accent colour depend on.
    const merged = primary.map((h) => ({ ...h }));
    mergeInto(merged, new Map(fallback.map((h) => [h.id, h])));
    const mergedReleased = merged.filter((h) => h.released);
    for (const field of ['accent', 'aliases', 'complexity']) {
      const missing = mergedReleased.filter((h) => !h[field]).map((h) => h.id);
      check(`after the merge every released hero has \`${field}\``, missing.length === 0,
        missing.length ? `missing for: ${missing.join(', ')}` : `all ${mergedReleased.length}`);
    }
    // `hero_type` has genuine upstream gaps (Familiar has never carried one), so
    // this tolerates a couple of stragglers but still fails if the feed drops the
    // field wholesale.
    const roleless = mergedReleased.filter((h) => !h.role).map((h) => h.id);
    check('after the merge nearly every released hero has `role`', roleless.length <= 2,
      `${mergedReleased.length - roleless.length}/${mergedReleased.length}${roleless.length ? ` — no role: ${roleless.join(', ')}` : ''}`);

    const alias = merged.find((h) => h.id === 'inferno');
    check('aliases carry non-English spellings',
      Boolean(alias) && /[^\x00-\x7f]/.test(alias.aliases) && alias.aliases.includes('infernus'),
      alias ? `${alias.aliases.split(' ').length} tokens` : 'inferno not found');

    // The art boxes checked above are sized to ART; confirm upstream still ships it.
    section('upstream art dimensions');
    const sizes = [];
    for (const { image } of mergedReleased.slice(0, 5)) {
      try {
        const res = await fetch(image, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(20000) });
        const buf = Buffer.from(await res.arrayBuffer());
        const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        sizes.push(isPng ? `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}` : 'not-png');
      } catch { /* one flaky request should not fail the run */ }
    }
    check(`hero art is still the ${ART.w}x${ART.h} portrait the CSS is sized for`,
      sizes.length > 0 && sizes.every((size) => size === `${ART.w}x${ART.h}`),
      sizes.length ? `${sizes.join(' ')}${sizes.length < 5 ? ` (${5 - sizes.length} unreachable)` : ''}` : 'no art reachable');
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
// Setting exitCode rather than calling process.exit(): an abrupt exit while
// keep-alive sockets are still open trips a libuv assertion on Windows.
process.exitCode = failures ? 1 : 0;
