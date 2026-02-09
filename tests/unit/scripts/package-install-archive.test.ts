/**
 * Automated cover for the hand-rolled ZIP reader the packaged-install e2e spec depends on.
 * The spec reaches `parseArchiveEntries`, `readArchiveEntryContents` and the manifest reader
 * only along their happy path, so every rejection below was a branch nothing exercised.
 *
 * The archives are built here byte by byte rather than by a zip library, because a library
 * would only ever produce the shapes the parser already accepts.
 */
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ARCHIVE_LIMITS,
  type ArchiveEntry,
  type ArchiveTotals,
  admitArchiveEntry,
  DEFLATE_COMPRESSION_METHOD,
  extractPackageArchive,
  PACKAGE_MANIFEST_RELATIVE_PATH,
  parseArchiveEntries,
  REGULAR_FILE_EXTERNAL_ATTRIBUTES,
  readPackageArchive,
  readPackageManifest,
  UTF8_FILE_NAME_FLAG,
} from '../../e2e/package-install-archive';

interface Member {
  name: string;
  contents: Buffer;
  externalFileAttributes?: number;
  generalPurposeBitFlag?: number;
  compressionMethod?: number;
  extraField?: Buffer;
}

const MANIFEST_MEMBER: Member = {
  name: 'manifest.json',
  contents: Buffer.from('{"manifest_version":3}', 'utf8'),
};

/** One central-directory and local-header pair per member, in the layout the reader expects. */
function buildArchive(members: readonly Member[]): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset: number = 0;

  for (const member of members) {
    const name: Buffer = Buffer.from(member.name, 'utf8');
    const extra: Buffer = member.extraField ?? Buffer.alloc(0);
    const compressed: Buffer = deflateRawSync(member.contents);
    const flags: number = member.generalPurposeBitFlag ?? UTF8_FILE_NAME_FLAG;
    const method: number = member.compressionMethod ?? DEFLATE_COMPRESSION_METHOD;
    const checksum: number = crc32(member.contents);

    const local: Buffer = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(member.contents.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const header: Buffer = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(compressed.byteLength, 20);
    header.writeUInt32LE(member.contents.byteLength, 24);
    header.writeUInt16LE(name.byteLength, 28);
    header.writeUInt16LE(extra.byteLength, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt32LE(member.externalFileAttributes ?? REGULAR_FILE_EXTERNAL_ATTRIBUTES, 38);
    header.writeUInt32LE(offset, 42);
    directory.push(header, name, extra);

    offset += local.byteLength + name.byteLength + compressed.byteLength;
  }

  const localBytes: Buffer = Buffer.concat(locals);
  const directoryBytes: Buffer = Buffer.concat(directory);
  const end: Buffer = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directoryBytes.byteLength, 12);
  end.writeUInt32LE(localBytes.byteLength, 16);
  return Buffer.concat([localBytes, directoryBytes, end]);
}

function baselineEntry(overrides: Partial<ArchiveEntry> = {}): ArchiveEntry {
  return {
    compressedSize: 100,
    compressionMethod: DEFLATE_COMPRESSION_METHOD,
    crc32: 0,
    externalFileAttributes: REGULAR_FILE_EXTERNAL_ATTRIBUTES,
    fileName: 'manifest.json',
    generalPurposeBitFlag: UTF8_FILE_NAME_FLAG,
    localHeaderOffset: 0,
    uncompressedSize: 1_000,
    ...overrides,
  };
}

function freshTotals(): ArchiveTotals {
  return { entryCount: 0, uncompressedBytes: 0 };
}

let workspace: string = '';

beforeEach(async (): Promise<void> => {
  workspace = await mkdtemp(path.join(tmpdir(), 'focus-lock-archive-unit-'));
});

afterEach(async (): Promise<void> => {
  await rm(workspace, { force: true, recursive: true });
});

