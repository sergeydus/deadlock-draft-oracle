/**
 * Deadlock Draft Oracle — a hero randomizer for the game Deadlock.
 *
 * No build step, no dependencies: open index.html (or `npm start`) and it runs.
 *
 * Data flow:
 *   getLiveHeroes()  fetch a community feed -> unwrap() -> normalise() -> state.heroes
 *                    (falls back to the next source, then to the localStorage cache)
 *   roll()           draw N distinct heroes from eligibleHeroes() using the seeded rng
 *   commitDraw()     make a draw current: stage art, squad strip, recents, tally, URL hash
 *   render()         repaint every derived surface from `state` (never mutates state)
 *
 * The roster grid is built once per roster load (buildRoster) and afterwards only
 * has classes toggled (syncRosterState / applySearch) — no per-keystroke rebuilds.
 */

/**
 * @typedef {object} Hero
 * @property {string} id           Stable id from the feed; the key for exclusions, tally and share links.
 * @property {string} name         Display name, already stripped of `hero_` prefixes.
 * @property {string} description  May be an empty string; the stage falls back to filler copy.
 * @property {string} image        Absolute URL, or an empty string when the feed had no art.
 * @property {boolean} released    False for unreleased/test characters.
 * @property {number} complexity   1-4 as rated by the game, or 0 when unknown.
 * @property {string} role         'marksman' | 'assassin' | 'mystic' | 'brawler', or '' when unknown.
 * @property {string} weapon       Gun archetype ('Pistol', 'Spreadshot', …), or ''.
 * @property {string} accent       Hero accent colour as '#rrggbb', or ''.
 * @property {string} aliases      Lowercased localized names + romanizations, for search.
 */

const SOURCES = [
  { url: 'https://deadlock.io/api/v1/heroes.json', name: 'deadlock.io', origin: 'https://deadlock.io' },
  { url: 'https://assets.deadlock-api.com/v2/heroes', name: 'deadlock-api.com', origin: 'https://assets.deadlock-api.com' },
];
const RECENT_LIMIT = 5;
const MAX_SQUAD = 6; // Deadlock is 6v6, so a full stack is six heroes.
const COMPLEXITY_LEVELS = [1, 2, 3, 4]; // The game's own rating; both feeds agree on it.
const ROLE_ORDER = ['marksman', 'assassin', 'mystic', 'brawler']; // deadlock-api `hero_type`.
const TALLY_ROWS = 6;
const FETCH_TIMEOUT_MS = 8000;
const STORAGE_KEY = 'draftOracle_v1';
const ROSTER_KEY = `${STORAGE_KEY}_roster`;

/**
 * Single source of truth. Everything on screen is derived from this by render().
 * @type {{heroes: Hero[], byId: Map<string, Hero>, squad: Hero[], featured: number,
 *         squadSize: number, coverRoles: boolean,
 *         filters: {complexity: Set<number>, roles: Set<string>},
 *         excluded: Set<string>, recent: Hero[],
 *         tally: Record<string, number>, pickCount: number, source: string,
 *         fetching: boolean, seed: number, shared: boolean}}
 */
const state = {
  heroes: [],
  byId: new Map(),
  squad: [],        // The current draw. Length 1 for a solo pick, up to MAX_SQUAD for a stack.
  featured: 0,      // Index into squad shown large on the stage.
  squadSize: 1,
  coverRoles: false, // Squad draws take one of each role before filling the rest.
  // An empty set means "no constraint" for roles; complexity defaults to all levels.
  filters: { complexity: new Set(COMPLEXITY_LEVELS), roles: new Set() },
  excluded: new Set(),
  recent: [],
  tally: {},        // heroId -> times drawn, lifetime
  pickCount: 0,     // lifetime draws, including every member of a squad draw
  source: '',
  fetching: false,
  seed: 0,
  shared: false,    // true when the current draw came from a #squad= link rather than a roll
};

const $ = (selector) => document.querySelector(selector);
const els = {
  name: $('#heroName'), description: $('#heroDescription'), number: $('#heroNumber'), art: $('#heroArt'),
  roll: $('#rollButton'), rollLabel: $('#rollLabel'), exclude: $('#excludePickedButton'), share: $('#shareButton'),
  refresh: $('#refreshButton'), source: $('#sourceStatus'), count: $('#eligibleCount'),
  rosterTitle: $('#rosterTitle'), grid: $('#rosterGrid'), recent: $('#recentList'), squadStrip: $('#squadStrip'),
  squadSize: $('#squadSize'), tallyList: $('#tallyList'), tallyTotal: $('#tallyTotal'), clearTally: $('#clearTally'),
  stage: $('.hero-stage'), heroTags: $('#heroTags'), complexityFilter: $('#complexityFilter'),
  roleFilter: $('#roleFilter'), roleRow: $('#roleRow'), coverRolesRow: $('#coverRolesRow'), coverRolesToggle: $('#coverRolesToggle'),
  recentToggle: $('#recentToggle'), releasedToggle: $('#releasedToggle'), search: $('#searchInput'),
  clear: $('#clearHistory'), toast: $('#toast'),
  cardTemplate: $('#heroCardTemplate'), slotTemplate: $('#squadSlotTemplate'), tallyTemplate: $('#tallyRowTemplate'),
};

