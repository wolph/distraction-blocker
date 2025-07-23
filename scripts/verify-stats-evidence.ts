import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { StatsVisualBuildSource } from '../tests/e2e/stats-visual-evidence';
import type * as StatsEvidenceIntegrityModule from './stats-evidence-integrity';
import type * as StatsEvidenceReportModule from './stats-evidence-report';
import type { StatsEvidenceRunReport } from './stats-evidence-report';

const { assertStatsEvidenceDiskParity } = (await import(
  new URL('./stats-evidence-integrity.ts', import.meta.url).href
)) as typeof StatsEvidenceIntegrityModule;
const { validateStatsEvidenceReport } = (await import(
  new URL('./stats-evidence-report.ts', import.meta.url).href
)) as typeof StatsEvidenceReportModule;

export type { StatsEvidenceRunReport } from './stats-evidence-report';

export async function verifyStatsEvidenceDirectory(input: {
  buildSource: StatsVisualBuildSource;
  evidenceDirectory: string;
  reportFile: string;
}): Promise<StatsEvidenceRunReport> {
  const reportPath: string = path.join(input.evidenceDirectory, input.reportFile);
  const report: StatsEvidenceRunReport = validateStatsEvidenceReport(
    JSON.parse(await readFile(reportPath, 'utf8')) as unknown,
    input.buildSource,
  );
  await assertStatsEvidenceDiskParity(input.evidenceDirectory, report.inventory, [
    input.reportFile,
  ]);
  return report;
}
