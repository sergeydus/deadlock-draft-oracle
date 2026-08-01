import { observer } from 'mobx-react-lite';
import { store } from '../store/OracleStore.ts';
import { COMPLEXITY_LEVELS, MAX_SQUAD } from '../constants.ts';
import { titleCase } from '../lib/css.ts';
import { ChipGroup, FilterRow, ToggleRow } from './Controls.tsx';

const RecentList = observer(function RecentList() {
  return (
    <div className="recent-wrap">
      <div className="micro-heading">
        <span>RECENTLY DRAWN</span>
        <button type="button" onClick={store.clearRecent}>Clear</button>
      </div>
      <div className="recent-list">
        {store.recent.length
          ? store.recent.map((hero) => <span className="recent-chip" key={hero.id}>{hero.name}</span>)
          : <span className="empty-copy">No picks yet. The city is waiting.</span>}
      </div>
    </div>
  );
});

/**
 * One measure, ranked — a single-hue bar per row against a recessive track,
 * values labelled directly, all text in the ink tokens so the bar alone carries
 * the encoding.
 */
const DrawLog = observer(function DrawLog() {
  const rows = store.tallyRows;
  const max = rows[0]?.count ?? 1;
  return (
    <div className="tally-wrap">
      <div className="micro-heading">
        <span>DRAW LOG</span>
        <button type="button" onClick={store.clearTally}>Reset</button>
      </div>
      <p className="tally-total">
        {store.pickCount} draw{store.pickCount === 1 ? '' : 's'} recorded
      </p>
      <ol className="tally-list">
        {rows.length
          ? rows.map(({ hero, count }) => (
            <li className="tally-row" key={hero.id} title={`${hero.name}: drawn ${count}×`}>
              <span className="tally-name">{hero.name}</span>
              <span className="tally-track">
                <span className="tally-fill" style={{ width: `${Math.max(6, (count / max) * 100)}%` }} />
              </span>
              <span className="tally-count">{count}</span>
            </li>
          ))
          : <li className="empty-copy">The oracle has no history yet.</li>}
      </ol>
    </div>
  );
});

export const SettingsPanel = observer(function SettingsPanel() {
  return (
    <div className="settings-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">DRAFT SETTINGS</p>
          <h2>Shape the chaos</h2>
        </div>
        <span className="eligible-count">{store.eligible.length} eligible</span>
      </div>

      <ToggleRow
        title="Avoid recent picks"
        hint="Keep the last 5 choices out of the pool."
        checked={store.avoidRecent}
        onChange={store.setAvoidRecent}
      />
      <ToggleRow
        title="Released heroes only"
        hint="Leave unreleased and test characters out."
        checked={store.releasedOnly}
        onChange={store.setReleasedOnly}
      />

      <FilterRow title="Squad size" hint="Draw a whole stack at once — never a duplicate.">
        <ChipGroup
          label="Squad size"
          onToggle={(value) => store.setSquadSize(Number(value))}
          chips={Array.from({ length: MAX_SQUAD }, (_, index) => {
            const size = index + 1;
            return {
              value: String(size),
              label: String(size),
              ariaLabel: size === 1 ? 'Solo draw' : `Squad of ${size}`,
              active: size === store.squadSize,
            };
          })}
        />
      </FilterRow>

      <FilterRow title="Complexity" hint="The game’s own 1–4 rating for mechanical load.">
        <ChipGroup
          label="Complexity"
          onToggle={(value) => store.toggleComplexity(Number(value))}
          chips={COMPLEXITY_LEVELS.map((level) => ({
            value: String(level),
            label: String(level),
            ariaLabel: `Complexity ${level}`,
            active: store.complexity.has(level),
          }))}
        />
      </FilterRow>

      {/* Role controls appear only once enrichment supplied roles, so the filter
          can never silently empty the pool. */}
      {store.showRoleControls && (
        <>
          <FilterRow title="Role" hint="All off means every role is allowed.">
            <ChipGroup
              label="Role"
              onToggle={store.toggleRole}
              chips={store.availableRoles.map((role) => ({
                value: role,
                label: titleCase(role),
                active: store.roles.has(role),
              }))}
            />
          </FilterRow>
          {store.squadSize > 1 && (
            <ToggleRow
              title="Cover every role"
              hint="Squad draws take one of each role before filling up."
              checked={store.coverRoles}
              onChange={store.setCoverRoles}
            />
          )}
        </>
      )}

      <RecentList />
      <DrawLog />

      <p className="source-note">
        Roster comes from the community’s live game-data feeds.{' '}
        <a href="https://deadlock.io/api/v1/heroes.json" target="_blank" rel="noreferrer">View source ↗</a>
      </p>
    </div>
  );
});
