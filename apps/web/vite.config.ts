import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Compiled-in build stamp (shown in the sidebar footer) so a deployed app
// always tells you exactly which commit it's running — no more guessing
// whether a deploy actually landed.
const sha = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
})();
const BUILD_INFO = `${sha} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export default defineConfig({
  plugins: [react()],
  define: { __BUILD_INFO__: JSON.stringify(BUILD_INFO) },
  server: {
    // During local dev, proxy /api to the Functions host (SWA CLI also does this).
    proxy: {
      '/api': 'http://localhost:7071',
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // Stable vendor chunks so hashed files cache across app deploys.
        // Order matters: charts must match before the generic @mantine test,
        // and react/react-dom/scheduler must stay together (chunk-init TDZ).
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (/node_modules\/(recharts|@mantine\/charts|d3-|victory-vendor|internmap|delaunator|robust-predicates)/.test(id)) return 'charts';
          if (/node_modules\/@mantine\//.test(id)) return 'mantine';
          if (/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|@remix-run)[/@]/.test(id)) return 'react-vendor';
          return undefined;
        },
      },
    },
  },
});
