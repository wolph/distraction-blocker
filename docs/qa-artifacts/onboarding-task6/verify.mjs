import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const evidenceRoot = path.dirname(fileURLToPath(import.meta.url));
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

function sorted(values) {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function validateArtifactSet(directory, manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const expectedNames = sorted(manifest.artifacts.map((artifact) => artifact.path));
  const actualNames = sorted(
    (await readdir(directory)).filter((name) => name.toLowerCase().endsWith('.png')),
  );
  assert(
    JSON.stringify(actualNames) === JSON.stringify(expectedNames),
    `${manifestPath} does not enumerate the exact PNG set`,
  );
  assert(manifest.artifactCount === expectedNames.length, `${manifestPath} count is incorrect`);
  for (const artifact of manifest.artifacts) {
    assert(
      artifact.path === path.basename(artifact.path),
      `${manifestPath} contains an unsafe artifact path`,
    );
    const artifactPath = path.join(directory, artifact.path);
    const contents = await readFile(artifactPath);
    assert(contents.byteLength === artifact.bytes, `${artifact.path} byte count is incorrect`);
    assert(
      contents.subarray(0, pngSignature.byteLength).equals(pngSignature),
      `${artifact.path} is not PNG image data`,
    );
    assert((await sha256(artifactPath)) === artifact.sha256, `${artifact.path} hash is incorrect`);
  }
  return manifest;
}

async function validateArchive(archiveName, manifestName, expectedCount) {
  const archivePath = path.join(evidenceRoot, 'archives', archiveName);
  assert((await sha256(archivePath)) === archiveName.slice(0, 64), `${archiveName} hash is incorrect`);
  const members = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  for (const member of members) {
    const segments = member.split('/');
    assert(!path.isAbsolute(member) && !segments.includes('..'), `${archiveName} has unsafe members`);
  }
  const extractionDirectory = await mkdtemp(path.join(tmpdir(), 'focus-lock-task6-evidence-'));
  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', extractionDirectory]);
    const extractedManifestPath = path.join(extractionDirectory, 'manifest.json');
    const trackedManifestPath = path.join(evidenceRoot, 'manifests', manifestName);
    assert(
      (await sha256(extractedManifestPath)) === (await sha256(trackedManifestPath)),
      `${archiveName} manifest differs from ${manifestName}`,
    );
    const manifest = await validateArtifactSet(extractionDirectory, extractedManifestPath);
    assert(manifest.artifactCount === expectedCount, `${archiveName} artifact count is incorrect`);
    return manifest;
  } finally {
    await rm(extractionDirectory, { recursive: true });
  }
}

const devManifest = await validateArchive(
  'e9212cbda6e84f19b8f4d998eba719380ea1faf9e4ab8517c18c67c2e7d98a7b.tar.gz',
  'dev-server-manifest.json',
  528,
);
assert(devManifest.mockedChromeApis === true, 'dev-server mock disclosure is missing');

const productionManifest = await validateArchive(
  'aefeeec2f37b11a342bf392d5df957cebb08f6fb20409a60ecad046b31233d4c.tar.gz',
  'production-manifest.json',
  372,
);
assert(!('mockedChromeApis' in productionManifest), 'production manifest has a false no-mock claim');
assert(
  productionManifest.runtimeApiInterceptions.length === 2 &&
    productionManifest.runtimeApiInterceptions.every(
      (interception) => interception.observedCount === interception.expectedCount,
    ),
  'production runtime interception evidence is incomplete',
);

const promptManifestPath = path.join(evidenceRoot, 'manifests', 'real-prompt-manifest.json');
const promptManifest = await validateArtifactSet(
  path.join(evidenceRoot, 'real-prompt'),
  promptManifestPath,
);
assert(promptManifest.mockedChromeApis === false, 'real prompt no-mock evidence is missing');
assert(promptManifest.artifactCount === 6, 'real prompt artifact count is incorrect');

console.log('Task 6 evidence verified: 528 dev, 372 production, 6 real-prompt PNGs.');
