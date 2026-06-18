import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    target: 'esnext',
    rollupOptions: {
      // The offscreen document isn't referenced from the manifest, so register
      // it explicitly as an HTML entry point. This makes crxjs/Vite process and
      // bundle its module script (rather than copying the .ts reference as-is).
      input: {
        offscreen: 'src/offscreen/offscreen.html',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
});
