import type * as StatsVisualEvidenceModule from '../tests/e2e/stats-visual-evidence';
import type {
  StatsVisualBuildSource,
  StatsVisualCaptureResult,
  StatsVisualClockAudit,
  StatsVisualDiagnosticCounts,
  StatsVisualEvidenceRecord,
} from '../tests/e2e/stats-visual-evidence';
import type { StatsVisualStateId } from '../tests/e2e/stats-visual-seeds';
import type * as StatsEvidenceGeometryModule from './stats-evidence-geometry';
import type * as StatsEvidenceJsonModule from './stats-evidence-json';
import type { JsonRecord } from './stats-evidence-json';

const { validateStatsGeometryInventory } = (await import(
  new URL('./stats-evidence-geometry.ts', import.meta.url).href
)) as typeof StatsEvidenceGeometryModule;
const {
  assertExactJsonKeys,
  jsonArray,
  jsonRecord,
  jsonSafeInteger,
  jsonString,
  validateStatsClock,
  validateStatsDiagnostics,
  validateStatsViewport,
} = (await import(
  new URL('./stats-evidence-json.ts', import.meta.url).href
)) as typeof StatsEvidenceJsonModule;

const { assertStatsVisualInventoryCoverage } = (await import(
  new URL('../tests/e2e/stats-visual-evidence.ts', import.meta.url).href
)) as typeof StatsVisualEvidenceModule;

export interface StatsEvidenceRunReport {
  browser: string;
  buildSource: StatsVisualBuildSource;
  diagnostics: StatsVisualDiagnosticCounts;
  diagnosticsBoundary: string;
  geometry: StatsVisualCaptureResult['geometry'];
  inventory: StatsVisualEvidenceRecord[];
  schemaVersion: 3;
  screenshotCount: 216;
  sourceHarness?: string;
  workerClock?: StatsVisualClockAudit;
}

const INVENTORY_KEYS: readonly string[] = [
  'buildSource',
  'bytes',
  'file',
  'image',
  'scope',
  'seed',
  'sha256',
  'state',
  'themeCase',
  'viewport',
];

function validateInventoryEntry(value: unknown, index: number): StatsVisualEvidenceRecord {
  const label: string = `Stats inventory[${String(index)}]`;
  const entry: JsonRecord = jsonRecord(value, label);
  assertExactJsonKeys(entry, INVENTORY_KEYS, label);
  jsonString(entry.buildSource, `${label}.buildSource`);
  jsonSafeInteger(entry.bytes, `${label}.bytes`);
  jsonString(entry.file, `${label}.file`);
  validateStatsViewport(entry.image, `${label}.image`);
  jsonString(entry.scope, `${label}.scope`);
  const seed: JsonRecord = jsonRecord(entry.seed, `${label}.seed`);
  assertExactJsonKeys(seed, ['at', 'sha256', 'state'], `${label}.seed`);
  jsonSafeInteger(seed.at, `${label}.seed.at`);
  jsonString(seed.sha256, `${label}.seed.sha256`);
  jsonString(seed.state, `${label}.seed.state`);
  jsonString(entry.sha256, `${label}.sha256`);
  jsonString(entry.state, `${label}.state`);
  jsonString(entry.themeCase, `${label}.themeCase`);
  validateStatsViewport(entry.viewport, `${label}.viewport`);
  return entry as unknown as StatsVisualEvidenceRecord;
}

function validateInventory(
  value: unknown,
  buildSource: StatsVisualBuildSource,
): StatsVisualEvidenceRecord[] {
  const inventory: StatsVisualEvidenceRecord[] = jsonArray(value, 'Stats inventory').map(
    validateInventoryEntry,
  );
  assertStatsVisualInventoryCoverage(inventory, buildSource);
  const seeds: Map<StatsVisualStateId, string> = new Map();
  for (const entry of inventory) {
    const serialized: string = JSON.stringify(entry.seed);
    const previous: string | undefined = seeds.get(entry.state);
    if (previous !== undefined && previous !== serialized) {
      throw new Error(`Stats seed identity differs within ${entry.state}.`);
    }
    seeds.set(entry.state, serialized);
  }
  return inventory;
}

function validateSourceContract(report: JsonRecord, buildSource: StatsVisualBuildSource): void {
  const expectedBrowser: string =
    buildSource === 'dev'
      ? 'Playwright bundled Chromium'
      : 'Playwright bundled Chromium with the production extension build';
  if (jsonString(report.browser, 'Stats evidence report.browser') !== expectedBrowser) {
    throw new Error('Stats evidence report browser contract differs.');
  }
  if (jsonString(report.buildSource, 'Stats evidence report.buildSource') !== buildSource) {
    throw new Error('Stats evidence report build source differs.');
  }
  const expectedBoundary: string =
    buildSource === 'dev'
      ? 'owned page, context, browser, and Vite process closed before report write'
      : 'owned Stats page and browser context closed before report write';
  if (
    jsonString(report.diagnosticsBoundary, 'Stats evidence report.diagnosticsBoundary') !==
    expectedBoundary
  ) {
    throw new Error('Stats evidence diagnostics boundary differs.');
  }
}

function validateSourceSpecificFields(
  report: JsonRecord,
  buildSource: StatsVisualBuildSource,
): void {
  if (buildSource === 'dev') {
    if (
      jsonString(report.sourceHarness, 'Stats evidence report.sourceHarness') !==
      'tests/e2e/stats-dev-harness/stats.html'
    ) {
      throw new Error('Stats evidence source harness differs.');
    }
  } else {
    validateStatsClock(report.workerClock, 'Stats evidence report.workerClock');
  }
}

export function validateStatsEvidenceReport(
  value: unknown,
  buildSource: StatsVisualBuildSource,
): StatsEvidenceRunReport {
  const report: JsonRecord = jsonRecord(value, 'Stats evidence report');
  const sharedKeys: string[] = [
    'browser',
    'buildSource',
    'diagnostics',
    'diagnosticsBoundary',
    'geometry',
    'inventory',
    'schemaVersion',
    'screenshotCount',
  ];
  assertExactJsonKeys(
    report,
    buildSource === 'dev' ? [...sharedKeys, 'sourceHarness'] : [...sharedKeys, 'workerClock'],
    'Stats evidence report',
  );
  validateSourceContract(report, buildSource);
  const diagnostics: StatsVisualDiagnosticCounts = validateStatsDiagnostics(
    report.diagnostics,
    'Stats evidence report.diagnostics',
  );
  if (jsonSafeInteger(report.schemaVersion, 'Stats evidence report.schemaVersion') !== 3) {
    throw new Error('Stats evidence schema version differs.');
  }
  if (jsonSafeInteger(report.screenshotCount, 'Stats evidence report.screenshotCount') !== 216) {
    throw new Error('Stats evidence screenshot count differs.');
  }
  const inventory: StatsVisualEvidenceRecord[] = validateInventory(report.inventory, buildSource);
  const geometry: StatsVisualCaptureResult['geometry'] = validateStatsGeometryInventory(
    report.geometry,
  );
  validateSourceSpecificFields(report, buildSource);
  return {
    ...report,
    buildSource,
    diagnostics,
    geometry,
    inventory,
    schemaVersion: 3,
    screenshotCount: 216,
  } as StatsEvidenceRunReport;
}
