import type { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';

export interface PackageManifest {
  sha256: string;
  version: string;
  zipPath: string;
}

export interface ArchiveEntry {
  compressedSize: number;
  compressionMethod: number;
  crc32: number;
  externalFileAttributes: number;
  fileName: string;
  generalPurposeBitFlag: number;
  localHeaderOffset: number;
  uncompressedSize: number;
}

export interface ArchiveTotals {
  entryCount: number;
  uncompressedBytes: number;
}

export const ARCHIVE_LIMITS: Readonly<{
  maxArchiveBytes: number;
  maxCompressionRatio: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalUncompressedBytes: number;
}> = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxEntries: 5_000,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalUncompressedBytes: 64 * 1024 * 1024,
});

export const PACKAGE_MANIFEST_RELATIVE_PATH: string = 'release/package-manifest.json';
export const DEFLATE_COMPRESSION_METHOD: number = 8;
export const UTF8_FILE_NAME_FLAG: number = 0x0800;
export const REGULAR_FILE_EXTERNAL_ATTRIBUTES: number = (0o100644 << 16) >>> 0;

const END_OF_CENTRAL_DIRECTORY_SIGNATURE: number = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE: number = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE: number = 0x04034b50;
const END_OF_CENTRAL_DIRECTORY_SIZE: number = 22;
const CENTRAL_DIRECTORY_HEADER_SIZE: number = 46;
const LOCAL_FILE_HEADER_SIZE: number = 30;
const MAX_ARCHIVE_COMMENT_SIZE: number = 65_535;
const UNIX_FILE_TYPE_MASK: number = 0o170000;
const UNIX_SYMBOLIC_LINK_TYPE: number = 0o120000;
const MS_DOS_DIRECTORY_ATTRIBUTE: number = 0x10;
const VERSION_PATTERN: RegExp = /^\d{1,5}(\.\d{1,5}){0,3}$/u;
const SHA256_PATTERN: RegExp = /^[0-9a-f]{64}$/u;
const WINDOWS_DRIVE_PATTERN: RegExp = /^[a-z]:/iu;
const REBUILD_HINT: string = 'Run "npm run store:package" to build the release artifact first.';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateArchiveEntryName(fileName: string): void {
  assert(fileName.length > 0, 'ZIP entry has an empty name');
  assert(!fileName.includes('\0'), `ZIP entry name contains a null byte: ${fileName}`);
  assert(!fileName.includes('\\'), `ZIP entry name must use forward slashes: ${fileName}`);
  assert(!path.isAbsolute(fileName), `ZIP entry name is an absolute path: ${fileName}`);
  assert(!fileName.startsWith('/'), `ZIP entry name is an absolute path: ${fileName}`);
  assert(
    !WINDOWS_DRIVE_PATTERN.test(fileName),
    `ZIP entry name has an absolute drive path: ${fileName}`,
  );
  assert(!fileName.endsWith('/'), `ZIP directory entries are forbidden: ${fileName}`);
  const components: string[] = fileName.split('/');
  assert(
    components.every(
      (component: string): boolean => component !== '' && component !== '.' && component !== '..',
    ),
    `ZIP entry name contains an unsafe path component: ${fileName}`,
  );
}

/**
 * Checks one entry against the archive-safety rules and records it in the accumulators, which
 * is what carries the duplicate-name, entry-count, and total-size limits across a whole archive.
 * The name says admit rather than validate because `seen` and `totals` are written here.
 */
