import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type * as StatsVisualEvidenceModule from '../tests/e2e/stats-visual-evidence';
import type {
  StatsVisualBuildSource,
  StatsVisualCaptureResult,
  StatsVisualEvidenceRecord,
} from '../tests/e2e/stats-visual-evidence';
import type * as StatsEvidenceIntegrityModule from './stats-evidence-integrity';

const { assertStatsVisualDiagnostics, assertStatsVisualInventoryCoverage } = (await import(
  new URL('../tests/e2e/stats-visual-evidence.ts', import.meta.url).href
)) as typeof StatsVisualEvidenceModule;
const { assertStatsEvidenceDiskParity } = (await import(
  new URL('./stats-evidence-integrity.ts', import.meta.url).href
)) as typeof StatsEvidenceIntegrityModule;

export interface StatsEvidenceRunReport {
  buildSource: StatsVisualBuildSource;
  diagnostics: {
    blockedRequests: number;
    consoleErrors: number;
    pageErrors: number;
    requestErrors: number;
    workerErrors: number;
  };
  geometry: StatsVisualCaptureResult['geometry'];
  inventory: StatsVisualEvidenceRecord[];
  schemaVersion: number;
  screenshotCount: number;
}

export async function verifyStatsEvidenceDirectory(input: {
  buildSource: StatsVisualBuildSource;
  evidenceDirectory: string;
  reportFile: string;
}): Promise<StatsEvidenceRunReport> {
  const reportPath: string = path.join(input.evidenceDirectory, input.reportFile);
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as StatsEvidenceRunReport;
  if (
    report.schemaVersion !== 3 ||
    report.buildSource !== input.buildSource ||
    report.screenshotCount !== 216 ||
    !Array.isArray(report.inventory) ||
    report.inventory.length !== 216 ||
    !Array.isArray(report.geometry) ||
    report.geometry.length !== 36
  ) {
    throw new Error('Stats evidence report schema or inventory count is invalid.');
  }
  assertStatsVisualDiagnostics(report.diagnostics);
  assertStatsVisualInventoryCoverage(report.inventory, input.buildSource);
  for (const geometry of report.geometry) {
    if (
      !/^[a-f0-9]{64}$/.test(geometry.renderedState.sha256) ||
      geometry.renderedState.snapshot.length < 1
    ) {
      throw new Error('Stats evidence report rendered-state metadata is invalid.');
    }
  }
  await assertStatsEvidenceDiskParity(input.evidenceDirectory, report.inventory, [
    input.reportFile,
  ]);
  return report;
}
