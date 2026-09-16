import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

const currentDirectory: string = dirname(fileURLToPath(import.meta.url));
const siteRoot: string = resolve(currentDirectory, 'docs/site');

/**
 * The GitHub Pages site: the landing page with the in-browser demo and, per fake tab, the document
 * each iframe loads. File names are not hashed so `tab.html` can name its own script and the
 * validator can pin the output list.
 */
export default defineConfig({
  root: siteRoot,
  base: '/focus-lock/',
  plugins: [preact()],
  build: {
    outDir: '../../dist-pages',
    emptyOutDir: true,
    // false, not { polyfill: false }: main.tsx and tab.ts now share a chunk (both reach
    // src/shared/enforcement-v2-validation transitively), so Vite would inject a
    // <link rel="modulepreload"> for it. The pages validator's resource policy allows only
    // script, stylesheet and image links, so the preload hint has to be off rather than allowed.
    modulePreload: false,
    rollupOptions: {
      // Rollup resolves bare relative entry paths against process.cwd(), not against `root`, so
      // these must be absolute.
      input: {
        main: resolve(siteRoot, 'index.html'),
        tab: resolve(siteRoot, 'tab.html'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
