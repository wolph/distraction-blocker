import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertTask7OutputDirectorySafe,
  claimTask7OutputDirectory,
  runTask7EvidenceBuild,
} from '../../../scripts/task7-safe-output';

const fixtures: string[] = [];

afterEach(async (): Promise<void> => {
  await Promise.all(
    fixtures.splice(0).map(async (fixture: string): Promise<void> => {
      await rm(fixture, { force: true, recursive: true });
    }),
  );
});

async function isolatedFixture(): Promise<{
  approvedTemporaryRoot: string;
  fakeHome: string;
  fixtureRoot: string;
  repositoryRoot: string;
}> {
  const fixtureRoot: string = await mkdtemp(path.join(tmpdir(), 'focus-lock-task7-safe-output-'));
  fixtures.push(fixtureRoot);
  const approvedTemporaryRoot: string = path.join(fixtureRoot, 'approved-temp');
  const fakeHome: string = path.join(fixtureRoot, 'fake-home');
  const repositoryRoot: string = path.join(fixtureRoot, 'checkout', 'repository');
  await Promise.all([
    mkdir(approvedTemporaryRoot),
    mkdir(fakeHome),
    mkdir(path.join(repositoryRoot, 'dist'), { recursive: true }),
  ]);
  return { approvedTemporaryRoot, fakeHome, fixtureRoot, repositoryRoot };
}

describe('Task 7 evidence build output safety', () => {
  it('rejects every caller-owned or destructive path before Vite runs', async (): Promise<void> => {
    const fixture = await isolatedFixture();
    const populatedDirectory: string = path.join(
      fixture.approvedTemporaryRoot,
      'focus-lock-task7-evidence-has-content',
    );
    const outsideBoundary: string = path.join(fixture.fixtureRoot, 'outside-approved-temp');
    const safeTarget: string = path.join(fixture.approvedTemporaryRoot, 'safe-target');
    const symlinkAlias: string = path.join(fixture.approvedTemporaryRoot, 'symlink-alias');
    await Promise.all([mkdir(populatedDirectory), mkdir(outsideBoundary), mkdir(safeTarget)]);
    await writeFile(path.join(populatedDirectory, 'keep.txt'), 'must survive');
    await symlink(safeTarget, symlinkAlias, 'dir');

    const candidates: Readonly<Record<string, string>> = {
      'existing non-empty directory': populatedDirectory,
      'fake filesystem root': fixture.fixtureRoot,
      'fake user home': fixture.fakeHome,
      'outside approved temp boundary': outsideBoundary,
      'repository dist': path.join(fixture.repositoryRoot, 'dist'),
      'repository parent': path.dirname(fixture.repositoryRoot),
      'repository root': fixture.repositoryRoot,
      'symlink alias': symlinkAlias,
    };

    for (const [label, candidate] of Object.entries(candidates)) {
      const runVite = vi.fn<(outputDirectory: string) => Promise<void>>();
      await expect(
        runTask7EvidenceBuild({
          approvedTemporaryRoot: fixture.approvedTemporaryRoot,
          claimOutputDirectory: async (): Promise<string> => candidate,
          repositoryRoot: fixture.repositoryRoot,
          runVite,
        }),
        label,
      ).rejects.toThrow(/safe|isolated|empty|symlink|boundary|uniquely claimed/i);
      expect(runVite, label).not.toHaveBeenCalled();
    }
    expect(await readFile(path.join(populatedDirectory, 'keep.txt'), 'utf8')).toBe('must survive');
  });

  it('atomically claims a unique empty directory beneath the approved temp root', async (): Promise<void> => {
    const fixture = await isolatedFixture();
    const first: string = await claimTask7OutputDirectory({
      approvedTemporaryRoot: fixture.approvedTemporaryRoot,
      repositoryRoot: fixture.repositoryRoot,
    });
    const second: string = await claimTask7OutputDirectory({
      approvedTemporaryRoot: fixture.approvedTemporaryRoot,
      repositoryRoot: fixture.repositoryRoot,
    });

    expect(first).not.toBe(second);
    await expect(
      assertTask7OutputDirectorySafe({
        approvedTemporaryRoot: fixture.approvedTemporaryRoot,
        outputDirectory: first,
        repositoryRoot: fixture.repositoryRoot,
      }),
    ).resolves.toBeUndefined();
  });

  it('fails closed when claimed output changes before the command boundary', async (): Promise<void> => {
    const fixture = await isolatedFixture();
    const claimed: string = await claimTask7OutputDirectory({
      approvedTemporaryRoot: fixture.approvedTemporaryRoot,
      repositoryRoot: fixture.repositoryRoot,
    });
    const runVite = vi.fn<(outputDirectory: string) => Promise<void>>();

    await expect(
      runTask7EvidenceBuild({
        approvedTemporaryRoot: fixture.approvedTemporaryRoot,
        claimOutputDirectory: async (): Promise<string> => {
          await writeFile(path.join(claimed, 'raced.txt'), 'unexpected');
          return claimed;
        },
        repositoryRoot: fixture.repositoryRoot,
        runVite,
      }),
    ).rejects.toThrow(/empty|changed|race/i);
    expect(runVite).not.toHaveBeenCalled();
  });
});
