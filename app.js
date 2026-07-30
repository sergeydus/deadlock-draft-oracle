const SOURCES = [
  { url: 'https://deadlock.io/api/v1/heroes.json', name: 'deadlock.io' },
  { url: 'https://assets.deadlock-api.com/v1/assets/heroes', name: 'deadlock-api.com' },
];
const RECENT_LIMIT = 5;
const state = { heroes: [], selected: null, excluded: new Set(), recent: [], source: '' };

const $ = (selector) => document.querySelector(selector);
const els = {
  name: $('#heroName'), description: $('#heroDescription'), number: $('#heroNumber'), art: $('#heroArt'),
  roll: $('#rollButton'), exclude: $('#excludePickedButton'), refresh: $('#refreshButton'), source: $('#sourceStatus'),
  count: $('#eligibleCount'), rosterTitle: $('#rosterTitle'), grid: $('#rosterGrid'), recent: $('#recentList'),
  recentToggle: $('#recentToggle'), releasedToggle: $('#releasedToggle'), search: $('#searchInput'), clear: $('#clearHistory'), template: $('#heroCardTemplate'),
};

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
  if (typeof value === 'object') return firstText(value.url, value.large, value.full, value.hero, value.image, value.publicPath);
  return '';
}
function absoluteImage(path) { return path && path.startsWith('/') ? `https://deadlock.io${path}` : path; }
function unwrap(raw) {
  if (Array.isArray(raw)) return raw;
  for (const key of ['heroes', 'data', 'results', 'items']) if (Array.isArray(raw?.[key])) return raw[key];
  return Object.values(raw || {}).filter((value) => value && typeof value === 'object');
}
function normalise(raw, index) {
  const name = firstText(raw.name, raw.display_name, localized(raw.displayName), raw.localized_name, raw.hero_name, raw.internal_name, raw.id);
  if (!name || /^(hero_|npc_dota_hero)/i.test(name)) return null;
  const description = firstText(raw.description, raw.summary, raw.short_description, raw.tagline, raw.role, localized(raw.playstyle));
  const image = absoluteImage(imageFrom(raw.image) || imageFrom(raw.images) || imageFrom(raw.thumbnail) || imageFrom(raw.portrait) || imageFrom(raw.icon) || imageFrom(raw.assets?.card) || imageFrom(raw.assets?.portrait) || imageFrom(raw.assets?.image));
  const id = String(raw.id ?? raw.hero_id ?? raw.internal_name ?? raw.name ?? index);
  const rawStatus = String(raw.status ?? raw.release_status ?? raw.type ?? '').toLowerCase();
  const released = !(raw.is_unreleased || raw.unreleased || raw.disabled || raw.playable === false || raw.playerSelectable === false || raw.inDevelopment || /unreleased|upcoming|test/.test(rawStatus));
  return { id, name: name.replace(/^hero_/i, '').replace(/_/g, ' '), description, image, released };
}
function sourceStatus(message, kind = '') {
  els.source.className = `source-status ${kind}`;
  els.source.lastElementChild.textContent = message;
}
function eligibleHeroes() {
  const avoidRecent = els.recentToggle.checked ? new Set(state.recent.map((hero) => hero.id)) : new Set();
  return state.heroes.filter((hero) => (!els.releasedToggle.checked || hero.released) && !state.excluded.has(hero.id) && !avoidRecent.has(hero.id));
}
function updatePickDisplay(hero) {
  if (!hero) return;
  state.selected = hero;
  els.name.textContent = hero.name;
  els.description.textContent = hero.description || 'No signals, no scripts — just commit to the draw and make it work.';
  els.number.textContent = `PICK ${String(state.recent.length + 1).padStart(2, '0')}  ·  ${state.source.toUpperCase()}`;
  els.art.style.backgroundImage = hero.image ? `url("${hero.image.replace(/"/g, '\\"')}")` : '';
  els.art.style.opacity = hero.image ? '.55' : '.1';
  els.exclude.disabled = false;
}
function roll() {
  let pool = eligibleHeroes();
  if (!pool.length && els.recentToggle.checked && state.heroes.length) {
    state.recent = [];
    pool = eligibleHeroes();
  }
  if (!pool.length) {
    els.name.textContent = 'No hero left';
    els.description.textContent = 'Re-enable a hero or clear your exclusions to restore the pool.';
    return;
  }
  const hero = pool[Math.floor(Math.random() * pool.length)];
  state.recent = [hero, ...state.recent.filter((item) => item.id !== hero.id)].slice(0, RECENT_LIMIT);
  updatePickDisplay(hero);
  render();
}
function renderRecent() {
  els.recent.replaceChildren();
  if (!state.recent.length) { els.recent.innerHTML = '<span class="empty-copy">No picks yet. The city is waiting.</span>'; return; }
  state.recent.forEach((hero) => { const chip = document.createElement('span'); chip.className = 'recent-chip'; chip.textContent = hero.name; els.recent.append(chip); });
}
function renderRoster() {
  const query = els.search.value.trim().toLowerCase();
  const recent = new Set(state.recent.map((hero) => hero.id));
  const heroes = state.heroes.filter((hero) => hero.name.toLowerCase().includes(query));
  els.grid.replaceChildren();
  if (!heroes.length) { els.grid.innerHTML = '<p class="empty-roster">No hero matches that signal.</p>'; return; }
  heroes.forEach((hero) => {
    const card = els.template.content.firstElementChild.cloneNode(true);
    const excluded = state.excluded.has(hero.id);
    card.classList.toggle('excluded', excluded); card.classList.toggle('recent', recent.has(hero.id));
    card.querySelector('.card-name').textContent = hero.name;
    card.querySelector('.card-state').textContent = excluded ? 'EXCLUDED' : recent.has(hero.id) ? 'RECENT' : !hero.released ? 'TEST' : '';
    const art = card.querySelector('.card-art'); if (hero.image) art.style.backgroundImage = `url("${hero.image.replace(/"/g, '\\"')}")`;
    card.title = excluded ? `Include ${hero.name}` : `Exclude ${hero.name}`;
    card.addEventListener('click', () => { excluded ? state.excluded.delete(hero.id) : state.excluded.add(hero.id); render(); });
    els.grid.append(card);
  });
}
function render() {
  const available = eligibleHeroes();
  els.count.textContent = `${available.length} eligible`;
  els.rosterTitle.textContent = `${state.heroes.length} heroes detected`;
  els.roll.disabled = !available.length && !state.heroes.length;
  renderRecent(); renderRoster();
}
async function getLiveHeroes() {
  sourceStatus('Syncing live roster…'); els.roll.disabled = true;
  let lastError;
  for (const source of SOURCES) {
    try {
      const response = await fetch(source.url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const raw = await response.json();
      const seen = new Set();
      const heroes = unwrap(raw).map(normalise).filter(Boolean).filter((hero) => !seen.has(hero.id) && seen.add(hero.id)).sort((a, b) => a.name.localeCompare(b.name));
      if (heroes.length < 5) throw new Error('The feed returned too few heroes');
      state.heroes = heroes; state.source = source.name;
      sourceStatus(`Live roster · ${source.name}`, 'live'); render(); roll();
      return;
    } catch (error) { lastError = error; }
  }
  sourceStatus('Live roster unavailable', 'error');
  els.name.textContent = 'Signal lost';
  els.description.textContent = 'The live data providers could not be reached. Check your connection, then refresh the roster.';
  els.number.textContent = 'OFFLINE';
  els.roll.disabled = true;
  console.error('Could not load a hero feed:', lastError);
}
els.roll.addEventListener('click', roll);
els.refresh.addEventListener('click', getLiveHeroes);
els.exclude.addEventListener('click', () => { if (state.selected) { state.excluded.add(state.selected.id); roll(); render(); } });
els.recentToggle.addEventListener('change', render);
els.releasedToggle.addEventListener('change', render);
els.search.addEventListener('input', renderRoster);
els.clear.addEventListener('click', () => { state.recent = []; render(); });
document.addEventListener('keydown', (event) => { if (event.code === 'Space' && document.activeElement?.tagName !== 'INPUT') { event.preventDefault(); roll(); } });
getLiveHeroes();
