import { useEffect } from 'react';
import { store } from './store/OracleStore.ts';
import { HeroStage } from './components/HeroStage.tsx';
import { RosterPanel } from './components/RosterPanel.tsx';
import { SettingsPanel } from './components/SettingsPanel.tsx';
import { TopBar, Toast } from './components/TopBar.tsx';

export function App() {
  useEffect(() => {
    void store.load(); // guarded by store.fetching, so StrictMode's double-run is a no-op

    // writeHash() uses replaceState, which does not fire this — so a hashchange
    // is always the user's doing: pasting a share link into an already-open tab,
    // or navigating back to one.
    const onHashChange = () => store.applySharedFromHash();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.ctrlKey || event.metaKey || event.altKey) return;
      // Space activates whatever control has focus; only hijack it when nothing
      // interactive does.
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(active.tagName))) return;
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
