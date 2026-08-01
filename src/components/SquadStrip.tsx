import { observer } from 'mobx-react-lite';
import { store } from '../store/OracleStore.ts';
import { classes, cssUrl } from '../lib/css.ts';

/**
 * The stack for a squad draw. Clicking a slot features it on the stage; the ↻
 * redraws only that slot. Hidden entirely for a solo pick.
 */
export const SquadStrip = observer(function SquadStrip() {
  if (store.squad.length < 2) return null;

  return (
    <div className="squad-strip" role="group" aria-label="Squad draw">
      {store.squad.map((hero, index) => (
        <div className={classes('squad-slot', index === store.featured && 'featured')} key={`${index}-${hero.id}`}>
          <button
            className="slot-main"
            type="button"
            aria-pressed={index === store.featured}
            title={`Show ${hero.name}`}
            onClick={() => store.feature(index)}
          >
            <span className="slot-art" style={hero.image ? { backgroundImage: cssUrl(hero.image) } : undefined} />
            <span className="slot-index">{String(index + 1).padStart(2, '0')}</span>
            <span className="slot-name">{hero.name}</span>
          </button>
          <button
            className="slot-reroll"
            type="button"
            title={`Reroll slot ${index + 1}`}
            aria-label={`Reroll slot ${index + 1}, currently ${hero.name}`}
            onClick={() => store.rerollSlot(index)}
          >
            ↻
          </button>
        </div>
      ))}
    </div>
  );
});
