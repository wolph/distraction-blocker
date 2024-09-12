import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

mkdirSync('assets/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < size * size; i++) {
    png.data[i * 4] = 156;
    png.data[i * 4 + 1] = 163;
    png.data[i * 4 + 2] = 175;
    png.data[i * 4 + 3] = 255;
  }
  writeFileSync(`assets/icons/idle-${size}.png`, PNG.sync.write(png));
}
