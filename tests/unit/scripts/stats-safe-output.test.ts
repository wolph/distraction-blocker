import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  abandonStatsEvidenceRun,
  atomicallyReplaceStatsCuratedImage,
  beginStatsEvidenceRun,
  cleanupFailedStatsEvidenceRun,
  publishStatsEvidenceRun,
  publishVerifiedStatsEvidenceRun,
} from '../../../scripts/stats-safe-output';

const fixtures: string[] = [];

afterEach(async (): Promise<void> => {
  await Promise.all(
    fixtures.splice(0).map(async (fixture: string): Promise<void> => {
      await rm(fixture, { force: true, recursive: true });
    }),
  );
});

async function fixture(): Promise<{ approved: string; root: string }> {
  const root: string = await realpath(await mkdtemp(path.join(tmpdir(), 'stats-safe-output-')));
  fixtures.push(root);
  const approved: string = path.join(root, 'artifacts', 'dev');
  await mkdir(path.dirname(approved), { recursive: true });
  return { approved, root };
}

describe('Stats evidence output safety', () => {
  it('claims a unique empty staging directory and invalidates the old success report', async () => {
    const current = await fixture();
    await mkdir(current.approved, { recursive: true });
    await writeFile(path.join(current.approved, 'keep.png'), 'old evidence');
    await writeFile(path.join(current.approved, 'stats-dev-run-report.json'), 'old report');

    const run = await beginStatsEvidenceRun({
      approvedBoundaryRelativePath: 'artifacts',
      repositoryRoot: current.root,
      reportFile: 'stats-dev-run-report.json',
      targetDirectory: current.approved,
      targetName: path.basename(current.approved),
    });

    expect(path.dirname(run.stagingDirectory)).toBe(path.dirname(current.approved));
    await expect(readFile(path.join(current.approved, 'keep.png'), 'utf8')).resolves.toBe(
      'old evidence',
    );
    await expect(
      readFile(path.join(current.approved, 'stats-dev-run-report.json')),
    ).rejects.toThrow();
    await abandonStatsEvidenceRun(run);
  });

  it('publishes the staged set without mixing obsolete target files', async () => {
    const current = await fixture();
    await mkdir(current.approved, { recursive: true });
    await writeFile(path.join(current.approved, 'stale.png'), 'stale');
    const run = await beginStatsEvidenceRun({
      approvedBoundaryRelativePath: 'artifacts',
      repositoryRoot: current.root,
      reportFile: 'stats-dev-run-report.json',
      targetDirectory: current.approved,
      targetName: path.basename(current.approved),
    });
    await writeFile(path.join(run.stagingDirectory, 'fresh.png'), 'fresh');
    await publishStatsEvidenceRun(run);

    await expect(readFile(path.join(current.approved, 'fresh.png'), 'utf8')).resolves.toBe('fresh');
    await expect(readFile(path.join(current.approved, 'stale.png'))).rejects.toThrow();
  });

  it('rejects unapproved paths and symlink targets without changing their contents', async () => {
    const current = await fixture();
    const realTarget: string = path.join(current.root, 'real-target');
    const alias: string = current.approved;
    await mkdir(path.dirname(alias), { recursive: true });
    await mkdir(realTarget);
    await writeFile(path.join(realTarget, 'keep.txt'), 'keep');
    await symlink(realTarget, alias, 'dir');

    await expect(
      beginStatsEvidenceRun({
        approvedBoundaryRelativePath: 'artifacts',
        repositoryRoot: current.root,
        reportFile: 'stats-dev-run-report.json',
        targetDirectory: alias,
        targetName: path.basename(alias),
      }),
    ).rejects.toThrow(/symlink|real directory/i);
    await expect(readFile(path.join(realTarget, 'keep.txt'), 'utf8')).resolves.toBe('keep');
    await expect(
      beginStatsEvidenceRun({
        approvedBoundaryRelativePath: 'artifacts',
        repositoryRoot: current.root,
        reportFile: 'stats-dev-run-report.json',
        targetDirectory: realTarget,
        targetName: path.basename(alias),
      }),
    ).rejects.toThrow(/approved/i);
  });

  it('rejects a symlinked target ancestor before invalidating or staging output', async () => {
    const current = await fixture();
    const realParent: string = path.join(current.root, 'real-parent');
    const aliasParent: string = path.join(current.root, 'alias-parent');
    await mkdir(path.join(realParent, 'dev'), { recursive: true });
    await writeFile(path.join(realParent, 'dev', 'stats-dev-run-report.json'), 'keep');
    await symlink(realParent, aliasParent, 'dir');
    const aliasedTarget: string = path.join(aliasParent, 'dev');

    await expect(
      beginStatsEvidenceRun({
        approvedBoundaryRelativePath: 'alias-parent',
        repositoryRoot: current.root,
        reportFile: 'stats-dev-run-report.json',
        targetDirectory: aliasedTarget,
        targetName: 'dev',
      }),
    ).rejects.toThrow(/ancestor|boundary|symlink|real path/i);
    await expect(
      readFile(path.join(realParent, 'dev', 'stats-dev-run-report.json'), 'utf8'),
    ).resolves.toBe('keep');
  });

  it('rejects a post-claim staging swap before publish or cleanup', async () => {
    const current = await fixture();
    const run = await beginStatsEvidenceRun({
      approvedBoundaryRelativePath: 'artifacts',
      repositoryRoot: current.root,
      reportFile: 'stats-dev-run-report.json',
      targetDirectory: current.approved,
      targetName: path.basename(current.approved),
    });
    const attackerDirectory: string = path.join(current.root, 'attacker');
    await mkdir(attackerDirectory);
    await rm(run.stagingDirectory, { recursive: true });
    await symlink(attackerDirectory, run.stagingDirectory, 'dir');

    await expect(publishStatsEvidenceRun(run)).rejects.toThrow(/staging|symlink|real directory/i);
    await expect(abandonStatsEvidenceRun(run)).rejects.toThrow(/staging|symlink|real directory/i);
  });

  it('creates a clean-clone boundary only through real repository descendants', async () => {
    const current = await fixture();
    await rm(path.join(current.root, 'artifacts'), { recursive: true });
    const run = await beginStatsEvidenceRun({
      approvedBoundaryRelativePath: 'artifacts/stats-task5',
      repositoryRoot: current.root,
      reportFile: 'stats-dev-run-report.json',
      targetDirectory: path.join(current.root, 'artifacts/stats-task5/dev'),
      targetName: 'dev',
    });
    expect(run.stagingDirectory).toContain(path.join('artifacts', 'stats-task5'));
    await abandonStatsEvidenceRun(run);
  });

  it('removes staging and invalidates a report after post-publish validation fails', async () => {
    const current = await fixture();
    const run = await beginStatsEvidenceRun({
      approvedBoundaryRelativePath: 'artifacts',
      repositoryRoot: current.root,
      reportFile: 'stats-dev-run-report.json',
      targetDirectory: current.approved,
      targetName: 'dev',
    });
    await writeFile(path.join(run.stagingDirectory, 'stats-dev-run-report.json'), 'invalid');
    await publishStatsEvidenceRun(run);
    await cleanupFailedStatsEvidenceRun(run, 'stats-dev-run-report.json');
    await expect(
      readFile(path.join(current.approved, 'stats-dev-run-report.json')),
    ).rejects.toThrow();
    await expect(readFile(run.stagingDirectory)).rejects.toThrow();
  });

  it('keeps the curated image unchanged when its staged copy fails', async () => {
    const current = await fixture();
    const targetFile: string = path.join(current.root, 'docs', 'stats.png');
    await mkdir(path.dirname(targetFile));
    await writeFile(targetFile, 'old');
    await expect(
      atomicallyReplaceStatsCuratedImage({
        approvedRelativePath: 'docs/stats.png',
        repositoryRoot: current.root,
        sourceFile: path.join(current.root, 'missing.png'),
        targetFile,
      }),
    ).rejects.toThrow();
    await expect(readFile(targetFile, 'utf8')).resolves.toBe('old');
  });

  it('invalidates the report when a PNG changes after prepublish verification', async () => {
    const current = await fixture();
    const reportFile: string = 'stats-dev-run-report.json';
    const run = await beginStatsEvidenceRun({
      approvedBoundaryRelativePath: 'artifacts',
      repositoryRoot: current.root,
      reportFile,
      targetDirectory: current.approved,
      targetName: 'dev',
    });
    await writeFile(path.join(run.stagingDirectory, reportFile), 'certified');
    await writeFile(path.join(run.stagingDirectory, 'capture.png'), 'valid');
    let verificationCount: number = 0;
    await expect(
      publishVerifiedStatsEvidenceRun(run, reportFile, async (directory: string): Promise<void> => {
        verificationCount += 1;
        if (verificationCount === 2) {
          await writeFile(path.join(directory, 'capture.png'), 'mutated');
          throw new Error('post-publish PNG hash mismatch');
        }
      }),
    ).rejects.toThrow(/PNG hash mismatch/i);
    expect(verificationCount).toBe(2);
    await expect(readFile(path.join(current.approved, reportFile))).rejects.toThrow();
  });
});
