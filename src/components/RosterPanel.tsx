import { observer } from 'mobx-react-lite';
import { store } from '../store/OracleStore.ts';
import { classes, cssUrl } from '../lib/css.ts';
import type { Hero } from '../types.ts';

const HeroCard = observer(function HeroCard({ hero }: { hero: Hero }) {
  const excluded = store.excluded.has(hero.id);
  const drawn = store.squad.some((member) => member.id === hero.id);
  const recent = store.recent.some((member) => member.id === hero.id);
  const label = excluded ? 'EXCLUDED' : drawn ? 'DRAWN' : recent ? 'RECENT' : !hero.released ? 'TEST' : '';

  return (
    <button
      type="button"
      className={classes('hero-card', excluded && 'excluded', recent && 'recent', drawn && 'drawn')}
      aria-pressed={excluded}
      title={excluded ? `Include ${hero.name}` : `Exclude ${hero.name}`}
      onClick={() => store.toggleExcluded(hero.id)}
    >
      <span className="card-art" style={hero.image ? { backgroundImage: cssUrl(hero.image) } : undefined} />
      <span className="card-name">{hero.name}</span>
      <span className="card-state">{label}</span>
    </button>
  );
});

export const RosterPanel = observer(function RosterPanel() {
  const heroes = store.visibleRoster;

  return (
    <div className="roster-panel">
      <div className="section-heading roster-heading">
        <div>
          <p className="eyebrow">LIVE HERO ROSTER</p>
          <h2>{store.heroes.length} heroes detected</h2>
        </div>
        <div className="search-box">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            placeholder="Search heroes"
            aria-label="Search heroes"
            value={store.search}
            onChange={(event) => store.setSearch(event.target.value)}
          />
        </div>
      </div>
      {/* Not aria-live: this holds every hero card, and each keystroke in the
          search box re-renders the lot, so marking it live made typing read out
          batches of cards. The count below says the useful part instead. */}
      <div className="roster-grid">
        {heroes.map((hero) => <HeroCard hero={hero} key={hero.id} />)}
        {!heroes.length && store.heroes.length > 0 && (
          <p className="empty-roster">No hero matches that signal.</p>
        )}
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">{store.rosterAnnouncement}</p>
    </div>
  );
});
