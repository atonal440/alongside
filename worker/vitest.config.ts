import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': new URL('../shared', import.meta.url).pathname,
      valibot: new URL('./node_modules/valibot', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
