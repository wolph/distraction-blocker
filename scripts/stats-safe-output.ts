import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';

const STAGING_PREFIX: string = '.stats-evidence-staging-';

export interface StatsEvidenceRun {
  approvedBoundaryRelativePath: string;
  repositoryRoot: string;
  stagingDirectory: string;
  targetDirectory: string;
  targetName: string;
}

export interface BeginStatsEvidenceRunInput {
  approvedBoundaryRelativePath: string;
  repositoryRoot: string;
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

async function validatePathFromRepositoryRoot(
  repositoryRoot: string,
  target: string,
  createMissing: boolean,
): Promise<void> {
  const resolvedBoundary: string = path.resolve(repositoryRoot);
  const resolvedTarget: string = path.resolve(target);
  const relative: string = path.relative(resolvedBoundary, resolvedTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Stats evidence target is outside its approved boundary.');
  }
  const segments: string[] = relative.split(path.sep).filter(Boolean);
  let candidate: string = resolvedBoundary;
  const boundaryMetadata = await lstat(candidate);
  if (boundaryMetadata.isSymbolicLink() || !boundaryMetadata.isDirectory()) {
    throw new Error('Stats evidence repository root must be a real directory.');
  }
  if ((await realpath(candidate)) !== candidate) {
    throw new Error('Stats evidence repository root must not be a symlink alias.');
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
        if (!createMissing) return;
        await mkdir(candidate);
        const created = await lstat(candidate);
        if (created.isSymbolicLink() || !created.isDirectory()) {
          throw new Error(`Stats evidence created ancestor is unsafe: ${candidate}.`);
        }
        continue;
      }
      throw error;
    }
  }
}

async function assertDirectoryResolvesExactly(
  repositoryRoot: string,
  directory: string,
  label: string,
): Promise<void> {
  await validatePathFromRepositoryRoot(repositoryRoot, directory, false);
  const realBoundary: string = await realpath(repositoryRoot);
  const relative: string = path.relative(path.resolve(repositoryRoot), path.resolve(directory));
  if ((await realpath(directory)) !== path.join(realBoundary, relative)) {
    throw new Error(`Stats evidence ${label} does not resolve to its approved real path.`);
  }
}

function assertApprovedTarget(input: BeginStatsEvidenceRunInput): {
  boundary: string;
  reportFile: string;
  repositoryRoot: string;
  target: string;
} {
  const repositoryRoot: string = path.resolve(input.repositoryRoot);
  if (
    path.isAbsolute(input.approvedBoundaryRelativePath) ||
    input.approvedBoundaryRelativePath.split(path.sep).includes('..')
  ) {
    throw new Error('Stats evidence boundary must be repository-relative.');
  }
  const boundary: string = path.join(repositoryRoot, input.approvedBoundaryRelativePath);
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
  return { boundary, reportFile: input.reportFile, repositoryRoot, target };
}

export async function beginStatsEvidenceRun(
  input: BeginStatsEvidenceRunInput,
): Promise<StatsEvidenceRun> {
  const validated = assertApprovedTarget(input);
  const parent: string = path.dirname(validated.target);
  await validatePathFromRepositoryRoot(validated.repositoryRoot, parent, true);
  await assertDirectoryResolvesExactly(validated.repositoryRoot, parent, 'target parent');
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
    approvedBoundaryRelativePath: input.approvedBoundaryRelativePath,
    repositoryRoot: validated.repositoryRoot,
    stagingDirectory,
    targetDirectory: validated.target,
    targetName: input.targetName,
  };
}

