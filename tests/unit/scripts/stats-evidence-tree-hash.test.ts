import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { statsEvidenceTarget } from '../../../scripts/hash-stats-evidence';
import type { StatsEvidenceTreeHash } from '../../../scripts/stats-evidence-tree-hash';
import {
  hashStatsEvidenceTree,
  serializeStatsEvidenceTree,
} from '../../../scripts/stats-evidence-tree-hash';

const fixtures: string[] = [];

afterEach(async (): Promise<void> => {
  await Promise.all(
    fixtures.splice(0).map(async (fixture: string): Promise<void> => {
      await rm(fixture, { force: true, recursive: true });
    }),
  );
});

async function fixture(): Promise<string> {
  const directory: string = await mkdtemp(path.join(tmpdir(), 'stats-tree-hash-'));
  fixtures.push(directory);
  await mkdir(path.join(directory, 'nested'));
  await writeFile(path.join(directory, 'z-last.txt'), 'spam');
  await writeFile(path.join(directory, 'nested', 'a-first.txt'), 'eggs\n');
  return directory;
}

describe('Stats evidence canonical tree hash', () => {
  it('hashes sorted evidence-relative POSIX filenames, file hashes, and byte sizes', async () => {
    const directory: string = await fixture();
    const firstHash: string = createHash('sha256').update('eggs\n').digest('hex');
    const lastHash: string = createHash('sha256').update('spam').digest('hex');
    const manifest: string = [
      JSON.stringify({ bytes: 5, file: 'nested/a-first.txt', sha256: firstHash }),
      JSON.stringify({ bytes: 4, file: 'z-last.txt', sha256: lastHash }),
      '',
    ].join('\n');

    const result: StatsEvidenceTreeHash = await hashStatsEvidenceTree(directory);

    expect(result.manifest).toBe(manifest);
    expect(result.sha256).toBe(createHash('sha256').update(manifest, 'utf8').digest('hex'));
    expect(serializeStatsEvidenceTree(result.entries)).toBe(manifest);
  });

  it('changes when file bytes or size change', async () => {
    const directory: string = await fixture();
    const before: StatsEvidenceTreeHash = await hashStatsEvidenceTree(directory);
    await writeFile(path.join(directory, 'z-last.txt'), 'spam and eggs');

    const after: StatsEvidenceTreeHash = await hashStatsEvidenceTree(directory);

    expect(after.sha256).not.toBe(before.sha256);
  });

  it('rejects symbolic links instead of hashing files outside the evidence tree', async () => {
    const directory: string = await fixture();
    await import('node:fs/promises').then(
      async ({ symlink }): Promise<void> =>
        await symlink(path.join(directory, 'z-last.txt'), path.join(directory, 'linked.txt')),
    );

    await expect(hashStatsEvidenceTree(directory)).rejects.toThrow(/symbolic link/i);
  });

  it('limits the CLI to the two fixed Stats evidence directories', () => {
    expect(statsEvidenceTarget('dev')).toBe('dev');
    expect(statsEvidenceTarget('production')).toBe('production');
    expect((): void => {
      statsEvidenceTarget('other');
    }).toThrow(/usage/i);
  });
});
