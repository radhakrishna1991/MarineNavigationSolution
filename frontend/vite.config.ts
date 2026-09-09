import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/*
 * The dashboard is normally served from the root of its origin, but under IIS
 * it is an application beneath Default Web Site and lives at a virtual path.
 * `VITE_BASE_PATH=/MNS` at build time rewrites every asset URL to match, and
 * `import.meta.env.BASE_URL` then carries the same value into the router, the
 * API client and the WebSocket client - one setting, set in one place.
 */
const basePath = `/${(process.env.VITE_BASE_PATH ?? '').trim().replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '/');

// https://vitejs.dev/config/
export default defineConfig({
  base: basePath === '/' ? '/' : `${basePath}/`,
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // Proxying in development keeps the browser on one origin, so CORS and
    // WebSocket upgrades behave the same as they do behind the production
    // reverse proxy.
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws': {
        target: 'ws://localhost:4000',
        ws: true,
        /*
         * The backend runs under `node --watch`, so every save restarts it and
         * drops every open WebSocket. http-proxy raises that as an unhandled
         * socket error and Vite prints it as `ws proxy socket error: read
         * ECONNRESET` - which reads like a fault when it is a normal restart,
         * and is alarming to have on screen during a demonstration.
         *
         * Expected disconnects are swallowed. A backend that is not running is
         * still reported, but as one actionable line rather than a stack trace,
         * because that one the developer does need to know about.
         */
        configure(proxy) {
          proxy.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return;
            if (err.code === 'ECONNREFUSED') {
              console.warn('[ws proxy] backend not reachable on :4000 - is it running?');
              return;
            }
            console.error(`[ws proxy] ${err.message}`);
          });
        }
      }
    }
  },
  preview: { port: 4173, host: true },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // MapLibre and ECharts are large and change rarely; splitting them
        // keeps the application chunk small enough to reload quickly on a
        // bridge terminal with a slow link.
        manualChunks: {
          maplibre: ['maplibre-gl'],
          charts: ['echarts', 'echarts-for-react'],
          vendor: ['react', 'react-dom', 'react-router-dom', '@reduxjs/toolkit', 'react-redux']
        }
      }
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    css: false
  }
});