/** Roster cards, built once per roster load and then only reclassed. @type {Map<string, HTMLElement>} */
const cardIndex = new Map();
const emptyRoster = Object.assign(document.createElement('p'), { className: 'empty-roster', hidden: true, textContent: 'No hero matches that signal.' });

/* ── Randomness ────────────────────────────────────────────────────────────
   A seeded PRNG rather than Math.random so a draw is reproducible from its
   seed. That is also the hook a future online-lobby mode needs: the server
   broadcasts one seed and every client derives the same draw. */

/** @returns {() => number} A deterministic float generator in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rng = mulberry32(1);
function randomSeed() {
  if (globalThis.crypto?.getRandomValues) return crypto.getRandomValues(new Uint32Array(1))[0];
  return Math.floor(Math.random() * 0xffffffff);
}
function reseed(seed = randomSeed()) {
  state.seed = seed >>> 0;
  rng = mulberry32(state.seed);
}

/**
 * Draw `count` distinct items from `pool`. Called with count === pool.length it
 * is simply a shuffle.
 * @template T
 * @param {T[]} pool
 * @param {number} count
 * @returns {T[]} Up to `count` items; fewer if the pool is too small.
 */
function drawFrom(pool, count) {
  const bag = [...pool];
  const drawn = [];
  while (drawn.length < count && bag.length) drawn.push(...bag.splice(Math.floor(rng() * bag.length), 1));
  return drawn;
}

/**
 * Draw a squad, optionally guaranteeing role coverage.
 *
 * With coverage on, one hero is taken from each role before the remaining slots
 * are filled at random. Roles are visited in random order so that a squad
 * smaller than the number of roles does not always favour the same ones, and the
 * result is shuffled so the featured hero is not always the first role drawn.
 * @param {Hero[]} pool
 * @param {number} size
 * @returns {Hero[]}
 */
function drawSquad(pool, size) {
  const roles = [...new Set(pool.map((hero) => hero.role).filter(Boolean))];
  if (!state.coverRoles || size < 2 || roles.length < 2) return drawFrom(pool, size);
  const picked = [];
  const used = new Set();
  for (const role of drawFrom(roles, roles.length)) {
    if (picked.length >= size) break;
    const candidates = pool.filter((hero) => hero.role === role && !used.has(hero.id));
    if (!candidates.length) continue;
    const [hero] = drawFrom(candidates, 1);
    picked.push(hero);
    used.add(hero.id);
  }
  const rest = drawFrom(pool.filter((hero) => !used.has(hero.id)), size - picked.length);
  return drawFrom([...picked, ...rest], size);
}

/* ── Storage helpers ────────────────────────────────────────────────────── */

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      excluded: [...state.excluded],
      recent: state.recent,
      tally: state.tally,
      pickCount: state.pickCount,
      squadSize: state.squadSize,
      coverRoles: state.coverRoles,
      complexityFilter: [...state.filters.complexity],
      roleFilter: [...state.filters.roles],
      recentToggle: els.recentToggle.checked,
      releasedToggle: els.releasedToggle.checked,
    }));
  } catch (_) { /* quota or private-mode – silently skip */ }
}
function saveCachedRoster() {
  try {
    localStorage.setItem(ROSTER_KEY, JSON.stringify({ heroes: state.heroes, source: state.source }));
  } catch (_) { /* skip */ }
}
/**
 * Runtime shape guard — cached/restored data may predate the current schema.
 * The metadata fields are checked too, so a cache written before they existed is
 * rejected and refetched rather than silently disabling the filters.
 */
