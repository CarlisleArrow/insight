import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// React + Vite (JS, not TS). Carbon styles are pulled in from
// prebuilt CSS in src/styles, so no global SCSS compile is required.
export default defineConfig({
  plugins: [react()],
  server: {
	host: '0.0.0.0',
    port: 15173,
    open: true,
    watch: {
      // these can be locked/large and have crashed the watcher (EBUSY)
      ignored: ['**/ARCHITECTURE.md', '**/_handoff/**', '**/_handoff2/**', '**/*.zip', '**/control-plane/**', '**/sql-rewrite/**'],
    },
    // Forward /api to the control-plane BFF so the SPA and backend are same-origin
    // in dev (no CORS). Override the target with VITE_API_TARGET if needed.
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://172.16.23.239:8088',
        changeOrigin: true,
      },
      // Public read-only Data API endpoints (dataapi_external.go). The in-product
      // "Try it" debugger calls these directly to prove "safe even without auth".
      '/data-api': {
        target: process.env.VITE_API_TARGET || 'http://172.16.23.239:8088',
        changeOrigin: true,
      },
    },
  },
});
