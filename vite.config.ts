import { crx } from '@crxjs/vite-plugin';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [preact(), crx({ manifest })],
  build: {
    rollupOptions: {
      // Pages that are not manifest entries: CRXJS only emits manifest
      // targets, so the stats tab and the offscreen audio document are
      // added as plain Vite inputs.
      input: {
        onboarding: 'src/onboarding/onboarding.html',
        stats: 'src/stats/stats.html',
        offscreen: 'src/offscreen/audio.html',
      },
    },
  },
});
