import { makeAutoObservable, runInAction } from 'mobx';
import { COMPLEXITY_LEVELS, RECENT_LIMIT, ROLE_ORDER, SOURCES, TALLY_ROWS } from '../constants.ts';
import { drawFrom, drawSquad, mulberry32, randomSeed, type Rng } from '../lib/random.ts';
import { eligibleHeroes, hasRoleData, poolFor, type PoolCriteria } from '../lib/pool.ts';
import { fetchEnrichment, fetchRoster, mergeInto } from '../lib/roster.ts';
import { clearHash, copyToClipboard, isOwnHash, readSharedDraw, writeHash } from '../lib/share.ts';
import { loadCachedRoster, loadState, saveCachedRoster, saveState } from '../lib/storage.ts';
import type { Hero, RecentPick, StatusKind } from '../types.ts';

/** What the stage should be showing. */
export type StageMode = 'loading' | 'draw' | 'empty' | 'offline';

/**
 * The whole application state.
 *
 * Everything the UI shows is either a field here or a computed derived from
 * one, and observers re-render themselves — there is no repaint step to forget.
 * That is deliberate: the pre-React version kept a hand-written `render()` plus
 * twelve sync functions, and its recurring bug was a surface that stopped being
 * refreshed (enrichment data never reaching the roster cards, for instance).
 */
export class OracleStore {
  heroes: Hero[] = [];
  /** The current draw. Length 1 for a solo pick, up to MAX_SQUAD for a stack. */
  squad: Hero[] = [];
  /** Index into `squad` shown large on the stage. */
  featured = 0;
  squadSize = 1;
  /** Squad draws take one of each role before filling the rest. */
  coverRoles = false;
  complexity = new Set<number>(COMPLEXITY_LEVELS);
  /** Empty means "every role", not "none". */
  roles = new Set<string>();
  excluded = new Set<string>();
  /** Just id and name — see RecentPick. */
  recent: RecentPick[] = [];
  /** heroId -> times drawn, lifetime. */
  tally: Record<string, number> = {};
  /** Lifetime draws, including every member of a squad draw. */
  pickCount = 0;
  avoidRecent = true;
  releasedOnly = true;
  search = '';
  source = '';
  fetching = false;
  statusMessage = 'Connecting to live roster…';
  statusKind: StatusKind = '';
  /** True when the current draw came from a #squad= link rather than a roll. */
  shared = false;
  seed = 0;
  mode: StageMode = 'loading';
  /** Bumped on every draw. The stage keys its heading on this so the reveal
      animation restarts even when the same hero comes up twice. */
  drawId = 0;
  toastMessage = '';
  toastVisible = false;

