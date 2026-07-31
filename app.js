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
 */

const SOURCES = [
  { url: 'https://deadlock.io/api/v1/heroes.json', name: 'deadlock.io', origin: 'https://deadlock.io' },
  { url: 'https://assets.deadlock-api.com/v2/heroes', name: 'deadlock-api.com', origin: 'https://assets.deadlock-api.com' },
];
const RECENT_LIMIT = 5;
const MAX_SQUAD = 6; // Deadlock is 6v6, so a full stack is six heroes.
const TALLY_ROWS = 6;
const FETCH_TIMEOUT_MS = 8000;
const STORAGE_KEY = 'draftOracle_v1';
const ROSTER_KEY = `${STORAGE_KEY}_roster`;

/**
 * Single source of truth. Everything on screen is derived from this by render().
 * @type {{heroes: Hero[], byId: Map<string, Hero>, squad: Hero[], featured: number,
 *         squadSize: number, excluded: Set<string>, recent: Hero[],
 *         tally: Record<string, number>, pickCount: number, source: string,
 *         fetching: boolean, seed: number, shared: boolean}}
 */
const state = {
  heroes: [],
  byId: new Map(),
  squad: [],        // The current draw. Length 1 for a solo pick, up to MAX_SQUAD for a stack.
  featured: 0,      // Index into squad shown large on the stage.
  squadSize: 1,
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
 * Draw `count` distinct heroes from `pool`.
 * @param {Hero[]} pool
 * @param {number} count
 * @returns {Hero[]} Up to `count` heroes; fewer if the pool is too small.
 */
function drawFrom(pool, count) {
  const bag = [...pool];
  const drawn = [];
  while (drawn.length < count && bag.length) drawn.push(...bag.splice(Math.floor(rng() * bag.length), 1));
  return drawn;
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
/** Runtime shape guard — cached/restored data may predate the current schema. */
function isHeroRecord(hero) {
  return hero !== null
    && typeof hero === 'object'
    && typeof hero.id === 'string'
    && hero.id.length > 0
    && typeof hero.name === 'string'
    && hero.name.trim().length > 0
    && typeof hero.description === 'string'
    && typeof hero.image === 'string'
    && typeof hero.released === 'boolean';
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
  return { id, name: name.replace(/^hero_/i, '').replace(/_/g, ' '), description, image, released };
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
  const clear = () => { els.art.style.backgroundImage = ''; els.art.style.opacity = '.1'; };
  if (!url) { clear(); return; }
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    if (token !== artToken) return;
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
  return state.heroes.filter((hero) => (!els.releasedToggle.checked || hero.released) && !state.excluded.has(hero.id) && !avoid.has(hero.id));
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
  commitDraw(drawFrom(pool, state.squadSize));
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

  const label = state.shared ? 'SHARED DRAW'
    : state.squad.length > 1 ? `SQUAD OF ${state.squad.length}  ·  DRAW ${String(state.pickCount).padStart(2, '0')}`
    : `PICK ${String(state.pickCount).padStart(2, '0')}`;
  els.number.textContent = `${label}  ·  ${state.source.toUpperCase()}`;
  setStageArt(hero.image);
  els.exclude.disabled = false;
  els.share.disabled = false;
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

/** Rebuild the roster grid. Only call this when the roster itself changes. */
function buildRoster() {
  cardIndex.clear();
  els.grid.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const hero of state.heroes) {
    const card = els.cardTemplate.content.firstElementChild.cloneNode(true);
    card.dataset.heroId = hero.id;
    card.dataset.search = hero.name.toLowerCase();
    if (hero.image) card.querySelector('.card-art').style.backgroundImage = cssUrl(hero.image);
    card.querySelector('.card-name').textContent = hero.name;
    cardIndex.set(hero.id, card);
    frag.append(card);
  }
  frag.append(emptyRoster);
  els.grid.append(frag);
}

/** Repaint card classes/labels in place — no DOM construction. */
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
    card.querySelector('.card-state').textContent = excluded ? 'EXCLUDED' : drawn.has(hero.id) ? 'DRAWN' : recent.has(hero.id) ? 'RECENT' : !hero.released ? 'TEST' : '';
    card.title = excluded ? `Include ${hero.name}` : `Exclude ${hero.name}`;
  }
}

/** Filter the grid by the search box without rebuilding it. */
function applySearch() {
  const query = els.search.value.trim().toLowerCase();
  let visible = 0;
  for (const card of cardIndex.values()) {
    const match = !query || card.dataset.search.includes(query);
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

/** Repaint every derived surface. Cheap enough to call after any state change. */
function render() {
  const available = eligibleHeroes();
  els.count.textContent = `${available.length} eligible`;
  els.rosterTitle.textContent = `${state.heroes.length} heroes detected`;
  els.roll.disabled = !state.heroes.length;
  syncSquadSizeControl();
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
        return;
      } catch (error) {
        lastError = error;
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
}

els.squadSize.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-size]');
  if (!button) return;
  state.squadSize = Number(button.dataset.size);
  render();
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