function isHeroRecord(hero) {
  return hero !== null
    && typeof hero === 'object'
    && typeof hero.id === 'string'
    && hero.id.length > 0
    && typeof hero.name === 'string'
    && hero.name.trim().length > 0
    && typeof hero.description === 'string'
    && typeof hero.image === 'string'
    && typeof hero.released === 'boolean'
    && typeof hero.complexity === 'number'
    && typeof hero.role === 'string'
    && typeof hero.weapon === 'string'
    && typeof hero.accent === 'string'
    && typeof hero.aliases === 'string';
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.excluded)) data.excluded.filter((id) => typeof id === 'string').forEach((id) => state.excluded.add(id));
    if (Array.isArray(data.recent)) state.recent = data.recent.filter(isHeroRecord).slice(0, RECENT_LIMIT);
    if (data.tally && typeof data.tally === 'object') {
      for (const [id, count] of Object.entries(data.tally)) if (Number.isFinite(count) && count > 0) state.tally[id] = count;
    }
    if (Number.isFinite(data.pickCount) && data.pickCount >= 0) state.pickCount = data.pickCount;
    if (Number.isFinite(data.squadSize)) state.squadSize = Math.min(MAX_SQUAD, Math.max(1, data.squadSize));
    if (typeof data.coverRoles === 'boolean') state.coverRoles = data.coverRoles;
    if (Array.isArray(data.complexityFilter)) {
      const levels = data.complexityFilter.filter((level) => COMPLEXITY_LEVELS.includes(level));
      if (levels.length) state.filters.complexity = new Set(levels);
    }
    if (Array.isArray(data.roleFilter)) state.filters.roles = new Set(data.roleFilter.filter((role) => ROLE_ORDER.includes(role)));
    if (typeof data.recentToggle === 'boolean') els.recentToggle.checked = data.recentToggle;
    if (typeof data.releasedToggle === 'boolean') els.releasedToggle.checked = data.releasedToggle;
  } catch (_) { /* corrupt data – start fresh */ }
}
function loadCachedRoster() {
  try {
    const raw = localStorage.getItem(ROSTER_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Array.isArray(data.heroes)
      && data.heroes.length >= 5
      && data.heroes.every(isHeroRecord)
      && typeof data.source === 'string'
      && data.source.trim()) return data;
  } catch (_) { /* skip */ }
  return null;
}

/* ── Feed parsing ──────────────────────────────────────────────────────────
   The two sources return quite different shapes, so every accessor below is
   written to tolerate a missing or renamed field rather than throw. */

function text(value) { return typeof value === 'string' ? value : ''; }
function firstText(...values) { return values.find((value) => text(value).trim()) || ''; }
function localized(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return firstText(value.english, value.en, value.value, value.text);
  return '';
}
function imageFrom(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return firstText(
      value.url, value.large, value.full, value.hero, value.image, value.publicPath, value.card, value.portrait,
      // deadlock-api v2 nests art under `images` with these names.
      value.icon_hero_card, value.hero_card_critical, value.top_bar_vertical_image, value.minimap_image
    );
  }
  return '';
}
/** Descriptions arrive as a plain string, a localized object, or {lore, role, playstyle}. */
function descriptionFrom(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return firstText(localized(value), value.role, value.playstyle, value.lore);
}
/**
 * Flatten every localized spelling of a hero's name into one searchable string.
 * deadlock.io ships 17 languages plus romanizations and community nicknames in
 * `searchName` ("infa-nasu", "火男"), which makes the search box work for players
 * who do not type the English name.
 */
function aliasesFrom(raw) {
  const parts = new Set();
  for (const field of [raw.searchName, raw.displayName, raw.name, raw.localized_name]) {
    if (typeof field === 'string') parts.add(field);
    else if (field && typeof field === 'object') {
      const values = field.byLanguage && typeof field.byLanguage === 'object' ? field.byLanguage : field;
      for (const value of Object.values(values)) if (typeof value === 'string') parts.add(value);
    }
  }
  return [...parts].join(' ').toLowerCase();
}
function absoluteImage(path, origin) {
  if (!path) return path;
  if (path.startsWith('//')) return `https:${path}`;
  try { return new URL(path, origin).href; } catch (_) { return path; }
}
/** Feeds return either a bare array, a wrapper object, or an id-keyed map. */
function unwrap(raw) {
  if (Array.isArray(raw)) return raw;
  for (const key of ['heroes', 'data', 'results', 'items']) if (Array.isArray(raw?.[key])) return raw[key];
  return Object.values(raw || {}).filter((value) => value && typeof value === 'object');
}
/** @returns {Hero | null} Null for entries that are not real heroes (dev placeholders, dota leftovers). */
function normalise(raw, index, origin) {
  const name = firstText(raw.name, raw.display_name, localized(raw.displayName), raw.localized_name, raw.hero_name, raw.internal_name, raw.id);
  if (!name || /^(hero_|npc_dota_hero)/i.test(name)) return null;
  // Newer heroes ship lore but no playstyle blurb, so lore is the last resort
  // rather than nothing — it is long, which is why .hero-description clamps.
  const description = firstText(descriptionFrom(raw.description), raw.summary, raw.short_description, raw.tagline, raw.role, localized(raw.playstyle), localized(raw.lore));
  const image = absoluteImage(
    imageFrom(raw.image) || imageFrom(raw.images) || imageFrom(raw.thumbnail) || imageFrom(raw.portrait) || imageFrom(raw.icon) || imageFrom(raw.assets?.card) || imageFrom(raw.assets?.portrait) || imageFrom(raw.assets?.image),
    origin
  );
  // Both feeds expose the engine class name ("hero_inferno" / "inferno"), so
  // stripping and lowercasing it yields the SAME id from either source. Ids are
  // the key for exclusions, the tally and share links, so keeping them stable
  // across a failover matters — do not swap this back to the numeric feed id.
  const idSource = firstText(raw.class_name, raw.codeName, raw.internal_name, String(raw.id ?? ''), String(raw.hero_id ?? ''), name);
  const id = idSource.replace(/^hero_/i, '').toLowerCase() || String(index);
  const rawStatus = String(raw.status ?? raw.release_status ?? raw.type ?? '').toLowerCase();
  const released = !(raw.is_unreleased || raw.unreleased || raw.disabled || raw.playable === false
    || raw.playerSelectable === false || raw.player_selectable === false || raw.inDevelopment || raw.in_development
    || raw.needs_testing || raw.prerelease_only || raw.limited_testing || raw.assigned_players_only
    || /unreleased|upcoming|test/.test(rawStatus));
  // These five are split across the feeds — deadlock-api has role/accent,
  // deadlock.io has the localized aliases — so enrichRoster() merges them.
  const complexity = Number.isFinite(Number(raw.complexity)) ? Number(raw.complexity) : 0;
  const role = firstText(raw.hero_type, raw.heroType, raw.role_name).toLowerCase();
  const weapon = firstText(localized(raw.gunArchetype), raw.gun_tag, raw.weapon_archetype);
  const accent = firstText(raw.colors?.style_hex, raw.colors?.ui_hex, raw.color);
  return {
    id,
    name: name.replace(/^hero_/i, '').replace(/_/g, ' '),
    description,
    image,
    released,
    complexity: complexity > 0 ? complexity : 0,
    role,
    weapon,
    accent: /^#[0-9a-f]{6}$/i.test(accent) ? accent : '',
    aliases: aliasesFrom(raw),
  };
}

