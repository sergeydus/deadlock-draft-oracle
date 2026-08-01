import { observer } from 'mobx-react-lite';
import { store } from '../store/OracleStore.ts';
import { classes } from '../lib/css.ts';

/** Transient feedback. Kept mounted while fading so the transition can run. */
export const Toast = observer(function Toast() {
  if (!store.toastMessage) return null;
  return (
    <div className={classes('toast', store.toastVisible && 'visible')} role="status" aria-live="polite">
      {store.toastMessage}
    </div>
  );
});
