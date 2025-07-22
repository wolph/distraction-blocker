import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, realpath, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';

const STAGING_PREFIX: string = '.stats-evidence-staging-';

export interface StatsEvidenceRun {
  approvedBoundaryDirectory: string;
  stagingDirectory: string;
  targetDirectory: string;
  targetName: string;
}

export interface BeginStatsEvidenceRunInput {
  approvedBoundaryDirectory: string;
  reportFile: string;
  targetDirectory: string;
  targetName: string;
}

async function existingRealDirectory(directory: string): Promise<boolean> {
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('Stats evidence target must be a real directory, not a symlink alias.');
    }
    return true;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function assertExistingAncestorsReal(boundary: string, target: string): Promise<void> {
  const resolvedBoundary: string = path.resolve(boundary);
  const resolvedTarget: string = path.resolve(target);
  const relative: string = path.relative(resolvedBoundary, resolvedTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Stats evidence target is outside its approved boundary.');
  }
  const segments: string[] = relative.split(path.sep).filter(Boolean);
  let candidate: string = resolvedBoundary;
  const boundaryMetadata = await lstat(candidate);
  if (boundaryMetadata.isSymbolicLink() || !boundaryMetadata.isDirectory()) {
    throw new Error('Stats evidence approved boundary must be a real directory.');
  }
  for (const segment of segments) {
    candidate = path.join(candidate, segment);
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Stats evidence ancestor is a symlink alias: ${candidate}.`);
      }
      if (!metadata.isDirectory() && candidate !== resolvedTarget) {
        throw new Error(`Stats evidence ancestor is not a real directory: ${candidate}.`);
      }
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return;
      }
      throw error;
    }
  }
}

async function assertDirectoryResolvesExactly(
  boundary: string,
  directory: string,
  label: string,
): Promise<void> {
  await assertExistingAncestorsReal(boundary, directory);
  const realBoundary: string = await realpath(boundary);
  const relative: string = path.relative(path.resolve(boundary), path.resolve(directory));
  if ((await realpath(directory)) !== path.join(realBoundary, relative)) {
    throw new Error(`Stats evidence ${label} does not resolve to its approved real path.`);
  }
}

function assertApprovedTarget(input: BeginStatsEvidenceRunInput): {
  boundary: string;
  reportFile: string;
  target: string;
} {
  const boundary: string = path.resolve(input.approvedBoundaryDirectory);
  if (path.basename(input.targetName) !== input.targetName || input.targetName.length === 0) {
    throw new Error('Stats evidence target name must be one approved directory basename.');
  }
  const approved: string = path.join(boundary, input.targetName);
  const target: string = path.resolve(input.targetDirectory);
  if (approved !== target) {
    throw new Error(`Stats evidence target is not the approved directory ${approved}.`);
  }
  if (path.basename(input.reportFile) !== input.reportFile || !input.reportFile.endsWith('.json')) {
    throw new Error('Stats evidence report filename must be one JSON basename.');
  }
  return { boundary, reportFile: input.reportFile, target };
}

export async function beginStatsEvidenceRun(
  input: BeginStatsEvidenceRunInput,
): Promise<StatsEvidenceRun> {
  const validated = assertApprovedTarget(input);
  const parent: string = path.dirname(validated.target);
  await assertExistingAncestorsReal(validated.boundary, parent);
  await assertDirectoryResolvesExactly(validated.boundary, parent, 'target parent');
  if (await existingRealDirectory(validated.target)) {
    try {
      await unlink(path.join(validated.target, validated.reportFile));
    } catch (error: unknown) {
      if (
        !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      ) {
        throw error;
      }
    }
  }
  const stagingDirectory: string = await mkdtemp(path.join(parent, STAGING_PREFIX));
  return {
    approvedBoundaryDirectory: validated.boundary,
    stagingDirectory,
    targetDirectory: validated.target,
    targetName: input.targetName,
  };
}

async function assertRunBoundary(run: StatsEvidenceRun): Promise<void> {
  if (
    path.join(path.resolve(run.approvedBoundaryDirectory), run.targetName) !==
      path.resolve(run.targetDirectory) ||
    path.dirname(path.resolve(run.stagingDirectory)) !==
      path.dirname(path.resolve(run.targetDirectory)) ||
    !path.basename(run.stagingDirectory).startsWith(STAGING_PREFIX)
  ) {
    throw new Error('Stats evidence staging boundary is invalid.');
  }
  await assertDirectoryResolvesExactly(
    run.approvedBoundaryDirectory,
    path.dirname(run.targetDirectory),
    'target parent',
  );
  const metadata = await lstat(run.stagingDirectory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Stats evidence staging path must be a real directory.');
  }
  await assertDirectoryResolvesExactly(
    run.approvedBoundaryDirectory,
    run.stagingDirectory,
    'staging directory',
  );
}

export async function abandonStatsEvidenceRun(run: StatsEvidenceRun): Promise<void> {
  await assertRunBoundary(run);
  await rm(run.stagingDirectory, { recursive: true });
}

export async function publishStatsEvidenceRun(run: StatsEvidenceRun): Promise<void> {
  await assertRunBoundary(run);
  const targetExists: boolean = await existingRealDirectory(run.targetDirectory);
  if (!targetExists) {
    await rename(run.stagingDirectory, run.targetDirectory);
    return;
  }
  const backup: string = `${run.targetDirectory}.replaced-${randomUUID()}`;
  await rename(run.targetDirectory, backup);
  try {
    await rename(run.stagingDirectory, run.targetDirectory);
  } catch (error: unknown) {
    await rename(backup, run.targetDirectory);
    throw error;
  }
  await rm(backup, { recursive: true });
}
