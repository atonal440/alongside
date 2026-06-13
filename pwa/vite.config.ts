import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
      rrule: path.resolve(__dirname, 'node_modules/rrule/dist/esm/index.js'),
      // valibot lives in pwa/node_modules; Rollup resolves bare imports from the
      // importing file's directory, so shared/ code can't find it without this alias.
      valibot: path.resolve(__dirname, 'node_modules/valibot'),
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      manifest: {
        name: 'Alongside',
        short_name: 'Alongside',
        start_url: '/',
        display: 'standalone',
        background_color: '#1a1a1a',
        theme_color: '#1a1a1a',
        description: 'A lightweight task manager built around conversational workflow',
        icons: [
          {
            src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='80' font-size='80'>%E2%9C%93</text></svg>",
            sizes: 'any',
            type: 'image/svg+xml',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
      },
    }),
  ],
});
