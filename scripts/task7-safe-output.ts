import { chmod, lstat, mkdtemp, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TASK7_OUTPUT_PREFIX: string = 'focus-lock-task7-evidence-';

export interface Task7OutputBoundary {
  approvedTemporaryRoot?: string;
  repositoryRoot: string;
}

export interface Task7OutputValidation extends Task7OutputBoundary {
  outputDirectory: string;
}

export interface Task7EvidenceBuildInput extends Task7OutputBoundary {
  claimOutputDirectory?: () => Promise<string>;
  runVite(outputDirectory: string): Promise<void>;
}

function pathsOverlap(left: string, right: string): boolean {
  const relative: string = path.relative(left, right);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
}

async function resolvedDirectory(directory: string, label: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(directory);
  } catch {
    throw new Error(`Task 7 ${label} must be an existing real directory.`);
  }
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Task 7 ${label} must be a real directory, not a symlink alias.`);
  }
  return resolved;
}

export async function assertTask7OutputDirectorySafe(input: Task7OutputValidation): Promise<void> {
  const approvedTemporaryRoot: string = await resolvedDirectory(
    input.approvedTemporaryRoot ?? tmpdir(),
    'approved temporary root',
  );
  const repositoryRoot: string = await resolvedDirectory(input.repositoryRoot, 'repository root');
  if (
    pathsOverlap(approvedTemporaryRoot, repositoryRoot) ||
    pathsOverlap(repositoryRoot, approvedTemporaryRoot)
  ) {
    throw new Error('Task 7 approved temporary root must be isolated from the repository.');
  }

  const outputMetadata = await lstat(input.outputDirectory);
  if (outputMetadata.isSymbolicLink() || !outputMetadata.isDirectory()) {
    throw new Error('Task 7 output must be a real directory, not a symlink alias.');
  }
  const outputDirectory: string = await realpath(input.outputDirectory);
  if (path.dirname(outputDirectory) !== approvedTemporaryRoot) {
    throw new Error('Task 7 output must be a direct child of the approved temporary boundary.');
  }
  if (!path.basename(outputDirectory).startsWith(TASK7_OUTPUT_PREFIX)) {
    throw new Error('Task 7 output must be a uniquely claimed evidence directory.');
  }
  if (
    pathsOverlap(outputDirectory, repositoryRoot) ||
    pathsOverlap(repositoryRoot, outputDirectory)
  ) {
    throw new Error('Task 7 output must be isolated from the repository.');
  }
  if ((await readdir(outputDirectory)).length !== 0) {
    throw new Error('Task 7 output changed after claim and is no longer empty.');
  }
}

export async function claimTask7OutputDirectory(input: Task7OutputBoundary): Promise<string> {
  const approvedTemporaryRoot: string = await resolvedDirectory(
    input.approvedTemporaryRoot ?? tmpdir(),
    'approved temporary root',
  );
  const outputDirectory: string = await mkdtemp(
    path.join(approvedTemporaryRoot, TASK7_OUTPUT_PREFIX),
  );
  await chmod(outputDirectory, 0o700);
  await assertTask7OutputDirectorySafe({ ...input, outputDirectory });
  return outputDirectory;
}

export async function runTask7EvidenceBuild(input: Task7EvidenceBuildInput): Promise<string> {
  const outputDirectory: string =
    input.claimOutputDirectory === undefined
      ? await claimTask7OutputDirectory(input)
      : await input.claimOutputDirectory();
  await assertTask7OutputDirectorySafe({ ...input, outputDirectory });
  await input.runVite(outputDirectory);
  return outputDirectory;
}
