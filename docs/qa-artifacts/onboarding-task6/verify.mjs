import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateArchive, validateArtifactSet } from './verify-lib.mjs';

const evidenceRoot = path.dirname(fileURLToPath(import.meta.url));

const devManifest = await validateArchive(
  evidenceRoot,
  'e9212cbda6e84f19b8f4d998eba719380ea1faf9e4ab8517c18c67c2e7d98a7b.tar.gz',
  'dev-server-manifest.json',
  528,
);
if (devManifest.mockedChromeApis !== true) {
  throw new Error('dev-server mock disclosure is missing');
}

const productionManifest = await validateArchive(
  evidenceRoot,
  'aefeeec2f37b11a342bf392d5df957cebb08f6fb20409a60ecad046b31233d4c.tar.gz',
  'production-manifest.json',
  372,
);
if ('mockedChromeApis' in productionManifest) {
  throw new Error('production manifest has a false no-mock claim');
}
if (
  !Array.isArray(productionManifest.runtimeApiInterceptions) ||
  productionManifest.runtimeApiInterceptions.length !== 2 ||
  !productionManifest.runtimeApiInterceptions.every(
    (interception) =>
      typeof interception === 'object' &&
      interception !== null &&
      interception.observedCount === interception.expectedCount,
  )
) {
  throw new Error('production runtime interception evidence is incomplete');
}

const promptManifest = await validateArtifactSet(
  path.join(evidenceRoot, 'real-prompt'),
  path.join(evidenceRoot, 'manifests', 'real-prompt-manifest.json'),
);
if (promptManifest.mockedChromeApis !== false) {
  throw new Error('real prompt no-mock evidence is missing');
}
if (promptManifest.artifactCount !== 6) {
  throw new Error('real prompt artifact count is incorrect');
}

console.log('Task 6 evidence verified: 528 dev, 372 production, 6 real-prompt PNGs.');
