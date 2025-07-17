import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type * as Task7SafeOutputModule from './task7-safe-output';

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
const safeOutputModuleUrl: string = new URL('./task7-safe-output.ts', import.meta.url).href;
const { assertTask7OutputDirectorySafe, runTask7EvidenceBuild } = (await import(
  safeOutputModuleUrl
)) as typeof Task7SafeOutputModule;

function run(command: string, args: string[], repositoryRoot: string): void {
  const result: SpawnSyncReturns<Buffer> = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
  });
  if (result.status === 0) return;
  throw new Error(`${command} ${args.join(' ')} failed with exit ${String(result.status)}`);
}

const repositoryRoot: string = path.resolve(import.meta.dirname, '..');
if (process.argv.length !== 2) {
  throw new Error('Usage: node scripts/build-task7-evidence.ts');
}

const outputDirectory: string = await runTask7EvidenceBuild({
  repositoryRoot,
  runVite: async (claimedOutputDirectory: string): Promise<void> => {
    run('npm', ['run', 'gen-icons'], repositoryRoot);
    await assertTask7OutputDirectorySafe({
      outputDirectory: claimedOutputDirectory,
      repositoryRoot,
    });
    run('npx', ['vite', 'build', '--outDir', claimedOutputDirectory], repositoryRoot);
  },
});
const provenance = await createTask7BuildProvenance(repositoryRoot, outputDirectory);
await writeFile(
  path.join(outputDirectory, TASK7_PROVENANCE_FILE),
  `${JSON.stringify(provenance, null, 2)}\n`,
  'utf8',
);
console.log(JSON.stringify({ outputDirectory, provenance }, null, 2));
