import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { crc32 as calculateCrc32 } from 'node:zlib';
import yauzl from 'yauzl';
import yazl from 'yazl';
import {
  assert,
  assertString,
  objectKeysAre,
  readJson,
  readRequiredFile,
  sha256,
  validateRelativePath,
} from './files.mjs';

const MAX_ARCHIVE_ENTRIES = 5_000;
const MAX_ARCHIVE_ENTRY_SIZE = 16 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_SIZE = 64 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const FIXED_ARCHIVE_MTIME = new Date(2000, 0, 1, 0, 0, 0, 0);
const REGULAR_FILE_MODE = 0o100644;
const FIXED_DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;
const FIXED_DOS_TIME = 0;
const UTF8_FILE_NAME_FLAG = 0x0800;
const DEFLATE_COMPRESSION_METHOD = 8;

function validateArchiveEntryName(fileName) {
  validateRelativePath(fileName, 'ZIP entry');
  assert(!/^[a-z]:/iu.test(fileName), `ZIP entry has an absolute drive path: ${fileName}`);
}

function validateArchiveEntryMetadata(entry, seen, totals) {
  validateArchiveEntryName(entry.fileName);
  assert(!seen.has(entry.fileName), `Duplicate ZIP entry: ${entry.fileName}`);
  const previousFileName = [...seen].at(-1);
  assert(
    previousFileName === undefined || previousFileName < entry.fileName,
    `ZIP entry order must be sorted: ${entry.fileName} follows ${previousFileName}`,
  );
  seen.add(entry.fileName);
  assert(!entry.fileName.endsWith('/'), `ZIP directories are forbidden: ${entry.fileName}`);
  assert(
    entry.externalFileAttributes === (REGULAR_FILE_MODE << 16) >>> 0,
    `ZIP entry mode must be exactly 100644: ${entry.fileName}`,
  );
  assert(
    entry.generalPurposeBitFlag === UTF8_FILE_NAME_FLAG,
    `ZIP entry has non-generator general-purpose flags: ${entry.fileName}`,
  );
  assert(
    entry.compressionMethod === DEFLATE_COMPRESSION_METHOD,
    `ZIP entry must use the generator compression method: ${entry.fileName}`,
  );
  assert(
    entry.lastModFileDate === FIXED_DOS_DATE && entry.lastModFileTime === FIXED_DOS_TIME,
    `ZIP entry must use the fixed generator timestamp: ${entry.fileName}`,
  );
  assert(
    entry.extraFieldRaw.length === 0,
    `ZIP entry extra fields are forbidden: ${entry.fileName}`,
  );
  assert(entry.fileCommentRaw.length === 0, `ZIP entry comments are forbidden: ${entry.fileName}`);
  assert(!entry.isEncrypted(), `Encrypted ZIP entry is forbidden: ${entry.fileName}`);
  assert(
    entry.uncompressedSize <= MAX_ARCHIVE_ENTRY_SIZE,
    `ZIP entry exceeds size limit: ${entry.fileName}`,
  );
  totals.uncompressedSize += entry.uncompressedSize;
  assert(
    totals.uncompressedSize <= MAX_ARCHIVE_TOTAL_SIZE,
    'ZIP archive exceeds total uncompressed size limit',
  );
  if (entry.uncompressedSize > 0) {
    assert(entry.compressedSize > 0, `ZIP entry has an invalid compressed size: ${entry.fileName}`);
    assert(
      entry.uncompressedSize / entry.compressedSize <= MAX_COMPRESSION_RATIO,
      `ZIP entry has a suspicious compression ratio: ${entry.fileName}`,
    );
  }
}

function readLocalFileHeader(zipFile, entry) {
  return new Promise((resolveHeader, rejectHeader) => {
    zipFile.readLocalFileHeader(entry, { minimal: false }, (error, header) => {
      if (error !== null) rejectHeader(error);
      else resolveHeader(header);
    });
  });
}