export function admitArchiveEntry(
  entry: ArchiveEntry,
  seen: Set<string>,
  totals: ArchiveTotals,
): void {
  validateArchiveEntryName(entry.fileName);
  assert(!seen.has(entry.fileName), `Duplicate ZIP entry: ${entry.fileName}`);
  seen.add(entry.fileName);
  totals.entryCount += 1;
  assert(
    totals.entryCount <= ARCHIVE_LIMITS.maxEntries,
    `ZIP archive exceeds the ${ARCHIVE_LIMITS.maxEntries} entry limit`,
  );
  assert(
    entry.generalPurposeBitFlag === UTF8_FILE_NAME_FLAG,
    `ZIP entry has non-generator general-purpose flags: ${entry.fileName}`,
  );
  assert(
    entry.compressionMethod === DEFLATE_COMPRESSION_METHOD,
    `ZIP entry must use the generator compression method: ${entry.fileName}`,
  );
  // The exact-attributes assert three lines down subsumes both of these: it forces the low
  // sixteen bits to zero and the mode to a regular file. They stay because they name what is
  // wrong with a rejected archive, and they must stay ahead of it to be the message you get.
  assert(
    (entry.externalFileAttributes & MS_DOS_DIRECTORY_ATTRIBUTE) === 0,
    `ZIP directory entries are forbidden: ${entry.fileName}`,
  );
  const unixMode: number = (entry.externalFileAttributes >>> 16) & 0xffff;
  assert(
    (unixMode & UNIX_FILE_TYPE_MASK) !== UNIX_SYMBOLIC_LINK_TYPE,
    `ZIP entry is a symbolic link: ${entry.fileName}`,
  );
  assert(
    entry.externalFileAttributes === REGULAR_FILE_EXTERNAL_ATTRIBUTES,
    `ZIP entry mode must be exactly 100644: ${entry.fileName}`,
  );
  assert(
    Number.isSafeInteger(entry.uncompressedSize) && entry.uncompressedSize >= 0,
    `ZIP entry has an invalid uncompressed size: ${entry.fileName}`,
  );
  assert(
    entry.uncompressedSize <= ARCHIVE_LIMITS.maxEntryBytes,
    `ZIP entry exceeds the ${ARCHIVE_LIMITS.maxEntryBytes} byte member limit: ${entry.fileName}`,
  );
  totals.uncompressedBytes += entry.uncompressedSize;
  assert(
    totals.uncompressedBytes <= ARCHIVE_LIMITS.maxTotalUncompressedBytes,
    'ZIP archive exceeds its total uncompressed size limit',
  );
  if (entry.uncompressedSize > 0) {
    assert(entry.compressedSize > 0, `ZIP entry has an invalid compressed size: ${entry.fileName}`);
    assert(
      entry.uncompressedSize / entry.compressedSize <= ARCHIVE_LIMITS.maxCompressionRatio,
      `ZIP entry has a suspicious compression ratio: ${entry.fileName}`,
    );
  }
}

function findEndOfCentralDirectory(archive: Buffer): number {
  assert(
    archive.byteLength >= END_OF_CENTRAL_DIRECTORY_SIZE,
    'Packaged ZIP is too small to be an archive',
  );
  const lowestOffset: number = Math.max(
    0,
    archive.byteLength - END_OF_CENTRAL_DIRECTORY_SIZE - MAX_ARCHIVE_COMMENT_SIZE,
  );
  for (
    let offset: number = archive.byteLength - END_OF_CENTRAL_DIRECTORY_SIZE;
    offset >= lowestOffset;
    offset -= 1
  ) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return offset;
  }
  throw new Error('Packaged ZIP has no end-of-central-directory record');
}