/* ── Small DOM helpers ─────────────────────────────────────────────────── */

/** Escape a URL for use inside a CSS url("…") value. */
function cssUrl(url) { return `url("${url.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`; }

function sourceStatus(message, kind = '') {
  els.source.className = `source-status ${kind}`;
  els.source.lastElementChild.textContent = message;
}

let toastTimer;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add('visible'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('visible'), 2200);
}

/* Decode stage art off-screen and only swap it in once ready, so a reveal never
   flashes an empty frame. The token guards against a slow image from an earlier
   roll landing after a newer one. */
let artToken = 0;
function setStageArt(url) {
  const token = ++artToken;
  const clear = () => {
    els.art.style.backgroundImage = '';
    els.art.classList.add('is-empty'); // shows the placeholder glow
    els.art.style.opacity = '.1';
  };
  if (!url) { clear(); return; }
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    if (token !== artToken) return;
    els.art.classList.remove('is-empty');
    els.art.style.backgroundImage = cssUrl(url);
    els.art.style.opacity = '.55';
  };
  img.onerror = () => { if (token === artToken) clear(); };
  img.src = url;
}

/* ── Pool selection ────────────────────────────────────────────────────── */

function reconcileRestoredState() {
  state.byId = new Map(state.heroes.map((hero) => [hero.id, hero]));
  state.excluded = new Set([...state.excluded].filter((id) => state.byId.has(id)));
  state.recent = state.recent.filter(isHeroRecord).map((hero) => state.byId.get(hero.id)).filter(Boolean).slice(0, RECENT_LIMIT);
  state.squad = state.squad.map((hero) => state.byId.get(hero.id)).filter(Boolean);
}

/**
 * @param {{ignoreRecent?: boolean}} [options]
 * @returns {Hero[]} Heroes the next draw may pick from.
 */
function eligibleHeroes({ ignoreRecent = false } = {}) {
  const avoid = !ignoreRecent && els.recentToggle.checked ? new Set(state.recent.map((hero) => hero.id)) : new Set();
  const { complexity, roles } = state.filters;
  // A saved role filter outlives the data it depends on: roles only arrive from
  // the enrichment pass, so if that fails (offline, or the other feed is down)
  // no hero has one. Applying the filter then empties the pool — and the role
  // chips are hidden in that state, so there is no control left to clear it.
  const roleFilter = roles.size && hasRoleData() ? roles : null;
  return state.heroes.filter((hero) => (!els.releasedToggle.checked || hero.released)
    && !state.excluded.has(hero.id)
    && !avoid.has(hero.id)
    // An unrated hero is never filtered out by complexity.
    && (!hero.complexity || complexity.has(hero.complexity))
    && (!roleFilter || roleFilter.has(hero.role)));
}

/** True once any hero has a role, i.e. the enrichment pass found role data. */
function hasRoleData() {
  return state.heroes.some((hero) => hero.role);
}

/** The pool for a draw of `size`, relaxing the "avoid recent" rule only if it would starve the draw. */
function poolFor(size) {
  const strict = eligibleHeroes();
  return strict.length >= size ? strict : eligibleHeroes({ ignoreRecent: true });
}

function recordDraw(heroes) {
  for (const hero of heroes) state.tally[hero.id] = (state.tally[hero.id] || 0) + 1;
  state.pickCount += heroes.length;
  const drawnIds = new Set(heroes.map((hero) => hero.id));
  state.recent = [...heroes, ...state.recent.filter((hero) => !drawnIds.has(hero.id))].slice(0, RECENT_LIMIT);
}

