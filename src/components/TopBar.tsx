import { observer } from 'mobx-react-lite';
import { store } from '../store/OracleStore.ts';
import { classes } from '../lib/css.ts';

export const TopBar = observer(function TopBar() {
  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="Draft Oracle home">
        <span className="brand-mark">D</span>
        <span>Draft Oracle</span>
      </a>
      <div className={classes('source-status', store.statusKind)} aria-live="polite">
        <span className="status-dot" />
        <span>{store.statusMessage}</span>
      </div>
      <button
        className="icon-button"
        type="button"
        title="Refresh live roster"
        aria-label="Refresh live roster"
        disabled={store.fetching}
        onClick={store.load}
      >
        ↻
      </button>
    </header>
  );
});