  private rng: Rng = mulberry32(1);
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // The type argument lets the overrides name private fields; both are plain
    // mutable state that nothing should react to.
    makeAutoObservable<OracleStore, 'rng' | 'toastTimer'>(this, { rng: false, toastTimer: false }, { autoBind: true });
    this.restore();
  }

  /* ── Derived ── */

  get byId(): Map<string, Hero> {
    return new Map(this.heroes.map((hero) => [hero.id, hero]));
  }

  private get criteria(): PoolCriteria {
    return {
      heroes: this.heroes,
      excluded: this.excluded,
      recent: this.recent,
      complexity: this.complexity,
      roles: this.roles,
      avoidRecent: this.avoidRecent,
      releasedOnly: this.releasedOnly,
    };
  }

  get eligible(): Hero[] {
    return eligibleHeroes(this.criteria);
  }

  get hasRoleData(): boolean {
    return hasRoleData(this.heroes);
  }

  /** Roles actually present in the roster, in canonical order. */
  get availableRoles(): string[] {
    return ROLE_ORDER.filter((role) => this.heroes.some((hero) => hero.role === role));
  }

  /** Role controls only appear once enrichment supplied roles, so the UI never
      offers a filter that would silently empty the pool. */
  get showRoleControls(): boolean {
    return this.availableRoles.length > 1;
  }

  get featuredHero(): Hero | null {
    return this.squad[this.featured] ?? null;
  }

  get visibleRoster(): Hero[] {
    const query = this.search.trim().toLowerCase();
    if (!query) return this.heroes;
    return this.heroes.filter((hero) => `${hero.name.toLowerCase()} ${hero.aliases}`.includes(query));
  }

  get tallyRows(): { hero: Hero; count: number }[] {
    const byId = this.byId;
    return Object.entries(this.tally)
      .map(([id, count]) => ({ hero: byId.get(id), count }))
      .filter((row): row is { hero: Hero; count: number } => row.hero !== undefined)
      .sort((a, b) => b.count - a.count || a.hero.name.localeCompare(b.hero.name))
      .slice(0, TALLY_ROWS);
  }

  get stageLabel(): string {
    const label = this.shared ? 'SHARED DRAW'
      : this.squad.length > 1 ? `SQUAD OF ${this.squad.length}  ·  DRAW ${String(this.pickCount).padStart(2, '0')}`
        : `PICK ${String(this.pickCount).padStart(2, '0')}`;
    return `${label}  ·  ${this.source.toUpperCase()}`;
  }

  /**
   * One short sentence for assistive tech.
   *
   * The stage announces nothing on its own: the <h1> is not a live region, and
   * the roster grid used to be one, so a draw either went unannounced or was
   * buried under thirty re-rendered cards. This is the single thing worth
   * saying, said once.
   *
   * The pick number is included so that drawing the same hero twice still
   * changes the text — a live region that repeats itself announces nothing.
   */
  get announcement(): string {
    switch (this.mode) {
      case 'loading': return '';
      case 'offline': return 'Live roster unavailable. Check your connection, then refresh the roster.';
      case 'empty': return 'No hero is eligible. Re-enable a hero or clear your exclusions.';
      default: {
        if (!this.squad.length) return '';
        const names = this.squad.map((hero) => hero.name).join(', ');
        if (this.shared) return `Shared draw: ${names}.`;
        return this.squad.length > 1
          ? `Draw ${this.pickCount}: ${names}.`
          : `Pick ${this.pickCount}: ${names}.`;
      }
    }
  }

  /** How many heroes the search box is currently showing, for the same purpose. */
  get rosterAnnouncement(): string {
    if (!this.heroes.length) return '';
    if (!this.search.trim()) return `${this.heroes.length} heroes.`;
    const matches = this.visibleRoster.length;
    return matches === 1 ? '1 hero matches.' : `${matches} heroes match.`;
  }

  get rollLabel(): string {
    return this.squadSize > 1 ? `DRAW SQUAD OF ${this.squadSize}` : 'PICK MY HERO';
  }

  /* ── Persistence ── */

  private restore(): void {
    const saved = loadState();
    if (saved.excluded) this.excluded = new Set(saved.excluded);
    if (saved.recent) this.recent = saved.recent;
    if (saved.tally) this.tally = saved.tally;
    if (saved.pickCount !== undefined) this.pickCount = saved.pickCount;
    if (saved.squadSize !== undefined) this.squadSize = saved.squadSize;
    if (saved.coverRoles !== undefined) this.coverRoles = saved.coverRoles;
    if (saved.complexity?.length) this.complexity = new Set(saved.complexity);
    if (saved.roles) this.roles = new Set(saved.roles);
    if (saved.avoidRecent !== undefined) this.avoidRecent = saved.avoidRecent;
    if (saved.releasedOnly !== undefined) this.releasedOnly = saved.releasedOnly;
  }

  private persist(): void {
    saveState({
      excluded: [...this.excluded],
      recent: [...this.recent],
      tally: { ...this.tally },
      pickCount: this.pickCount,
      squadSize: this.squadSize,
      coverRoles: this.coverRoles,
      complexity: [...this.complexity],
      roles: [...this.roles],
      avoidRecent: this.avoidRecent,
      releasedOnly: this.releasedOnly,
    });
  }

  /* ── Roster loading ── */

  /**
   * Show the cached roster straight away, before the network is consulted.
   *
   * Runs synchronously, ahead of the first await in `load()`, so the app is
   * usable on the same tick. It used to be the last resort instead: the cache
   * was only read once every source had exhausted its timeout, which left a
   * returning visitor watching "Loading" for up to SOURCES.length ×
   * FETCH_TIMEOUT_MS — measured at 16s — with a complete roster sitting in
   * localStorage the whole time.
   *
   * @returns the cached source's name, or null when there was nothing to show.
   */
  private primeFromCache(): string | null {
    const cached = loadCachedRoster();
    if (!cached) return null;
    this.adoptRoster(cached.heroes, `${cached.source} (cached)`);
    return cached.source;
  }

  async load(): Promise<void> {
    if (this.fetching) return;
    this.fetching = true;
    // Only onto an empty screen: a manual refresh must not replace the roster
    // already displayed with an older cached copy of it.
    const primed = this.heroes.length ? null : this.primeFromCache();
    this.setStatus(primed ? 'Cached roster — checking for updates…' : 'Syncing live roster…');
    const failed = new Set<string>();
    let lastError: unknown;
    try {
      for (const source of SOURCES) {
        try {
          const heroes = await fetchRoster(source);
          runInAction(() => {
            // adoptRoster keeps the pick already on screen, so replacing a
            // primed roster with the live one does not re-roll under the user.
            this.adoptRoster(heroes, source.name);
            this.setStatus(`Live roster · ${source.name}`, 'live');
          });
          saveCachedRoster({ heroes, source: source.name });
          // Deliberately not awaited: the first draw should not wait on metadata
          // that only enables filters and colour.
          void this.enrich(source.name, failed);
          return;
        } catch (error) {
          lastError = error;
          failed.add(source.name);
        }
      }

      runInAction(() => {
        if (primed) {
          // Already on screen — say that it is all we have.
          this.setStatus(`Cached roster · ${primed}`, 'error');
        } else if (this.heroes.length) {
          // A failed manual refresh keeps whatever roster is already on screen.
          this.setStatus('Refresh failed — keeping current roster', 'error');
        } else {
          this.setStatus('Live roster unavailable', 'error');
          this.mode = 'offline';
        }
      });
      if (!primed) console.error('Could not load a hero feed:', lastError);
    } finally {
      runInAction(() => { this.fetching = false; });
    }
  }

  private async enrich(baseSourceName: string, failed: ReadonlySet<string>): Promise<void> {
    const extras = await fetchEnrichment(baseSourceName, failed);
    if (!extras) return;
    // The merge mutates observable heroes, so it has to run inside an action —
    // the code after an await is no longer in the enclosing one.
    runInAction(() => {
      if (mergeInto(this.heroes, extras)) saveCachedRoster({ heroes: this.heroes, source: this.source });
    });
  }

  private adoptRoster(heroes: Hero[], sourceName: string): void {
    this.heroes = heroes;
    this.source = sourceName;
    // Restored ids may name heroes the roster no longer has.
    const byId = this.byId;
    this.excluded = new Set([...this.excluded].filter((id) => byId.has(id)));
    this.recent = this.recent.filter((pick) => byId.has(pick.id)).slice(0, RECENT_LIMIT);
    this.squad = this.squad.map((hero) => byId.get(hero.id)).filter((hero): hero is Hero => hero !== undefined);

    // A shared link wins over a fresh roll so the recipient sees the sender's draw.
    // Every roll writes the hash as well, so the marker is what separates a link
    // somebody sent from the one this tab left in its own address bar; without
    // that test a reload relabels your own pick as SHARED DRAW, suppresses the
    // opening draw, and can resurrect a hero you have since excluded.
    const shared = readSharedDraw(byId);
    if (shared.length && !isOwnHash()) this.commitDraw(shared, false);
    // A manual refresh keeps the pick already on screen; only a cold start rolls.
    else if (!this.squad.length) this.roll();
  }

  private setStatus(message: string, kind: StatusKind = ''): void {
    this.statusMessage = message;
    this.statusKind = kind;
  }

  /* ── Drawing ── */

  private reseed(): void {
    this.seed = randomSeed() >>> 0;
    this.rng = mulberry32(this.seed);
  }

  private recordDraw(heroes: Hero[]): void {
    for (const hero of heroes) this.tally[hero.id] = (this.tally[hero.id] || 0) + 1;
    this.pickCount += heroes.length;
    const drawn = new Set(heroes.map((hero) => hero.id));
    const picks = heroes.map(({ id, name }) => ({ id, name }));
    this.recent = [...picks, ...this.recent.filter((pick) => !drawn.has(pick.id))].slice(0, RECENT_LIMIT);
  }

  /** @param record false for draws restored from a share link. */
  commitDraw(heroes: Hero[], record = true): void {
    if (!heroes.length) return;
    this.squad = heroes;
    this.featured = 0;
    this.shared = !record;
    this.mode = 'draw';
    this.drawId++;
    if (record) {
      this.recordDraw(heroes);
      this.persist();
      // Only a draw this tab produced writes the hash. Restoring one leaves the
      // address bar exactly as it arrived: the hash is already correct, and
      // stamping the marker on it would make this tab its author, so a reload
      // would show a fresh roll instead of the draw somebody sent.
      writeHash(heroes);
    }
  }

  roll(): void {
    if (!this.heroes.length) return;
    this.reseed();
    const pool = poolFor(this.squadSize, this.criteria);
    if (!pool.length) {
      this.squad = [];
      this.featured = 0;
      this.mode = 'empty';
      // Otherwise the URL still names the old draw, and reloading restores it —
      // excluded heroes included.
      clearHash();
      return;
    }
    this.commitDraw(drawSquad(pool, this.squadSize, { coverRoles: this.coverRoles, rng: this.rng }));
  }

  /** Reroll a single squad slot, keeping the rest of the stack intact. */
  rerollSlot(index: number): void {
    const current = this.squad[index];
    if (!current) return;
    this.reseed();
    const held = new Set(this.squad.filter((_, i) => i !== index).map((hero) => hero.id));
    let pool = poolFor(this.squad.length, this.criteria).filter((hero) => !held.has(hero.id) && hero.id !== current.id);
    if (!pool.length) pool = eligibleHeroes({ ...this.criteria, ignoreRecent: true }).filter((hero) => !held.has(hero.id));
    if (!pool.length) { this.showToast('No other hero is eligible for that slot.'); return; }
    const [hero] = drawFrom(pool, 1, this.rng);
    this.squad = this.squad.map((existing, i) => (i === index ? hero : existing));
    this.featured = index;
    this.shared = false;
    this.drawId++;
    this.recordDraw([hero]);
    this.persist();
    writeHash(this.squad);
  }

  applySharedFromHash(): void {
    if (isOwnHash()) return;
    const shared = readSharedDraw(this.byId);
    if (shared.length) this.commitDraw(shared, false);
  }

  /* ── User actions ── */

  feature(index: number): void { this.featured = index; }

  excludeFeatured(): void {
    const hero = this.featuredHero;
    if (!hero) return;
    this.excluded.add(hero.id);
    this.persist();
    if (this.squad.length > 1) this.rerollSlot(this.featured);
    else this.roll();
  }

  toggleExcluded(id: string): void {
    if (this.excluded.has(id)) this.excluded.delete(id);
    else this.excluded.add(id);
    this.persist();
  }

  setSquadSize(size: number): void { this.squadSize = size; this.persist(); }
  setCoverRoles(value: boolean): void { this.coverRoles = value; this.persist(); }
  setAvoidRecent(value: boolean): void { this.avoidRecent = value; this.persist(); }
  setReleasedOnly(value: boolean): void { this.releasedOnly = value; this.persist(); }
  setSearch(value: string): void { this.search = value; }

  toggleComplexity(level: number): void {
    if (this.complexity.has(level)) {
      // Emptying it entirely would zero the pool.
      if (this.complexity.size === 1) { this.showToast('Keep at least one level selected.'); return; }
      this.complexity.delete(level);
    } else this.complexity.add(level);
    this.persist();
  }

  toggleRole(role: string): void {
    if (this.roles.has(role)) this.roles.delete(role);
    else this.roles.add(role);
    this.persist();
  }

  clearRecent(): void { this.recent = []; this.persist(); }
  clearTally(): void { this.tally = {}; this.pickCount = 0; this.persist(); }

  async copyLink(): Promise<void> {
    // Same rule: a received draw already carries the sender's hash, and marking
    // it here would quietly turn a shared link into this tab's own.
    if (!this.shared) writeHash(this.squad);
    const copied = await copyToClipboard(location.href);
    runInAction(() => {
      this.showToast(copied ? 'Draw link copied to clipboard.' : 'Copy failed — the link is in your address bar.');
    });
  }

  showToast(message: string): void {
    this.toastMessage = message;
    this.toastVisible = true;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => runInAction(() => { this.toastVisible = false; }), 2200);
  }
}

export const store = new OracleStore();