/**
 * Make `heroes` the current draw.
 * @param {Hero[]} heroes
 * @param {{record?: boolean}} [options] record=false for draws restored from a share link.
 */
function commitDraw(heroes, { record = true } = {}) {
  if (!heroes.length) return;
  state.squad = heroes;
  state.featured = 0;
  state.shared = !record;
  if (record) recordDraw(heroes);
  updateStage();
  render();
  writeHash();
  if (record) saveState();
}

function roll() {
  if (!state.heroes.length) return;
  reseed();
  const pool = poolFor(state.squadSize);
  if (!pool.length) {
    state.squad = [];
    state.featured = 0;
    els.name.textContent = 'No hero left';
    els.name.classList.remove('rolling');
    els.description.textContent = 'Re-enable a hero or clear your exclusions to restore the pool.';
    els.description.title = '';
    els.exclude.disabled = true;
    els.share.disabled = true;
    render();
    return;
  }
  commitDraw(drawSquad(pool, state.squadSize));
}

/** Reroll a single squad slot, keeping the rest of the stack intact. */
function rerollSlot(index) {
  const current = state.squad[index];
  if (!current) return;
  reseed();
  const held = new Set(state.squad.filter((_, i) => i !== index).map((hero) => hero.id));
  let pool = poolFor(state.squad.length).filter((hero) => !held.has(hero.id) && hero.id !== current.id);
  if (!pool.length) pool = eligibleHeroes({ ignoreRecent: true }).filter((hero) => !held.has(hero.id));
  if (!pool.length) { toast('No other hero is eligible for that slot.'); return; }
  const [hero] = drawFrom(pool, 1);
  state.squad = state.squad.map((existing, i) => (i === index ? hero : existing));
  state.featured = index;
  state.shared = false;
  recordDraw([hero]);
  updateStage();
  render();
  writeHash();
  saveState();
}

/* ── Share links ───────────────────────────────────────────────────────── */

/* The hash carries the drawn hero ids rather than the seed: a seed only
   reproduces a draw against an identical pool, but ids are exact for everyone. */
function writeHash() {
  if (!state.squad.length) return;
  const value = state.squad.map((hero) => encodeURIComponent(hero.id)).join(',');
  history.replaceState(null, '', `${location.pathname}${location.search}#squad=${value}`);
}
/** @returns {Hero[]} Heroes named by a `#squad=` link, or an empty array. */
function readSharedDraw() {
  const raw = new URLSearchParams(location.hash.slice(1)).get('squad');
  if (!raw) return [];
  return raw.split(',').slice(0, MAX_SQUAD).map((id) => state.byId.get(decodeURIComponent(id))).filter(Boolean);
}
async function copyDrawLink() {
  writeHash();
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    toast('Draw link copied to clipboard.');
  } catch (_) {
    // Clipboard API needs a secure context; fall back to a throwaway selection.
    const field = document.createElement('textarea');
    field.value = url;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    const copied = document.execCommand?.('copy');
    field.remove();
    toast(copied ? 'Draw link copied to clipboard.' : 'Copy failed — the link is in your address bar.');
  }
}

/* ── Rendering ─────────────────────────────────────────────────────────── */

function updateStage() {
  const hero = state.squad[state.featured];
  if (!hero) return;
  els.name.textContent = hero.name;
  requestAnimationFrame(() => {
    // Force reflow so the animation restarts even if the name is unchanged.
    els.name.classList.remove('rolling');
    void els.name.offsetWidth;
    els.name.classList.add('rolling');
  });
  els.description.textContent = hero.description || 'No signals, no scripts — just commit to the draw and make it work.';
  els.description.title = hero.description || ''; // the copy is clamped to 3 lines
  // The stage ambience picks up the hero's own accent colour from the feed.
  els.stage.style.setProperty('--hero-accent', hero.accent || '');
  renderHeroTags(hero);

  const label = state.shared ? 'SHARED DRAW'
    : state.squad.length > 1 ? `SQUAD OF ${state.squad.length}  ·  DRAW ${String(state.pickCount).padStart(2, '0')}`
    : `PICK ${String(state.pickCount).padStart(2, '0')}`;
  els.number.textContent = `${label}  ·  ${state.source.toUpperCase()}`;
  setStageArt(hero.image);
  els.exclude.disabled = false;
  els.share.disabled = false;
}

const titleCase = (value) => value.charAt(0).toUpperCase() + value.slice(1);

/** Role / weapon / complexity, whichever of them the feeds actually supplied. */
function renderHeroTags(hero) {
  const tags = [hero.role && titleCase(hero.role), hero.weapon, hero.complexity && `Complexity ${hero.complexity}`].filter(Boolean);
  els.heroTags.hidden = !tags.length;
  els.heroTags.replaceChildren();
  for (const tag of tags) {
    els.heroTags.append(Object.assign(document.createElement('span'), { className: 'hero-tag', textContent: tag }));
  }
}

