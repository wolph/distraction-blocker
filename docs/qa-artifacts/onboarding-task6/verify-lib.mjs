import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 30 * 1024 * 1024,
  maxMembers: 600,
  maxFileBytes: 1024 * 1024,
  maxTotalExpandedBytes: 24 * 1024 * 1024,
});

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param {string} filePath */
export async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

/** @template T @param {readonly T[]} values @returns {T[]} */
function sorted(values) {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * @typedef {'file' | 'directory' | 'symlink' | 'hardlink' | 'fifo' | 'block-device' | 'character-device' | 'socket' | 'special'} ArchiveMemberType
 * @typedef {{ name: string, size: number, type: ArchiveMemberType }} ArchiveMember
 * @typedef {{ artifactCount: number, artifacts: Array<{ bytes: number, path: string, sha256: string }> }} ArtifactManifest
 */

/** @param {string} listing @returns {ArchiveMember[]} */
export function parseArchiveListing(listing) {
  return listing
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = /^(\S+)\s+\S+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/.exec(
        line,
      );
      assert(match !== null, `could not parse archive member listing: ${line}`);
      const permissions = match[1];
      const sizeText = match[2];
      const name = match[3];
      assert(permissions !== undefined && sizeText !== undefined && name !== undefined, 'invalid listing');
      /** @type {Record<string, ArchiveMemberType>} */
      const memberTypes = {
        '-': 'file',
        d: 'directory',
        l: 'symlink',
        h: 'hardlink',
        p: 'fifo',
        b: 'block-device',
        c: 'character-device',
        s: 'socket',
      };
      return {
        name,
        size: Number.parseInt(sizeText, 10),
        type: memberTypes[permissions[0] ?? ''] ?? 'special',
      };
    });
}

/** @param {string} archivePath @returns {ArchiveMember[]} */
export function listArchiveMembers(archivePath) {
  const listing = execFileSync('tar', ['-tvzf', archivePath], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  return parseArchiveListing(listing);
}

/**
 * @param {readonly ArchiveMember[]} members
 * @param {ArtifactManifest} manifest
 * @param {number} manifestBytes
 * @param {number} archiveBytes
 */
export function validateArchiveMembers(members, manifest, manifestBytes, archiveBytes) {
  assert(Number.isSafeInteger(archiveBytes) && archiveBytes >= 0, 'archive byte count is invalid');
  assert(
    archiveBytes <= ARCHIVE_LIMITS.maxArchiveBytes,
    `archive exceeds ${ARCHIVE_LIMITS.maxArchiveBytes} bytes`,
  );
  assert(
    manifest.artifactCount === manifest.artifacts.length,
    'tracked manifest artifact count is incorrect',
  );

  /** @type {Map<string, { size: number, type: ArchiveMemberType }>} */
  const expected = new Map([
    ['./', { size: 0, type: 'directory' }],
    ['./manifest.json', { size: manifestBytes, type: 'file' }],
  ]);
  for (const artifact of manifest.artifacts) {
    assert(
      artifact.path === path.basename(artifact.path) && artifact.path.length > 0,
      `tracked manifest contains unsafe artifact path: ${artifact.path}`,
    );
    const memberName = `./${artifact.path}`;
    assert(!expected.has(memberName), `tracked manifest contains duplicate artifact: ${artifact.path}`);
    expected.set(memberName, { size: artifact.bytes, type: 'file' });
  }

  assert(expected.size <= ARCHIVE_LIMITS.maxMembers, 'expected member count exceeds safety bound');
  assert(members.length <= ARCHIVE_LIMITS.maxMembers, 'archive member count exceeds safety bound');
  const seen = new Set();
  let expandedBytes = 0;
  for (const member of members) {
    assert(!seen.has(member.name), `duplicate archive member: ${member.name}`);
    seen.add(member.name);
    const segments = member.name.split('/');
    assert(
      !path.isAbsolute(member.name) && !segments.includes('..'),
      `unsafe archive member path: ${member.name}`,
    );
    assert(
      member.type === 'file' || member.type === 'directory',
      `unsupported archive member type ${member.type}: ${member.name}`,
    );
    const declaration = expected.get(member.name);
    assert(declaration !== undefined, `unexpected archive member: ${member.name}`);
    assert(
      member.type === declaration.type,
      `archive member type differs from tracked manifest: ${member.name}`,
    );
    assert(Number.isSafeInteger(member.size) && member.size >= 0, `invalid member size: ${member.name}`);
    assert(
      member.size <= ARCHIVE_LIMITS.maxFileBytes,
      `archive member exceeds ${ARCHIVE_LIMITS.maxFileBytes} bytes: ${member.name}`,
    );
    assert(member.size === declaration.size, `archive member size is incorrect: ${member.name}`);
    expandedBytes += member.size;
    assert(
      expandedBytes <= ARCHIVE_LIMITS.maxTotalExpandedBytes,
      `archive expanded size exceeds ${ARCHIVE_LIMITS.maxTotalExpandedBytes} bytes`,
    );
  }
  assert(members.length === expected.size, 'archive member count differs from tracked manifest');
  for (const expectedName of expected.keys()) {
    assert(seen.has(expectedName), `archive member is missing: ${expectedName}`);
  }
}

/** @param {string} directory @param {string} manifestPath */
export async function validateArtifactSet(directory, manifestPath) {
  /** @type {ArtifactManifest} */
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
      contents.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE),
      `${artifact.path} is not PNG image data`,
    );
    assert((await sha256(artifactPath)) === artifact.sha256, `${artifact.path} hash is incorrect`);
  }
  return manifest;
}

/**
 * @param {string} evidenceRoot
 * @param {string} archiveName
 * @param {string} manifestName
 * @param {number} expectedCount
 */
export async function validateArchive(evidenceRoot, archiveName, manifestName, expectedCount) {
  const archivePath = path.join(evidenceRoot, 'archives', archiveName);
  const trackedManifestPath = path.join(evidenceRoot, 'manifests', manifestName);
  const trackedManifestContents = await readFile(trackedManifestPath);
  /** @type {ArtifactManifest} */
  const trackedManifest = JSON.parse(trackedManifestContents.toString('utf8'));
  const archiveStats = await stat(archivePath);
  assert((await sha256(archivePath)) === archiveName.slice(0, 64), `${archiveName} hash is incorrect`);
  const members = listArchiveMembers(archivePath);
  validateArchiveMembers(
    members,
    trackedManifest,
    trackedManifestContents.byteLength,
    archiveStats.size,
  );

  const extractionDirectory = await mkdtemp(path.join(tmpdir(), 'focus-lock-task6-evidence-'));
  try {
    execFileSync(
      'tar',
      [
        '-xzf',
        archivePath,
        '--no-same-owner',
        '--no-same-permissions',
        '-C',
        extractionDirectory,
      ],
      { env: { ...process.env, LC_ALL: 'C' } },
    );
    assert((await sha256(archivePath)) === archiveName.slice(0, 64), `${archiveName} changed during verification`);
    const extractedManifestPath = path.join(extractionDirectory, 'manifest.json');
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