function validateLocalFileHeader(header, entry) {
  assert(
    header.fileName.equals(entry.fileNameRaw),
    `ZIP local file name does not match its directory entry: ${entry.fileName}`,
  );
  assert(
    header.generalPurposeBitFlag === UTF8_FILE_NAME_FLAG,
    `ZIP local header has non-generator general-purpose flags: ${entry.fileName}`,
  );
  assert(
    header.compressionMethod === DEFLATE_COMPRESSION_METHOD,
    `ZIP local header must use the generator compression method: ${entry.fileName}`,
  );
  assert(
    header.lastModFileDate === FIXED_DOS_DATE && header.lastModFileTime === FIXED_DOS_TIME,
    `ZIP local header must use the fixed generator timestamp: ${entry.fileName}`,
  );
  assert(
    header.extraField.length === 0,
    `ZIP local header extra fields are forbidden: ${entry.fileName}`,
  );
  assert(header.crc32 === entry.crc32, `ZIP local header CRC-32 mismatch: ${entry.fileName}`);
  assert(
    header.compressedSize === entry.compressedSize &&
      header.uncompressedSize === entry.uncompressedSize,
    `ZIP local header size mismatch: ${entry.fileName}`,
  );
}

async function readArchiveEntry(zipFile, entry) {
  const localHeader = await readLocalFileHeader(zipFile, entry);
  validateLocalFileHeader(localHeader, entry);
  return new Promise((resolveEntry, rejectEntry) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error !== null) {
        rejectEntry(error);
        return;
      }
      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_ARCHIVE_ENTRY_SIZE) {
          stream.destroy(new Error(`ZIP entry exceeds size limit: ${entry.fileName}`));
          return;
        }
        chunks.push(chunk);
      });
      stream.once('error', rejectEntry);
      stream.once('end', () => resolveEntry(Buffer.concat(chunks)));
    });
  });
}

function inspectArchive(buffer) {
  return new Promise((resolveArchive, rejectArchive) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (openError, zipFile) => {
        if (openError !== null) {
          rejectArchive(new Error(`Invalid ZIP archive: ${openError.message}`));
          return;
        }
        assert(zipFile !== undefined, 'Invalid ZIP archive: missing reader');
        readArchive(zipFile, resolveArchive, rejectArchive);
      },
    );
  });
}

function readArchive(zipFile, resolveArchive, rejectArchive) {
  const entries = new Map();
  const seen = new Set();
  const totals = { uncompressedSize: 0 };
  let settled = false;
  const rejectOnce = (error) => {
    if (settled) return;
    settled = true;
    rejectArchive(
      new Error(`Invalid ZIP archive: ${error instanceof Error ? error.message : String(error)}`),
    );
  };
  zipFile.once('error', rejectOnce);
  zipFile.once('end', () => {
    if (settled) return;
    settled = true;
    resolveArchive(entries);
  });
  try {
    assert(zipFile.comment.length === 0, 'ZIP archive comment is forbidden');
  } catch (error) {
    rejectOnce(error);
    return;
  }
  const state = { entries, seen, totals, rejectOnce, settled: () => settled };
  zipFile.on('entry', (entry) => readNextArchiveEntry(zipFile, entry, state));
  zipFile.readEntry();
}

function readNextArchiveEntry(zipFile, entry, state) {
  if (state.settled()) return;
  try {
    assert(state.seen.size < MAX_ARCHIVE_ENTRIES, 'ZIP archive exceeds entry count limit');
    validateArchiveEntryMetadata(entry, state.seen, state.totals);
  } catch (error) {
    state.rejectOnce(error);
    return;
  }
  readArchiveEntry(zipFile, entry)
    .then((contents) => {
      assert(
        calculateCrc32(contents) === entry.crc32,
        `ZIP entry CRC-32 mismatch: ${entry.fileName}`,
      );
      state.entries.set(entry.fileName, contents);
      zipFile.readEntry();
    })
    .catch(state.rejectOnce);
}