function renderSquadStrip() {
  const multi = state.squad.length > 1;
  els.squadStrip.hidden = !multi;
  if (!multi) { els.squadStrip.replaceChildren(); return; }
  const frag = document.createDocumentFragment();
  state.squad.forEach((hero, index) => {
    const slot = els.slotTemplate.content.firstElementChild.cloneNode(true);
    slot.classList.toggle('featured', index === state.featured);
    const main = slot.querySelector('.slot-main');
    const art = slot.querySelector('.slot-art');
    if (hero.image) art.style.backgroundImage = cssUrl(hero.image);
    slot.querySelector('.slot-index').textContent = String(index + 1).padStart(2, '0');
    slot.querySelector('.slot-name').textContent = hero.name;
    main.setAttribute('aria-pressed', index === state.featured ? 'true' : 'false');
    main.title = `Show ${hero.name}`;
    main.addEventListener('click', () => { state.featured = index; updateStage(); renderSquadStrip(); });
    const reroll = slot.querySelector('.slot-reroll');
    reroll.title = `Reroll slot ${index + 1}`;
    reroll.setAttribute('aria-label', `Reroll slot ${index + 1}, currently ${hero.name}`);
    reroll.addEventListener('click', () => rerollSlot(index));
    frag.append(slot);
  });
  els.squadStrip.replaceChildren(frag);
}

function renderRecent() {
  els.recent.replaceChildren();
  if (!state.recent.length) {
    els.recent.append(Object.assign(document.createElement('span'), { className: 'empty-copy', textContent: 'No picks yet. The city is waiting.' }));
    return;
  }
  for (const hero of state.recent) {
    els.recent.append(Object.assign(document.createElement('span'), { className: 'recent-chip', textContent: hero.name }));
  }
}

/* One measure, ranked — a single-hue bar per row, values labelled directly,
   text kept in the ink tokens so the bar alone carries the encoding. */
function renderTally() {
  els.tallyTotal.textContent = `${state.pickCount} draw${state.pickCount === 1 ? '' : 's'} recorded`;
  const rows = Object.entries(state.tally)
    .map(([id, count]) => ({ hero: state.byId.get(id), count }))
    .filter((row) => row.hero)
    .sort((a, b) => b.count - a.count || a.hero.name.localeCompare(b.hero.name))
    .slice(0, TALLY_ROWS);
  els.tallyList.replaceChildren();
  if (!rows.length) {
    els.tallyList.append(Object.assign(document.createElement('li'), { className: 'empty-copy', textContent: 'The oracle has no history yet.' }));
    return;
  }
  const max = rows[0].count;
  const frag = document.createDocumentFragment();
  for (const { hero, count } of rows) {
    const row = els.tallyTemplate.content.firstElementChild.cloneNode(true);
    row.title = `${hero.name}: drawn ${count}×`;
    row.querySelector('.tally-name').textContent = hero.name;
    row.querySelector('.tally-fill').style.width = `${Math.max(6, (count / max) * 100)}%`;
    row.querySelector('.tally-count').textContent = String(count);
    frag.append(row);
  }
  els.tallyList.append(frag);
}

/**
 * Create the grid's cards. Only call this when the roster itself changes; the
 * per-hero content is filled in by syncRosterState so that it stays current.
 */
function buildRoster() {
  cardIndex.clear();
  els.grid.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const hero of state.heroes) {
    const card = els.cardTemplate.content.firstElementChild.cloneNode(true);
    card.dataset.heroId = hero.id;
    cardIndex.set(hero.id, card);
    frag.append(card);
  }
  frag.append(emptyRoster);
  els.grid.append(frag);
}

/**
 * Repaint every card in place — no DOM construction.
 *
 * This owns the search index and the art too, not just the state classes: the
 * enrichment pass fills in `aliases` and any missing `image` *after* the grid is
 * built, and baking those in at build time meant they never reached the cards.
 */
function syncRosterState() {
  const recent = new Set(state.recent.map((hero) => hero.id));
  const drawn = new Set(state.squad.map((hero) => hero.id));
  for (const hero of state.heroes) {
    const card = cardIndex.get(hero.id);
    if (!card) continue;
    const excluded = state.excluded.has(hero.id);
    card.classList.toggle('excluded', excluded);
    card.classList.toggle('recent', recent.has(hero.id));
    card.classList.toggle('drawn', drawn.has(hero.id));
    card.setAttribute('aria-pressed', excluded ? 'true' : 'false');
    card.querySelector('.card-name').textContent = hero.name;
    card.querySelector('.card-state').textContent = excluded ? 'EXCLUDED' : drawn.has(hero.id) ? 'DRAWN' : recent.has(hero.id) ? 'RECENT' : !hero.released ? 'TEST' : '';
    card.title = excluded ? `Include ${hero.name}` : `Exclude ${hero.name}`;
    card.dataset.search = `${hero.name.toLowerCase()} ${hero.aliases}`;
    const art = /** @type {HTMLElement} */ (card.querySelector('.card-art'));
    const image = hero.image ? cssUrl(hero.image) : '';
    if (art.style.backgroundImage !== image) art.style.backgroundImage = image; // avoid needless repaints
  }
}

