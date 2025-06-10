import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_LIMITS,
  type ArchiveMember,
  parseArchiveListing,
  validateArchiveMembers,
} from '../../../docs/qa-artifacts/onboarding-task6/verify-lib.mjs';

interface TestManifest {
  artifactCount: number;
  artifacts: { bytes: number; path: string; sha256: string }[];
}

const manifest: TestManifest = {
  artifactCount: 1,
  artifacts: [{ bytes: 8, path: 'capture.png', sha256: 'unused-in-member-validation' }],
};

function validMembers(): ArchiveMember[] {
  return [
    { name: './', size: 0, type: 'directory' },
    { name: './manifest.json', size: 123, type: 'file' },
    { name: './capture.png', size: 8, type: 'file' },
  ];
}

describe('portable onboarding archive verifier', (): void => {
  it('parses member types and declared sizes from the tar listing', (): void => {
    const listing: string = [
      'drwx------ owner/group 0 2026-09-01 03:26 ./',
      '-rw-r--r-- owner/group 8 2026-09-01 03:26 ./capture.png',
      'lrwxr-xr-x owner/group 0 2026-09-01 03:26 ./link -> capture.png',
      'hrw-r--r-- owner/group 0 2026-09-01 03:26 ./hard link to ./capture.png',
      'prw-r--r-- owner/group 0 2026-09-01 03:26 ./pipe',
    ].join('\n');

    expect(parseArchiveListing(listing)).toEqual([
      { name: './', size: 0, type: 'directory' },
      { name: './capture.png', size: 8, type: 'file' },
      { name: './link -> capture.png', size: 0, type: 'symlink' },
      { name: './hard link to ./capture.png', size: 0, type: 'hardlink' },
      { name: './pipe', size: 0, type: 'fifo' },
    ]);
  });

  it('accepts only the exact flat regular-file set with declared sizes', (): void => {
    expect((): void => validateArchiveMembers(validMembers(), manifest, 123, 1_000)).not.toThrow();
  });

  it.each([
    ['symbolic link', { name: './capture.png', size: 8, type: 'symlink' }],
    ['hard link', { name: './capture.png', size: 8, type: 'hardlink' }],
    ['FIFO', { name: './capture.png', size: 8, type: 'fifo' }],
    ['block device', { name: './capture.png', size: 8, type: 'block-device' }],
    ['character device', { name: './capture.png', size: 8, type: 'character-device' }],
    ['socket', { name: './capture.png', size: 8, type: 'socket' }],
    ['other special member', { name: './capture.png', size: 8, type: 'special' }],
  ] as const)('rejects a %s before extraction', (_label: string, unsafe: ArchiveMember): void => {
    const members: ArchiveMember[] = validMembers();
    members[2] = unsafe;

    expect((): void => validateArchiveMembers(members, manifest, 123, 1_000)).toThrow(
      /unsupported archive member type/,
    );
  });

  it.each([
    ['unexpected member', { name: './extra.txt', size: 1, type: 'file' }],
    ['traversal member', { name: '../capture.png', size: 8, type: 'file' }],
  ] as const)('rejects an %s before extraction', (_label: string, unsafe: ArchiveMember): void => {
    expect((): void =>
      validateArchiveMembers([...validMembers(), unsafe], manifest, 123, 1_000),
    ).toThrow();
  });

  it('rejects duplicate members before extraction', (): void => {
    const duplicate: ArchiveMember = { name: './capture.png', size: 8, type: 'file' };
    expect((): void =>
      validateArchiveMembers([...validMembers(), duplicate], manifest, 123, 1_000),
    ).toThrow(/duplicate archive member/);
  });

  it('rejects a declared size that differs from the tracked manifest', (): void => {
    const members: ArchiveMember[] = validMembers();
    members[2] = { name: './capture.png', size: 7, type: 'file' };

    expect((): void => validateArchiveMembers(members, manifest, 123, 1_000)).toThrow(
      /member size is incorrect/,
    );
  });

  it.each([
    ['archive bytes', validMembers(), 123, ARCHIVE_LIMITS.maxArchiveBytes + 1],
    [
      'per-file bytes',
      [
        { name: './', size: 0, type: 'directory' },
        { name: './manifest.json', size: 123, type: 'file' },
        { name: './capture.png', size: ARCHIVE_LIMITS.maxFileBytes + 1, type: 'file' },
      ],
      123,
      1_000,
    ],
  ] as const)(
    'rejects oversized %s before extraction',
    (_label: string, members: readonly ArchiveMember[], manifestBytes: number, archiveBytes: number): void => {
      expect((): void =>
        validateArchiveMembers([...members], manifest, manifestBytes, archiveBytes),
      ).toThrow(/exceeds|size/);
    },
  );

  it('rejects too many members and excessive total expanded bytes', (): void => {
    const manyArtifacts: TestManifest = {
      artifactCount: ARCHIVE_LIMITS.maxMembers,
      artifacts: Array.from({ length: ARCHIVE_LIMITS.maxMembers }, (_value, index: number) => ({
        bytes: 1,
        path: `capture-${index}.png`,
        sha256: 'unused',
      })),
    };
    expect((): void => validateArchiveMembers(validMembers(), manyArtifacts, 123, 1_000)).toThrow(
      /member count/,
    );

    const expandedArtifactCount: number =
      Math.floor(ARCHIVE_LIMITS.maxTotalExpandedBytes / ARCHIVE_LIMITS.maxFileBytes) + 1;
    const expandedManifest: TestManifest = {
      artifactCount: expandedArtifactCount,
      artifacts: Array.from({ length: expandedArtifactCount }, (_value, index: number) => ({
        bytes: ARCHIVE_LIMITS.maxFileBytes,
        path: `capture-${index}.png`,
        sha256: 'unused',
      })),
    };
    const expandedMembers: ArchiveMember[] = [
      { name: './', size: 0, type: 'directory' },
      { name: './manifest.json', size: 123, type: 'file' },
      ...expandedManifest.artifacts.map(
        (artifact): ArchiveMember => ({
          name: `./${artifact.path}`,
          size: artifact.bytes,
          type: 'file',
        }),
      ),
    ];
    expect((): void =>
      validateArchiveMembers(expandedMembers, expandedManifest, 123, 1_000),
    ).toThrow(/expanded size exceeds/);
  });
});