export function parseArchiveEntries(archive: Buffer): ArchiveEntry[] {
  const endOffset: number = findEndOfCentralDirectory(archive);
  assert(
    archive.readUInt16LE(endOffset + 4) === 0 && archive.readUInt16LE(endOffset + 6) === 0,
    'Multi-disk ZIP archives are forbidden',
  );
  const entriesOnDisk: number = archive.readUInt16LE(endOffset + 8);
  const totalEntries: number = archive.readUInt16LE(endOffset + 10);
  const directorySize: number = archive.readUInt32LE(endOffset + 12);
  const directoryOffset: number = archive.readUInt32LE(endOffset + 16);
  // End-of-central-directory layout from `endOffset`: 0 signature, 4 this disk, 6 directory
  // start disk, 8 entries on this disk, 10 total entries, 12 directory size, 16 directory
  // offset, 20 comment length.
  const commentLength: number = archive.readUInt16LE(endOffset + 20);
  assert(entriesOnDisk === totalEntries, 'ZIP central directory spans multiple disks');
  assert(commentLength === 0, 'ZIP archive comment is forbidden');
  assert(
    endOffset + END_OF_CENTRAL_DIRECTORY_SIZE === archive.byteLength,
    'ZIP archive has trailing data after its end-of-central-directory record',
  );
  assert(
    totalEntries !== 0xffff && directorySize !== 0xffffffff && directoryOffset !== 0xffffffff,
    'ZIP64 archives are forbidden',
  );
  assert(
    directoryOffset + directorySize <= endOffset,
    'ZIP central directory extends past its own record',
  );

  const entries: ArchiveEntry[] = [];
  let offset: number = directoryOffset;
  for (let index: number = 0; index < totalEntries; index += 1) {
    assert(
      offset + CENTRAL_DIRECTORY_HEADER_SIZE <= directoryOffset + directorySize,
      'ZIP central directory header is truncated',
    );
    assert(
      archive.readUInt32LE(offset) === CENTRAL_DIRECTORY_SIGNATURE,
      'ZIP central directory header has a bad signature',
    );
    // Central directory header layout from `offset`: 0 signature, 8 general-purpose flags,
    // 10 compression method, 16 CRC-32, 20 compressed size, 24 uncompressed size, 28 name
    // length, 30 extra length, 32 comment length, 38 external attributes, 42 local offset,
    // 46 name bytes.
    const fileNameLength: number = archive.readUInt16LE(offset + 28);
    const extraFieldLength: number = archive.readUInt16LE(offset + 30);
    const fileCommentLength: number = archive.readUInt16LE(offset + 32);
    const nameStart: number = offset + CENTRAL_DIRECTORY_HEADER_SIZE;
    const nextOffset: number = nameStart + fileNameLength + extraFieldLength + fileCommentLength;
    assert(
      nextOffset <= directoryOffset + directorySize,
      'ZIP central directory entry is truncated',
    );
    assert(extraFieldLength === 0, 'ZIP entry extra fields are forbidden');
    assert(fileCommentLength === 0, 'ZIP entry comments are forbidden');
    entries.push({
      compressedSize: archive.readUInt32LE(offset + 20),
      compressionMethod: archive.readUInt16LE(offset + 10),
      crc32: archive.readUInt32LE(offset + 16),
      externalFileAttributes: archive.readUInt32LE(offset + 38),
      fileName: archive.toString('utf8', nameStart, nameStart + fileNameLength),
      generalPurposeBitFlag: archive.readUInt16LE(offset + 8),
      localHeaderOffset: archive.readUInt32LE(offset + 42),
      uncompressedSize: archive.readUInt32LE(offset + 24),
    });
    offset = nextOffset;
  }
  assert(
    offset === directoryOffset + directorySize,
    'ZIP central directory size does not match its entries',
  );
  return entries;
}

/**
 * Local file header layout from `offset`: 0 signature, 6 general-purpose flags, 8 compression
 * method, 14 CRC-32, 18 compressed size, 22 uncompressed size, 26 name length, 28 extra length,
 * 30 name bytes, then the extra field, then the compressed data.
 */
function readArchiveEntryContents(archive: Buffer, entry: ArchiveEntry): Buffer {
  const offset: number = entry.localHeaderOffset;
  assert(
    offset + LOCAL_FILE_HEADER_SIZE <= archive.byteLength,
    `ZIP local file header is truncated: ${entry.fileName}`,
  );
  assert(
    archive.readUInt32LE(offset) === LOCAL_FILE_HEADER_SIGNATURE,
    `ZIP local file header has a bad signature: ${entry.fileName}`,
  );
  assert(
    archive.readUInt16LE(offset + 6) === entry.generalPurposeBitFlag &&
      archive.readUInt16LE(offset + 8) === entry.compressionMethod &&
      archive.readUInt32LE(offset + 14) === entry.crc32 &&
      archive.readUInt32LE(offset + 18) === entry.compressedSize &&
      archive.readUInt32LE(offset + 22) === entry.uncompressedSize,
    `ZIP local file header does not match its directory entry: ${entry.fileName}`,
  );
  const fileNameLength: number = archive.readUInt16LE(offset + 26);
  const extraFieldLength: number = archive.readUInt16LE(offset + 28);
  const nameStart: number = offset + LOCAL_FILE_HEADER_SIZE;
  const dataStart: number = nameStart + fileNameLength + extraFieldLength;
  assert(
    dataStart + entry.compressedSize <= archive.byteLength,
    `ZIP entry data is truncated: ${entry.fileName}`,
  );
  assert(
    archive.toString('utf8', nameStart, nameStart + fileNameLength) === entry.fileName,
    `ZIP local file name does not match its directory entry: ${entry.fileName}`,
  );
  const compressed: Buffer = archive.subarray(dataStart, dataStart + entry.compressedSize);
  const contents: Buffer = inflateRawSync(compressed, {
    maxOutputLength: ARCHIVE_LIMITS.maxEntryBytes,
  });
  assert(
    contents.byteLength === entry.uncompressedSize,
    `ZIP entry size does not match its directory entry: ${entry.fileName}`,
  );
  assert(crc32(contents) === entry.crc32, `ZIP entry CRC-32 mismatch: ${entry.fileName}`);
  return contents;
}

