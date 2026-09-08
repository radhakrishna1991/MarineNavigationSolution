import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // Proxying in development keeps the browser on one origin, so CORS and
    // WebSocket upgrades behave the same as they do behind the production
    // reverse proxy.
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4000', ws: true }
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