describe('parseArchiveEntries', (): void => {
  it('reads the central directory of a well-formed archive', (): void => {
    const entries: ArchiveEntry[] = parseArchiveEntries(
      buildArchive([MANIFEST_MEMBER, { name: 'assets/app.js', contents: Buffer.from('x=1') }]),
    );

    expect(entries.map((entry: ArchiveEntry): string => entry.fileName)).toEqual([
      'manifest.json',
      'assets/app.js',
    ]);
    expect(entries[0]?.compressionMethod).toBe(DEFLATE_COMPRESSION_METHOD);
    expect(entries[0]?.externalFileAttributes).toBe(REGULAR_FILE_EXTERNAL_ATTRIBUTES);
  });

  it('refuses a buffer too small to hold an end-of-central-directory record', (): void => {
    expect((): ArchiveEntry[] => parseArchiveEntries(Buffer.alloc(10))).toThrow(
      /too small to be an archive/,
    );
  });

  it('refuses a buffer with no end-of-central-directory signature', (): void => {
    expect((): ArchiveEntry[] => parseArchiveEntries(Buffer.alloc(64))).toThrow(
      /no end-of-central-directory record/,
    );
  });

  it('refuses trailing data after the end-of-central-directory record', (): void => {
    const archive: Buffer = Buffer.concat([
      buildArchive([MANIFEST_MEMBER]),
      Buffer.from('trailing'),
    ]);

    expect((): ArchiveEntry[] => parseArchiveEntries(archive)).toThrow(/trailing data/);
  });

  it('refuses an archive comment', (): void => {
    const archive: Buffer = buildArchive([MANIFEST_MEMBER]);
    archive.writeUInt16LE(4, archive.byteLength - 2);

    expect((): ArchiveEntry[] => parseArchiveEntries(archive)).toThrow(/comment is forbidden/);
  });

  it('refuses a multi-disk archive', (): void => {
    const archive: Buffer = buildArchive([MANIFEST_MEMBER]);
    archive.writeUInt16LE(1, archive.byteLength - 22 + 4);

    expect((): ArchiveEntry[] => parseArchiveEntries(archive)).toThrow(/Multi-disk/);
  });

  it('refuses a central directory whose header signature is wrong', (): void => {
    const archive: Buffer = buildArchive([MANIFEST_MEMBER]);
    const directoryOffset: number = archive.readUInt32LE(archive.byteLength - 22 + 16);
    archive.writeUInt32LE(0xdeadbeef, directoryOffset);

    expect((): ArchiveEntry[] => parseArchiveEntries(archive)).toThrow(/bad signature/);
  });

  it('refuses an entry carrying an extra field', (): void => {
    const archive: Buffer = buildArchive([
      { ...MANIFEST_MEMBER, extraField: Buffer.from([1, 2, 3, 4]) },
    ]);

    expect((): ArchiveEntry[] => parseArchiveEntries(archive)).toThrow(
      /extra fields are forbidden/,
    );
  });

  it('refuses a central directory that extends past its own record', (): void => {
    const archive: Buffer = buildArchive([MANIFEST_MEMBER]);
    archive.writeUInt32LE(0xffff, archive.byteLength - 22 + 12);

    expect((): ArchiveEntry[] => parseArchiveEntries(archive)).toThrow(/extends past its own/);
  });
});

