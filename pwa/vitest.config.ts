import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
      rrule: path.resolve(__dirname, 'node_modules/rrule/dist/esm/index.js'),
      valibot: path.resolve(__dirname, 'node_modules/valibot'),
    },
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
    environmentMatchGlobs: [
      ['test/components/**', 'jsdom'],
      ['test/hooks/**', 'jsdom'],
    ],
    setupFiles: ['test/setup.ts'],
  },
});
