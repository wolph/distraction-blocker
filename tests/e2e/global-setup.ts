import path from 'node:path';
import { abandonStatsEvidenceRun, beginStatsEvidenceRun } from '../../scripts/stats-safe-output';

export default async function globalSetup(): Promise<void> {
  const requestedDirectory: string | undefined = process.env.STATS_EVIDENCE_DIR;
  if (requestedDirectory === undefined) return;
  const targetDirectory: string = path.resolve(requestedDirectory);
  const approvedTarget: string = path.resolve('artifacts/stats-task5/production');
  if (targetDirectory !== approvedTarget) {
    throw new Error(`Stats Task 5 production evidence must use ${approvedTarget}.`);
  }
  const run = await beginStatsEvidenceRun({
    approvedBoundaryRelativePath: 'artifacts/stats-task5',
    repositoryRoot: process.cwd(),
    reportFile: 'stats-production-run-report.json',
    targetDirectory,
    targetName: path.basename(approvedTarget),
  });
  await abandonStatsEvidenceRun(run);
}