describe('admitArchiveEntry', (): void => {
  it('accepts a regular deflated member and records it', (): void => {
    const seen: Set<string> = new Set<string>();
    const totals: ArchiveTotals = freshTotals();

    admitArchiveEntry(baselineEntry(), seen, totals);

    expect([...seen]).toEqual(['manifest.json']);
    expect(totals).toEqual({ entryCount: 1, uncompressedBytes: 1_000 });
  });

  it('refuses a second entry with the same name', (): void => {
    const seen: Set<string> = new Set<string>();
    const totals: ArchiveTotals = freshTotals();
    admitArchiveEntry(baselineEntry(), seen, totals);

    expect((): void => admitArchiveEntry(baselineEntry(), seen, totals)).toThrow(/Duplicate/);
  });

  it.each([
    ['../escape.json', /unsafe path component/],
    ['/etc/passwd', /absolute path/],
    ['c:/windows/system32', /absolute drive path/],
    ['assets\\app.js', /forward slashes/],
    ['assets/', /directory entries are forbidden/],
    ['', /empty name/],
  ])('refuses the unsafe name %s', (fileName: string, reason: RegExp): void => {
    expect((): void =>
      admitArchiveEntry(baselineEntry({ fileName }), new Set<string>(), freshTotals()),
    ).toThrow(reason);
  });

  it('refuses a symbolic link before it refuses its mode', (): void => {
    const symlink: number = ((0o120777 << 16) >>> 0) as number;

    expect((): void =>
      admitArchiveEntry(
        baselineEntry({ externalFileAttributes: symlink }),
        new Set<string>(),
        freshTotals(),
      ),
    ).toThrow(/symbolic link/);
  });

  it('refuses a stored member, a foreign flag, and a wrong mode', (): void => {
    const cases: ReadonlyArray<readonly [Partial<ArchiveEntry>, RegExp]> = [
      [{ compressionMethod: 0 }, /generator compression method/],
      [{ generalPurposeBitFlag: 0 }, /non-generator general-purpose flags/],
      [{ externalFileAttributes: (0o100755 << 16) >>> 0 }, /mode must be exactly 100644/],
    ];

    for (const [overrides, reason] of cases) {
      expect((): void =>
        admitArchiveEntry(baselineEntry(overrides), new Set<string>(), freshTotals()),
      ).toThrow(reason);
    }
  });

  it('refuses a member over the per-entry limit and a suspicious ratio', (): void => {
    expect((): void =>
      admitArchiveEntry(
        baselineEntry({ uncompressedSize: ARCHIVE_LIMITS.maxEntryBytes + 1 }),
        new Set<string>(),
        freshTotals(),
      ),
    ).toThrow(/byte member limit/);
    expect((): void =>
      admitArchiveEntry(
        baselineEntry({ compressedSize: 1, uncompressedSize: 1_000_000 }),
        new Set<string>(),
        freshTotals(),
      ),
    ).toThrow(/suspicious compression ratio/);
  });
});

describe('extractPackageArchive', (): void => {
  it('writes every member and reports the sorted inventory', async (): Promise<void> => {
    const archive: Buffer = buildArchive([
      MANIFEST_MEMBER,
      { name: 'assets/app.js', contents: Buffer.from('x=1') },
    ]);
    const destination: string = path.join(workspace, 'out');

    const names: string[] = await extractPackageArchive(archive, destination);

    expect(names).toEqual(['assets/app.js', 'manifest.json']);
    expect(await readFile(path.join(destination, 'manifest.json'), 'utf8')).toBe(
      '{"manifest_version":3}',
    );
  });

  it('refuses an archive with no manifest at its root', async (): Promise<void> => {
    const archive: Buffer = buildArchive([{ name: 'assets/app.js', contents: Buffer.from('x=1') }]);

    await expect(extractPackageArchive(archive, path.join(workspace, 'out'))).rejects.toThrow(
      /no manifest.json at its root/,
    );
  });

  it('writes nothing when a later member fails its local header check', async (): Promise<void> => {
    // The failure is planted in the second member's local header, so the first member would
    // already be on disk under a write-as-you-go loop.
    const archive: Buffer = buildArchive([
      MANIFEST_MEMBER,
      { name: 'assets/app.js', contents: Buffer.from('x=1') },
    ]);
    const entries: ArchiveEntry[] = parseArchiveEntries(archive);
    const secondOffset: number = entries[1]?.localHeaderOffset ?? 0;
    archive.writeUInt32LE(0xdeadbeef, secondOffset);
    const destination: string = path.join(workspace, 'out');

    await expect(extractPackageArchive(archive, destination)).rejects.toThrow(/bad signature/);
    await expect(readdir(destination)).rejects.toThrow();
  });

  it('refuses a member whose contents do not match its recorded CRC-32', async (): Promise<void> => {
    const archive: Buffer = buildArchive([MANIFEST_MEMBER]);
    const entries: ArchiveEntry[] = parseArchiveEntries(archive);
    const localOffset: number = entries[0]?.localHeaderOffset ?? 0;
    const directoryOffset: number = archive.readUInt32LE(archive.byteLength - 22 + 16);
    archive.writeUInt32LE(0x1234abcd, localOffset + 14);
    archive.writeUInt32LE(0x1234abcd, directoryOffset + 16);

    await expect(extractPackageArchive(archive, path.join(workspace, 'out'))).rejects.toThrow(
      /CRC-32 mismatch/,
    );
  });
});

