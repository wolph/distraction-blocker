import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertTask7BuildProvenance,
  assertTask7ProductionInventoryParity,
  assertTask7ResolvedTheme,
  hashTask7Tree,
  parseTask7BuildProvenance,
  type Task7BuildProvenance,
} from '../../e2e/task7-evidence';

const temporaryDirectories: string[] = [];

afterEach(async (): Promise<void> => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory: string): Promise<void> => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory: string = await mkdtemp(path.join(tmpdir(), 'focus-lock-task7-unit-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('Task 7 theme resolution', () => {
  it('rejects an Auto-light case whose computed colors resolve dark', (): void => {
    expect((): void =>
      assertTask7ResolvedTheme(
        { backgroundColor: 'rgb(22, 26, 24)', color: 'rgb(232, 236, 233)', colorScheme: 'dark' },
        { colorScheme: 'light', id: 'auto-light', theme: 'auto' },
        'options',
      ),
    ).toThrow(/auto-light.*expected.*received/i);
  });

  it('accepts explicit Dark colors under light media', (): void => {
    expect((): void =>
      assertTask7ResolvedTheme(
        { backgroundColor: 'rgb(22, 26, 24)', color: 'rgb(232, 236, 233)', colorScheme: 'dark' },
        { colorScheme: 'light', id: 'dark-light-media', theme: 'dark' },
        'options',
      ),
    ).not.toThrow();
  });
});

describe('Task 7 build provenance', () => {
  it('rejects missing and malformed provenance fields', (): void => {
    expect((): Task7BuildProvenance => parseTask7BuildProvenance({ schemaVersion: 1 })).toThrow(
      /missing or invalid/i,
    );
    expect(
      (): Task7BuildProvenance =>
        parseTask7BuildProvenance({
          applicationSourceTreeSha256: 'a'.repeat(64),
          distTreeSha256: 'b'.repeat(64),
          gitCommit: 'c'.repeat(40),
          manifestSha256: 'not-a-sha',
          schemaVersion: 1,
        }),
    ).toThrow(/missing or invalid/i);
  });

  it('hashes path names and file bytes deterministically', async (): Promise<void> => {
    const directory: string = await temporaryDirectory();
    await mkdir(path.join(directory, 'nested'));
    await writeFile(path.join(directory, 'b.txt'), 'second');
    await writeFile(path.join(directory, 'nested', 'a.txt'), 'first');
    const before: string = await hashTask7Tree(directory);

    await writeFile(path.join(directory, 'nested', 'a.txt'), 'changed');

    expect(await hashTask7Tree(directory)).not.toBe(before);
  });

  it('rejects mutable repository dist and mismatched source or dist hashes', (): void => {
    const valid: Task7BuildProvenance = {
      applicationSourceTreeSha256: 'source',
      distTreeSha256: 'dist',
      gitCommit: '0123456789012345678901234567890123456789',
      manifestSha256: 'manifest',
      schemaVersion: 1,
    };
    expect((): void =>
      assertTask7BuildProvenance({
        after: valid,
        before: valid,
        currentApplicationSourceTreeSha256: 'source',
        currentGitCommit: valid.gitCommit,
        explicitDist: '/repo/dist',
        repositoryDist: '/repo/dist',
      }),
    ).toThrow(/isolated/i);
    expect((): void =>
      assertTask7BuildProvenance({
        after: valid,
        before: valid,
        currentApplicationSourceTreeSha256: 'different',
        currentGitCommit: valid.gitCommit,
        explicitDist: '/tmp/isolated-dist',
        repositoryDist: '/repo/dist',
      }),
    ).toThrow(/application source/i);
    expect((): void =>
      assertTask7BuildProvenance({
        after: { ...valid, distTreeSha256: 'mutated' },
        before: valid,
        currentApplicationSourceTreeSha256: 'source',
        currentGitCommit: valid.gitCommit,
        explicitDist: '/tmp/isolated-dist',
        repositoryDist: '/repo/dist',
      }),
    ).toThrow(/changed during/i);
    expect((): void =>
      assertTask7BuildProvenance({
        after: { ...valid, gitCommit: 'different' },
        before: valid,
        currentApplicationSourceTreeSha256: 'source',
        currentGitCommit: valid.gitCommit,
        explicitDist: '/tmp/isolated-dist',
        repositoryDist: '/repo/dist',
      }),
    ).toThrow(/changed during/i);
  });
});

describe('Task 7 manifest production parity', () => {
  it('rejects duplicate report entries even when the report count matches', (): void => {
    expect((): void =>
      assertTask7ProductionInventoryParity(
        ['a.png', 'b.png'],
        [{ file: 'a.png' }, { file: 'a.png' }],
      ),
    ).toThrow(/duplicate.*a\.png/i);
  });

  it('rejects a report set that differs from production files on disk', (): void => {
    expect((): void =>
      assertTask7ProductionInventoryParity(
        ['a.png', 'b.png'],
        [{ file: 'a.png' }, { file: 'c.png' }],
      ),
    ).toThrow(/missing.*b\.png.*unexpected.*c\.png/i);
  });
});
