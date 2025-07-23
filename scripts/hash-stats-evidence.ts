import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as StatsEvidenceTreeHashModule from './stats-evidence-tree-hash';

const { hashStatsEvidenceTree } = (await import(
  new URL('./stats-evidence-tree-hash.ts', import.meta.url).href
)) as typeof StatsEvidenceTreeHashModule;

type StatsEvidenceTarget = 'dev' | 'production';

const REPOSITORY_ROOT: string = fileURLToPath(new URL('..', import.meta.url));

export function statsEvidenceTarget(value: string | undefined): StatsEvidenceTarget {
  if (value === 'dev' || value === 'production') return value;
  throw new Error('Usage: node scripts/hash-stats-evidence.ts <dev|production>');
}

export async function hashStatsEvidenceTarget(value: string | undefined): Promise<string> {
  const target: StatsEvidenceTarget = statsEvidenceTarget(value);
  const relativeDirectory: string = `artifacts/stats-task5/${target}`;
  const result: StatsEvidenceTreeHashModule.StatsEvidenceTreeHash = await hashStatsEvidenceTree(
    path.join(REPOSITORY_ROOT, relativeDirectory),
  );
  return JSON.stringify({
    directory: relativeDirectory,
    files: result.entries.length,
    sha256: result.sha256,
  });
}

async function main(): Promise<void> {
  process.stdout.write(`${await hashStatsEvidenceTarget(process.argv[2])}\n`);
}

const entrypoint: string | undefined = process.argv[1];
if (entrypoint !== undefined && path.resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  await main();
}
