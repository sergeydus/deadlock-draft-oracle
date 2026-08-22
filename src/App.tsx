import { useEffect } from 'react';
import { store } from './store/OracleStore.ts';
import { HeroStage } from './components/HeroStage.tsx';
import { RosterPanel } from './components/RosterPanel.tsx';
import { SettingsPanel } from './components/SettingsPanel.tsx';
import { TopBar } from './components/TopBar.tsx';
import { Toast } from './components/Toast.tsx';

export function App() {
  useEffect(() => {
    void store.load(); // guarded by store.fetching, so StrictMode's double-run is a no-op

    // writeHash() uses replaceState, which does not fire this — so a hashchange
    // is always the user's doing: pasting a share link into an already-open tab,
    // or navigating back to one.
    const onHashChange = () => store.applySharedFromHash();

    const onKeyDown = (event: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const typing = active !== null
        && (active.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName));

      // Hidden key sequences (see lib/eggs) watch everything except real typing.
      if (!typing && !event.repeat) store.noteKey(event.code);

      if (event.code !== 'Space' || event.ctrlKey || event.metaKey || event.altKey) return;
      // A held key auto-repeats. Without this, one press drew twenty-one times
      // and inflated a lifetime tally that persists — measured on production.
      if (event.repeat) return;
      // Space activates whatever control has focus; only hijack it when nothing
      // interactive does.
      if (typing || (active && ['BUTTON', 'A'].includes(active.tagName))) return;
      event.preventDefault();
      store.roll();
    };

    window.addEventListener('hashchange', onHashChange);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <>
      <main className="shell">
        <TopBar />
        <HeroStage />
        <section className="dashboard" aria-label="Randomizer settings and hero roster">
          <SettingsPanel />
          <RosterPanel />
        </section>
      </main>
      <Toast />
    </>
  );
}