async function assertRunBoundary(run: StatsEvidenceRun): Promise<void> {
  if (
    path.join(
      path.resolve(run.repositoryRoot),
      run.approvedBoundaryRelativePath,
      run.targetName,
    ) !== path.resolve(run.targetDirectory) ||
    path.dirname(path.resolve(run.stagingDirectory)) !==
      path.dirname(path.resolve(run.targetDirectory)) ||
    !path.basename(run.stagingDirectory).startsWith(STAGING_PREFIX)
  ) {
    throw new Error('Stats evidence staging boundary is invalid.');
  }
  await assertDirectoryResolvesExactly(
    run.repositoryRoot,
    path.dirname(run.targetDirectory),
    'target parent',
  );
  const metadata = await lstat(run.stagingDirectory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Stats evidence staging path must be a real directory.');
  }
  await assertDirectoryResolvesExactly(
    run.repositoryRoot,
    run.stagingDirectory,
    'staging directory',
  );
}

export async function abandonStatsEvidenceRun(run: StatsEvidenceRun): Promise<void> {
  await assertRunBoundary(run);
  await rm(run.stagingDirectory, { recursive: true });
}

export async function cleanupFailedStatsEvidenceRun(
  run: StatsEvidenceRun,
  reportFile: string,
): Promise<void> {
  await assertDirectoryResolvesExactly(
    run.repositoryRoot,
    path.dirname(run.targetDirectory),
    'target parent',
  );
  if (await existingRealDirectory(run.targetDirectory)) {
    try {
      await unlink(path.join(run.targetDirectory, reportFile));
    } catch (error: unknown) {
      if (
        !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      ) {
        throw error;
      }
    }
  }
  try {
    const metadata = await lstat(run.stagingDirectory);
    if (metadata.isSymbolicLink()) {
      await unlink(run.stagingDirectory);
    } else {
      await abandonStatsEvidenceRun(run);
    }
  } catch (error: unknown) {
    if (
      !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
    ) {
      throw error;
    }
  }
}

export async function atomicallyReplaceStatsCuratedImage(input: {
  approvedRelativePath: string;
  repositoryRoot: string;
  sourceFile: string;
  targetFile: string;
}): Promise<void> {
  const expectedTarget: string = path.join(
    path.resolve(input.repositoryRoot),
    input.approvedRelativePath,
  );
  if (path.resolve(input.targetFile) !== expectedTarget) {
    throw new Error('Stats curated image target is not approved.');
  }
  const parent: string = path.dirname(expectedTarget);
  await validatePathFromRepositoryRoot(input.repositoryRoot, parent, false);
  await assertDirectoryResolvesExactly(input.repositoryRoot, parent, 'curated image parent');
  const temporary: string = `${expectedTarget}.staging-${randomUUID()}`;
  const backup: string = `${expectedTarget}.replaced-${randomUUID()}`;
  try {
    await copyFile(input.sourceFile, temporary);
    const targetExists: boolean = await existingRealDirectory(expectedTarget).catch(
      (): boolean => false,
    );
    let existingFile: boolean = false;
    try {
      const metadata = await lstat(expectedTarget);
      existingFile = metadata.isFile() && !metadata.isSymbolicLink();
      if (!existingFile) throw new Error('Stats curated image target must be a real file.');
    } catch (error: unknown) {
      if (
        !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      ) {
        throw error;
      }
    }
    if (targetExists) throw new Error('Stats curated image target must not be a directory.');
    if (existingFile) await rename(expectedTarget, backup);
    try {
      await rename(temporary, expectedTarget);
    } catch (error: unknown) {
      if (existingFile) await rename(backup, expectedTarget);
      throw error;
    }
    if (existingFile) await rm(backup);
  } finally {
    await rm(temporary, { force: true });
  }
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

export async function publishVerifiedStatsEvidenceRun(
  run: StatsEvidenceRun,
  reportFile: string,
  verify: (directory: string) => Promise<void>,
): Promise<void> {
  try {
    await verify(run.stagingDirectory);
    await publishStatsEvidenceRun(run);
    await verify(run.targetDirectory);
  } catch (error: unknown) {
    await cleanupFailedStatsEvidenceRun(run, reportFile);
    throw error;
  }
}
