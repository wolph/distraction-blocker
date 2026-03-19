import path from 'node:path';
import { abandonStatsEvidenceRun, beginStatsEvidenceRun } from '../../scripts/stats-safe-output';

/**
 * One guard per evidence directory a run may be asked to write.
 *
 * Both variables are read before either guard runs. An earlier shape returned as soon as the first
 * variable was unset, which is every ordinary run, so a second guard placed after that return could
 * never have run at all.
 */
interface EvidenceGuard {
  approvedRelativePath: string;
  boundaryRelativePath: string;
  label: string;
  reportFile: string;
  requested: string | undefined;
}

export default async function globalSetup(): Promise<void> {
  const guards: readonly EvidenceGuard[] = [
    {
      requested: process.env.STATS_EVIDENCE_DIR,
      approvedRelativePath: 'artifacts/stats-task5/production',
      boundaryRelativePath: 'artifacts/stats-task5',
      reportFile: 'stats-production-run-report.json',
      label: 'Stats Task 5 production evidence',
    },
    {
      requested: process.env.INDEFINITE_EVIDENCE_DIR,
      approvedRelativePath: 'artifacts/indefinite-sessions/production',
      boundaryRelativePath: 'artifacts/indefinite-sessions',
      reportFile: 'indefinite-production-run-report.json',
      label: 'Indefinite sessions production evidence',
    },
  ];
  for (const guard of guards) await claimEvidenceDirectory(guard);
}

/**
 * Proves the requested directory is the approved one, then takes and abandons a run through the
 * safe-output helper, which is what creates the boundary and leaves it owned by this run.
 */
async function claimEvidenceDirectory(guard: EvidenceGuard): Promise<void> {
  if (guard.requested === undefined) return;
  const targetDirectory: string = path.resolve(guard.requested);
  const approvedTarget: string = path.resolve(guard.approvedRelativePath);
  if (targetDirectory !== approvedTarget) {
    throw new Error(`${guard.label} must use ${approvedTarget}.`);
  }
  const run = await beginStatsEvidenceRun({
    approvedBoundaryRelativePath: guard.boundaryRelativePath,
    repositoryRoot: process.cwd(),
    reportFile: guard.reportFile,
    targetDirectory,
    targetName: path.basename(approvedTarget),
  });
  await abandonStatsEvidenceRun(run);
}
