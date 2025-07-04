import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const rootDirectory = resolve(process.cwd());
const sourceDirectory = join(rootDirectory, 'docs', 'privacy');
const outputDirectory = join(rootDirectory, 'dist-pages');
const privacyOutputDirectory = join(outputDirectory, 'privacy');

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(privacyOutputDirectory, { recursive: true });

for (const filename of ['index.html', 'style.css']) {
  cpSync(join(sourceDirectory, filename), join(privacyOutputDirectory, filename));
}

cpSync(join(sourceDirectory, '404.html'), join(outputDirectory, '404.html'));
