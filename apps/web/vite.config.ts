import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // During local dev, proxy /api to the Functions host (SWA CLI also does this).
    proxy: {
      '/api': 'http://localhost:7071',
    },
  },
  build: {
    outDir: 'dist',
  },
});
