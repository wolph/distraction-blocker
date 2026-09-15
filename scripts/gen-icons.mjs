// Renders the static manifest PNGs from two sources.
// padlock.svg is the idle toolbar glyph at 16 and 32, the sizes the worker redraws per phase.
// brand.svg is the install and store icon at 48 and 128. The 128 render is the Web Store icon.
// Run from the repo root: node scripts/gen-icons.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const SOURCES = [
  { path: 'assets/icons/padlock.svg', sizes: [16, 32] },
  { path: 'assets/icons/brand.svg', sizes: [48, 128] },
];

// Read every source first so a missing one fails before any PNG is rewritten.
const renders = SOURCES.flatMap(({ path, sizes }) => {
  const svg = readFileSync(path);
  return sizes.map((size) => ({ svg, size }));
});
for (const { svg, size } of renders) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  const outputPath = `assets/icons/idle-${size}.png`;
  const png = resvg.render().asPng();
  if (!existsSync(outputPath) || !readFileSync(outputPath).equals(png)) {
    writeFileSync(outputPath, png);
  }
}
console.log('generated idle-{16,32}.png from padlock.svg and idle-{48,128}.png from brand.svg');