describe('readPackageManifest', (): void => {
  async function writeManifest(body: string): Promise<void> {
    const manifestPath: string = path.join(workspace, PACKAGE_MANIFEST_RELATIVE_PATH);
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, body, 'utf8');
  }

  const VALID_SHA: string = 'a'.repeat(64);

  it('reads a well-formed manifest', async (): Promise<void> => {
    await writeManifest(
      JSON.stringify({
        sha256: VALID_SHA,
        version: '1.2.3',
        zipPath: 'release/focus-lock-1.2.3.zip',
      }),
    );

    await expect(readPackageManifest(workspace)).resolves.toEqual({
      sha256: VALID_SHA,
      version: '1.2.3',
      zipPath: 'release/focus-lock-1.2.3.zip',
    });
  });

  it('reports an unreadable manifest with the rebuild hint', async (): Promise<void> => {
    await expect(readPackageManifest(workspace)).rejects.toThrow(
      /is unreadable[\s\S]*npm run store:package/,
    );
  });

  it('reports invalid JSON, a non-object, and an unexpected key set', async (): Promise<void> => {
    await writeManifest('{');
    await expect(readPackageManifest(workspace)).rejects.toThrow(/not valid JSON/);

    await writeManifest('[]');
    await expect(readPackageManifest(workspace)).rejects.toThrow(/must contain an object/);

    await writeManifest(JSON.stringify({ sha256: VALID_SHA, version: '1.2.3' }));
    await expect(readPackageManifest(workspace)).rejects.toThrow(/must declare exactly/);
  });

  it('reports a bad version, a bad digest, and a mismatched zip path', async (): Promise<void> => {
    await writeManifest(
      JSON.stringify({ sha256: VALID_SHA, version: 'v1', zipPath: 'release/focus-lock-v1.zip' }),
    );
    await expect(readPackageManifest(workspace)).rejects.toThrow(/dotted numeric version/);

    await writeManifest(
      JSON.stringify({ sha256: 'nope', version: '1.2.3', zipPath: 'release/focus-lock-1.2.3.zip' }),
    );
    await expect(readPackageManifest(workspace)).rejects.toThrow(/64 lowercase hex/);

    await writeManifest(
      JSON.stringify({ sha256: VALID_SHA, version: '1.2.3', zipPath: 'release/other.zip' }),
    );
    await expect(readPackageManifest(workspace)).rejects.toThrow(/zipPath must be/);
  });
});

describe('readPackageArchive', (): void => {
  it('refuses an archive whose digest is not the one the manifest records', async (): Promise<void> => {
    const zipPath: string = path.join(workspace, 'release', 'focus-lock-1.2.3.zip');
    await mkdir(path.dirname(zipPath), { recursive: true });
    await writeFile(zipPath, buildArchive([MANIFEST_MEMBER]));

    await expect(
      readPackageArchive(workspace, {
        sha256: 'b'.repeat(64),
        version: '1.2.3',
        zipPath: 'release/focus-lock-1.2.3.zip',
      }),
    ).rejects.toThrow(/SHA-256 is/);
  });

  it('reports an unreadable archive with the rebuild hint', async (): Promise<void> => {
    await expect(
      readPackageArchive(workspace, {
        sha256: 'b'.repeat(64),
        version: '1.2.3',
        zipPath: 'release/focus-lock-1.2.3.zip',
      }),
    ).rejects.toThrow(/is unreadable[\s\S]*npm run store:package/);
  });
});
