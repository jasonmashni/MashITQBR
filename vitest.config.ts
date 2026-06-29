import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@mashit/core': r('./packages/core/src/index.ts'),
      '@mashit/integrations': r('./packages/integrations/src/index.ts'),
      '@mashit/narrative': r('./packages/narrative/src/index.ts'),
      '@mashit/report': r('./packages/report/src/index.ts'),
    },
  },
  test: {
    globals: true,
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    environment: 'node',
  },
});