function validateArchiveContents(archiveEntries, distFiles) {
  const archivePaths = [...archiveEntries.keys()].sort();
  const distPaths = [...distFiles.keys()].sort();
  assert(
    isDeepStrictEqual(archivePaths, distPaths),
    `ZIP inventory must exactly match dist. ZIP: ${archivePaths.join(', ')}. dist: ${distPaths.join(', ')}`,
  );
  assert(archivePaths.includes('manifest.json'), 'ZIP must contain manifest.json at the root');
  for (const path of distPaths) {
    assert(
      archiveEntries.get(path).equals(distFiles.get(path)),
      `ZIP entry byte mismatch: ${path}`,
    );
  }
}

async function inspectAndCompareArchive(buffer, distFiles) {
  const archiveEntries = await inspectArchive(buffer);
  validateArchiveContents(archiveEntries, distFiles);
}

export async function validatePackageManifest(rootDirectory, manifest, distFiles) {
  const packageManifest = readJson(
    rootDirectory,
    'release/package-manifest.json',
    'package manifest',
  );
  objectKeysAre(packageManifest, ['version', 'zipPath', 'sha256'], [], 'Package manifest');
  for (const key of ['version', 'zipPath', 'sha256']) assertString(packageManifest[key], key);
  const expectedZipPath = `release/focus-lock-${manifest.version}.zip`;
  assert(packageManifest.version === manifest.version, 'Package manifest version mismatch');
  assert(
    packageManifest.zipPath === expectedZipPath,
    `Package manifest zipPath must be ${expectedZipPath}`,
  );
  assert(
    /^[0-9a-f]{64}$/u.test(packageManifest.sha256),
    'Package manifest sha256 must be lowercase hex',
  );
  const zip = readRequiredFile(rootDirectory, packageManifest.zipPath, 'ZIP archive');
  assert(sha256(zip) === packageManifest.sha256, 'Package manifest sha256 mismatch');
  await inspectAndCompareArchive(zip, distFiles);
}

function createArchive(distFiles) {
  return new Promise((resolveArchive, rejectArchive) => {
    const zipFile = new yazl.ZipFile();
    const chunks = [];
    zipFile.outputStream.on('data', (chunk) => chunks.push(chunk));
    zipFile.outputStream.once('error', rejectArchive);
    zipFile.outputStream.once('end', () => resolveArchive(Buffer.concat(chunks)));
    for (const path of [...distFiles.keys()].sort()) {
      zipFile.addBuffer(distFiles.get(path), path, {
        mtime: FIXED_ARCHIVE_MTIME,
        mode: REGULAR_FILE_MODE,
        compress: true,
        compressionLevel: 9,
        forceDosTimestamp: true,
      });
    }
    zipFile.end({ forceZip64Format: false, comment: '' });
  });
}

function writeAtomically(path, buffer) {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, buffer, { flag: 'wx', mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function packageManifestBuffer(version, zipPath, checksum) {
  return Buffer.from(`${JSON.stringify({ version, zipPath, sha256: checksum }, null, 2)}\n`);
}

export async function createReleasePackage(rootDirectory, manifest, distFiles) {
  const releaseDirectory = join(rootDirectory, 'release');
  mkdirSync(releaseDirectory, { recursive: true });
  const zipName = `focus-lock-${manifest.version}.zip`;
  const zipRelativePath = `release/${zipName}`;
  const zipPath = join(releaseDirectory, zipName);
  const temporaryZipPath = `${zipPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const archive = await createArchive(distFiles);
    writeFileSync(temporaryZipPath, archive, { flag: 'wx', mode: 0o600 });
    const inspectedArchive = readFileSync(temporaryZipPath);
    await inspectAndCompareArchive(inspectedArchive, distFiles);
    renameSync(temporaryZipPath, zipPath);
    const checksum = sha256(inspectedArchive);
    writeAtomically(
      join(releaseDirectory, 'package-manifest.json'),
      packageManifestBuffer(manifest.version, zipRelativePath, checksum),
    );
    return { zipRelativePath, checksum };
  } finally {
    rmSync(temporaryZipPath, { force: true });
  }
}
