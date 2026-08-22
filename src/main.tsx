import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline shell. './sw.js' is resolved against the document base URL, which is
// the deployed directory — the one place a bare relative path is exactly right.
// Note the trap: 'import.meta.url' here would resolve against the hashed bundle
// in assets/, registering a worker scoped to assets/ that never sees a
// navigation. Registration is best-effort; the app works without it.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
