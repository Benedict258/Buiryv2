import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the dashboard proxies the API so the session cookie is same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/v1': { target: process.env.BUIRY_API ?? 'http://localhost:8787', changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: false },
});
