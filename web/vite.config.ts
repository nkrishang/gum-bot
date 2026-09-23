import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `pnpm dev:web` serves the dashboard with hot reload and proxies the API to a running bot.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL('../dist/web', import.meta.url)), emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': `http://localhost:${process.env.PORT ?? 8080}` } },
});
