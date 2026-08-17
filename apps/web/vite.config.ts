import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The shared package ships TypeScript source with no build step, so Vite
      // is pointed straight at it and transpiles it alongside app code.
      '@org/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Everything under /api goes to Fastify, so the browser sees one origin and
    // cookies work without CORS credentials in development.
    proxy: {
      '/api': { target: 'http://127.0.0.1:5174', changeOrigin: true },
    },
  },
});
