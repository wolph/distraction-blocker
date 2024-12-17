// Renders assets/icons/padlock.svg to the static manifest PNGs.
// Run from the repo root: node scripts/gen-icons.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync('assets/icons/padlock.svg');
for (const size of [16, 32, 48, 128]) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  const outputPath = `assets/icons/idle-${size}.png`;
  const png = resvg.render().asPng();
  if (!existsSync(outputPath) || !readFileSync(outputPath).equals(png)) {
    writeFileSync(outputPath, png);
  }
}
console.log('generated idle-{16,32,48,128}.png from padlock.svg');