export async function extractPackageArchive(
  archive: Buffer,
  destinationDirectory: string,
): Promise<string[]> {
  const entries: ArchiveEntry[] = parseArchiveEntries(archive);
  const seen: Set<string> = new Set<string>();
  const totals: ArchiveTotals = { entryCount: 0, uncompressedBytes: 0 };
  for (const entry of entries) admitArchiveEntry(entry, seen, totals);
  assert(seen.has('manifest.json'), 'Packaged ZIP has no manifest.json at its root');
  // Every member is inflated and checked before the first byte reaches the disk, so a bad
  // local header or a CRC mismatch leaves no half-populated directory behind.
  const destinationRoot: string = path.resolve(destinationDirectory);
  const pending: Array<{ targetPath: string; contents: Buffer }> = entries.map(
    (entry: ArchiveEntry): { targetPath: string; contents: Buffer } => {
      const targetPath: string = path.resolve(destinationRoot, entry.fileName);
      assert(
        targetPath.startsWith(`${destinationRoot}${path.sep}`),
        `ZIP entry escapes the extraction directory: ${entry.fileName}`,
      );
      return { targetPath, contents: readArchiveEntryContents(archive, entry) };
    },
  );
  for (const member of pending) {
    await mkdir(path.dirname(member.targetPath), { mode: 0o700, recursive: true });
    await writeFile(member.targetPath, member.contents, { flag: 'wx', mode: 0o600 });
  }
  return [...seen].sort();
}

export async function readPackageManifest(repositoryRoot: string): Promise<PackageManifest> {
  const manifestPath: string = path.join(repositoryRoot, PACKAGE_MANIFEST_RELATIVE_PATH);
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (error: unknown) {
    throw new Error(
      `${PACKAGE_MANIFEST_RELATIVE_PATH} is unreadable, so the packaged artifact cannot be installed. ${REBUILD_HINT} Cause: ${describeError(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new Error(
      `${PACKAGE_MANIFEST_RELATIVE_PATH} is not valid JSON. ${REBUILD_HINT} Cause: ${describeError(error)}`,
    );
  }
  assert(
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
    `${PACKAGE_MANIFEST_RELATIVE_PATH} must contain an object. ${REBUILD_HINT}`,
  );
  const candidate: Record<string, unknown> = parsed as Record<string, unknown>;
  const keys: string[] = Object.keys(candidate).sort();
  assert(
    keys.join(',') === 'sha256,version,zipPath',
    `${PACKAGE_MANIFEST_RELATIVE_PATH} must declare exactly sha256, version, and zipPath. Found: ${keys.join(', ')}`,
  );
  const version: unknown = candidate.version;
  const zipPath: unknown = candidate.zipPath;
  const sha256: unknown = candidate.sha256;
  assert(
    typeof version === 'string' && VERSION_PATTERN.test(version),
    `${PACKAGE_MANIFEST_RELATIVE_PATH} version must be a dotted numeric version`,
  );
  assert(
    typeof sha256 === 'string' && SHA256_PATTERN.test(sha256),
    `${PACKAGE_MANIFEST_RELATIVE_PATH} sha256 must be 64 lowercase hex characters`,
  );
  const expectedZipPath: string = `release/focus-lock-${version as string}.zip`;
  assert(
    zipPath === expectedZipPath,
    `${PACKAGE_MANIFEST_RELATIVE_PATH} zipPath must be ${expectedZipPath}`,
  );
  return {
    sha256: sha256 as string,
    version: version as string,
    zipPath: expectedZipPath,
  };
}

export async function readPackageArchive(
  repositoryRoot: string,
  manifest: PackageManifest,
): Promise<Buffer> {
  const zipPath: string = path.join(repositoryRoot, manifest.zipPath);
  let archive: Buffer;
  try {
    archive = await readFile(zipPath);
  } catch (error: unknown) {
    throw new Error(
      `${manifest.zipPath} is unreadable, so the packaged artifact cannot be installed. ${REBUILD_HINT} Cause: ${describeError(error)}`,
    );
  }
  assert(
    archive.byteLength <= ARCHIVE_LIMITS.maxArchiveBytes,
    `${manifest.zipPath} exceeds the ${ARCHIVE_LIMITS.maxArchiveBytes} byte archive limit`,
  );
  const digest: string = createHash('sha256').update(archive).digest('hex');
  assert(
    digest === manifest.sha256,
    `${manifest.zipPath} SHA-256 is ${digest} but ${PACKAGE_MANIFEST_RELATIVE_PATH} records ${manifest.sha256}. ${REBUILD_HINT}`,
  );
  return archive;
}
