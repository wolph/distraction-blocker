import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface Task7EvidenceModule {
  createTask7BuildProvenance(
    repositoryRoot: string,
    extensionDist: string,
  ): Promise<Record<string, unknown>>;
  TASK7_PROVENANCE_FILE: string;
}

const evidenceModuleUrl: string = new URL('../tests/e2e/task7-evidence.ts', import.meta.url).href;
const { createTask7BuildProvenance, TASK7_PROVENANCE_FILE } = (await import(
  evidenceModuleUrl
)) as Task7EvidenceModule;

function run(command: string, args: string[], repositoryRoot: string): void {
  const result: SpawnSyncReturns<Buffer> = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
  });
  if (result.status === 0) return;
  throw new Error(`${command} ${args.join(' ')} failed with exit ${String(result.status)}`);
}

const repositoryRoot: string = path.resolve(import.meta.dirname, '..');
const outputArgument: string | undefined = process.argv[2];
if (outputArgument === undefined) {
  throw new Error('Usage: node scripts/build-task7-evidence.ts <isolated-output-directory>');
}
const outputDirectory: string = path.resolve(outputArgument);
if (outputDirectory === path.join(repositoryRoot, 'dist')) {
  throw new Error('Task 7 evidence build output must not be repository dist.');
}

await mkdir(outputDirectory, { recursive: true });
run('npm', ['run', 'gen-icons'], repositoryRoot);
run('npx', ['vite', 'build', '--outDir', outputDirectory, '--emptyOutDir'], repositoryRoot);
const provenance = await createTask7BuildProvenance(repositoryRoot, outputDirectory);
await writeFile(
  path.join(outputDirectory, TASK7_PROVENANCE_FILE),
  `${JSON.stringify(provenance, null, 2)}\n`,
  'utf8',
);
console.log(JSON.stringify({ outputDirectory, provenance }, null, 2));
