import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the built site works from a subpath (GitHub Pages) as well as
// a domain root.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173 },
});
