import { useEffect, useState, type CSSProperties } from 'react';
import { observer } from 'mobx-react-lite';
import { store } from '../store/OracleStore.ts';
import { NO_DESCRIPTION } from '../constants.ts';
import { classes, cssUrl, titleCase } from '../lib/css.ts';
import { SquadStrip } from './SquadStrip.tsx';

/**
 * Decode the portrait off-screen and only swap it in once ready, so a reveal
 * never flashes an empty frame. The effect cleanup is what stops a slow image
 * from an earlier roll landing after a newer one.
 */
const StageArt = observer(function StageArt({ url }: { url: string }) {
  const [ready, setReady] = useState('');

  useEffect(() => {
    if (!url) { setReady(''); return; }
    let live = true;
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => { if (live) setReady(url); };
    image.onerror = () => { if (live) setReady(''); };
    image.src = url;
    return () => { live = false; };
  }, [url]);

  return (
    <div
      className={classes('hero-art', !ready && 'is-empty')}
      aria-hidden="true"
      style={{ backgroundImage: ready ? cssUrl(ready) : undefined, opacity: ready ? 0.55 : 0.1 }}
    />
  );
});

/** Role / weapon / complexity, whichever of them the feeds actually supplied. */
const HeroTags = observer(function HeroTags() {
  const hero = store.featuredHero;
  const tags = hero
    ? [hero.role && titleCase(hero.role), hero.weapon, hero.complexity ? `Complexity ${hero.complexity}` : ''].filter(Boolean)
    : [];
  if (!tags.length) return null;
  return (
    <p className="hero-tags">
      {tags.map((tag) => <span className="hero-tag" key={tag}>{tag}</span>)}
    </p>
  );
});

/** Heading, body copy and art for whichever state the stage is in. */
function stageCopy(): { title: string; description: string; number: string } {
  switch (store.mode) {
    case 'loading':
      return {
        title: 'Loading your next main',
        description: 'Syncing with the current Deadlock character roster.',
        number: 'LIVE ROSTER',
      };
    case 'offline':
      return {
        title: 'Signal lost',
        description: 'The live data providers could not be reached. Check your connection, then refresh the roster.',
        number: 'OFFLINE',
      };
    case 'empty':
      return {
        title: 'No hero left',
        description: 'Re-enable a hero or clear your exclusions to restore the pool.',
        number: store.stageLabel,
      };
    default: {
      const hero = store.featuredHero;
      return {
        title: hero?.name ?? '',
        description: hero?.description || NO_DESCRIPTION,
        number: store.stageLabel,
      };
    }
  }
}

export const HeroStage = observer(function HeroStage() {
  const hero = store.featuredHero;
  const copy = stageCopy();
  const drawn = store.mode === 'draw' && hero !== null;
  // The ambient blobs read this custom property; empty falls back to the
  // literals in styles.css.
  const accentStyle = { '--hero-accent': hero?.accent || '' } as CSSProperties;

  return (
    <section
      className="hero-stage"
      aria-labelledby="pickedLabel"
      style={accentStyle}
    >
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="scanlines" />
      <div className="eyebrow" id="pickedLabel">THE ORACLE CHOOSES</div>
      <StageArt url={drawn ? hero.image : ''} />
      <p className="hero-number">{copy.number}</p>
      {/* Keyed on the draw so the reveal animation restarts even when the same
          hero is drawn twice in a row. */}
      <h1 className={drawn ? 'rolling' : undefined} key={store.drawId}>{copy.title}</h1>
      <p className="hero-description" title={hero?.description || ''}>{copy.description}</p>
      <HeroTags />

      <SquadStrip />

      <div className="pick-controls">
        <button className="primary-button" type="button" disabled={!store.heroes.length} onClick={store.roll}>
          <span className="dice" aria-hidden="true">✦</span> <span>{store.rollLabel}</span>
        </button>
        <button className="secondary-button" type="button" disabled={!drawn} onClick={store.excludeFeatured}>
          Exclude pick
        </button>
        <button className="secondary-button" type="button" disabled={!drawn} onClick={store.copyLink}>
          Copy draw link
        </button>
      </div>
      <p className="shortcut">Press <kbd>Space</kbd> to reroll</p>
    </section>
  );
});