/** Filter the grid by the search box without rebuilding it. */
function applySearch() {
  const query = els.search.value.trim().toLowerCase();
  let visible = 0;
  for (const card of cardIndex.values()) {
    const match = !query || (card.dataset.search || '').includes(query);
    card.hidden = !match;
    if (match) visible++;
  }
  emptyRoster.hidden = visible > 0 || !state.heroes.length;
}

function syncSquadSizeControl() {
  for (const button of els.squadSize.children) {
    const active = Number(button.dataset.size) === state.squadSize;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  els.rollLabel.textContent = state.squadSize > 1 ? `DRAW SQUAD OF ${state.squadSize}` : 'PICK MY HERO';
}

/**
 * Role controls only appear once the enrichment pass has supplied roles, so the
 * UI never offers a filter that would silently empty the pool.
 */
function syncFilterControls() {
  for (const button of els.complexityFilter.children) {
    const active = state.filters.complexity.has(Number(button.dataset.value));
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  const roles = ROLE_ORDER.filter((role) => state.heroes.some((hero) => hero.role === role));
  const showRoles = roles.length > 1;
  els.roleRow.hidden = !showRoles;
  els.coverRolesRow.hidden = !showRoles || state.squadSize < 2;
  if (!showRoles) return;
  if (els.roleFilter.children.length !== roles.length) {
    els.roleFilter.replaceChildren(...roles.map((role) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.value = role;
      button.textContent = titleCase(role);
      return button;
    }));
  }
  for (const button of els.roleFilter.children) {
    const active = state.filters.roles.has(button.dataset.value);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  els.coverRolesToggle.checked = state.coverRoles;
}

/** Repaint every derived surface. Cheap enough to call after any state change. */
function render() {
  const available = eligibleHeroes();
  els.count.textContent = `${available.length} eligible`;
  els.rosterTitle.textContent = `${state.heroes.length} heroes detected`;
  els.roll.disabled = !state.heroes.length;
  syncSquadSizeControl();
  syncFilterControls();
  syncRosterState();
  applySearch();
  renderSquadStrip();
  renderRecent();
  renderTally();
}

/* ── Roster loading ────────────────────────────────────────────────────── */

/** Fetch JSON with a hard timeout so one dead provider cannot stall the app. */
async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fill in metadata the base feed did not carry, using the other sources.
 *
 * Neither feed is complete on its own: deadlock-api has `hero_type` and the
 * accent colour, deadlock.io has the 17-language names and search aliases. Ids
 * are derived from the engine class name so they match across both, which is
 * what makes this merge possible. Best-effort — a failure here costs a filter or
 * a colour, never the roster.
 * @param {string} baseSourceName The source that supplied the roster already loaded.
 * @param {Set<string>} [skip] Sources that just failed; no point asking again.
 */
async function enrichRoster(baseSourceName, skip = new Set()) {
  for (const source of SOURCES.filter((candidate) => candidate.name !== baseSourceName && !skip.has(candidate.name))) {
    try {
      const extras = new Map();
      for (const [index, entry] of unwrap(await fetchJson(source.url)).entries()) {
        const hero = normalise(entry, index, source.origin);
        if (hero) extras.set(hero.id, hero);
      }
      let changed = false;
      for (const hero of state.heroes) {
        const extra = extras.get(hero.id);
        if (!extra) continue;
        // Mutated in place so squad/recent/byId references all see the update.
        for (const field of ['role', 'weapon', 'accent', 'aliases', 'description', 'image']) {
          if (!hero[field] && extra[field]) { hero[field] = extra[field]; changed = true; }
        }
        if (!hero.complexity && extra.complexity) { hero.complexity = extra.complexity; changed = true; }
      }
      if (changed) {
        saveCachedRoster();
        render();
        updateStage();
      }
      return;
    } catch (_) { /* enrichment is optional – keep the base roster as-is */ }
  }
}

function adoptRoster(heroes, sourceName) {
  state.heroes = heroes;
  state.source = sourceName;
  reconcileRestoredState();
  buildRoster();
  render();
  // A shared link wins over a fresh roll so the recipient sees the sender's draw.
  const shared = readSharedDraw();
  if (shared.length) commitDraw(shared, { record: false });
  else roll();
}

async function getLiveHeroes() {
  if (state.fetching) return;
  state.fetching = true;
  els.refresh.disabled = true;
  els.roll.disabled = true;
  sourceStatus('Syncing live roster…');
  let lastError;
  const failed = new Set();
  try {
    for (const source of SOURCES) {
      try {
        const raw = await fetchJson(source.url);
        const seen = new Set();
        const heroes = unwrap(raw)
          .map((entry, index) => normalise(entry, index, source.origin))
          .filter(Boolean)
          .filter((hero) => !seen.has(hero.id) && seen.add(hero.id))
          .sort((a, b) => a.name.localeCompare(b.name));
        if (heroes.length < 5) throw new Error('The feed returned too few heroes');
        adoptRoster(heroes, source.name);
        saveCachedRoster();
        sourceStatus(`Live roster · ${source.name}`, 'live');
        // Deliberately not awaited: the first draw should not wait on metadata
        // that only enables filters and colour.
        void enrichRoster(source.name, failed);
        return;
      } catch (error) {
        lastError = error;
        failed.add(source.name);
      }
    }

    const cached = !state.heroes.length && loadCachedRoster();
    if (cached) {
      adoptRoster(cached.heroes, `${cached.source} (cached)`);
      sourceStatus(`Cached roster · ${cached.source}`, 'error');
      return;
    }
    if (state.heroes.length) {
      // A failed manual refresh keeps whatever roster is already on screen.
      sourceStatus('Refresh failed — keeping current roster', 'error');
      render();
    } else {
      sourceStatus('Live roster unavailable', 'error');
      els.name.textContent = 'Signal lost';
      els.description.textContent = 'The live data providers could not be reached. Check your connection, then refresh the roster.';
      els.number.textContent = 'OFFLINE';
      els.roll.disabled = true;
    }
    console.error('Could not load a hero feed:', lastError);
  } finally {
    state.fetching = false;
    els.refresh.disabled = false;
  }
}

/* ── Wiring ────────────────────────────────────────────────────────────── */

function buildSquadSizeControl() {
  const frag = document.createDocumentFragment();
  for (let size = 1; size <= MAX_SQUAD; size++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.size = String(size);
    button.textContent = String(size);
    button.setAttribute('aria-label', size === 1 ? 'Solo draw' : `Squad of ${size}`);
    frag.append(button);
  }
  els.squadSize.append(frag);

  const levels = document.createDocumentFragment();
  for (const level of COMPLEXITY_LEVELS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.value = String(level);
    button.textContent = String(level);
    button.setAttribute('aria-label', `Complexity ${level}`);
    levels.append(button);
  }
  els.complexityFilter.append(levels);
}

els.squadSize.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-size]');
  if (!button) return;
  state.squadSize = Number(button.dataset.size);
  render();
  saveState();
});

/** Toggle a chip, refusing to empty a filter set entirely (that would zero the pool). */
function toggleFilter(set, value, { allowEmpty = false } = {}) {
  if (set.has(value)) {
    if (!allowEmpty && set.size === 1) return toast('Keep at least one level selected.');
    set.delete(value);
  } else {
    set.add(value);
  }
  render();
  saveState();
}

els.complexityFilter.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-value]');
  if (button) toggleFilter(state.filters.complexity, Number(button.dataset.value));
});
els.roleFilter.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-value]');
  // Roles allow an empty set — that means "every role", not "none".
  if (button) toggleFilter(state.filters.roles, button.dataset.value, { allowEmpty: true });
});
els.coverRolesToggle.addEventListener('change', () => {
  state.coverRoles = els.coverRolesToggle.checked;
  saveState();
});

// One delegated listener for the whole grid instead of one per card.
els.grid.addEventListener('click', (event) => {
  const card = event.target.closest('.hero-card');
  if (!card) return;
  const id = card.dataset.heroId;
  if (state.excluded.has(id)) state.excluded.delete(id); else state.excluded.add(id);
  render();
  saveState();
});

els.roll.addEventListener('click', roll);
els.refresh.addEventListener('click', getLiveHeroes);
els.share.addEventListener('click', copyDrawLink);
els.exclude.addEventListener('click', () => {
  const hero = state.squad[state.featured];
  if (!hero) return;
  state.excluded.add(hero.id);
  if (state.squad.length > 1) rerollSlot(state.featured);
  else { render(); saveState(); roll(); }
});
els.recentToggle.addEventListener('change', () => { render(); saveState(); });
els.releasedToggle.addEventListener('change', () => { render(); saveState(); });
els.search.addEventListener('input', applySearch);
els.clear.addEventListener('click', () => { state.recent = []; render(); saveState(); });
els.clearTally.addEventListener('click', () => { state.tally = {}; state.pickCount = 0; render(); saveState(); });

// writeHash() uses replaceState, which does not fire this — so a hashchange is
// always the user's doing: pasting a share link into an already-open tab, or
// navigating back to one.
window.addEventListener('hashchange', () => {
  const shared = readSharedDraw();
  if (shared.length) commitDraw(shared, { record: false });
});

document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.ctrlKey || event.metaKey || event.altKey) return;
  // Space activates whatever control has focus; only hijack it when nothing interactive does.
  const active = /** @type {HTMLElement | null} */ (document.activeElement);
  if (active && (active.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(active.tagName))) return;
  event.preventDefault();
  roll();
});

loadState();
buildSquadSizeControl();
syncSquadSizeControl();
getLiveHeroes();
