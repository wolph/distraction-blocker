import { createHash } from 'node:crypto';
import type * as StatsVisualEvidenceModule from '../tests/e2e/stats-visual-evidence';
import type { StatsVisualCaptureResult } from '../tests/e2e/stats-visual-evidence';
import type * as StatsEvidenceJsonModule from './stats-evidence-json';
import type { JsonRecord } from './stats-evidence-json';

const {
  assertExactJsonKeys,
  jsonArray,
  jsonBoolean,
  jsonFiniteNumber,
  jsonNullableNumber,
  jsonNullableString,
  jsonRecord,
  jsonSafeInteger,
  jsonString,
  validateStatsClock,
  validateStatsDiagnostics,
  validateStatsViewport,
} = (await import(
  new URL('./stats-evidence-json.ts', import.meta.url).href
)) as typeof StatsEvidenceJsonModule;

const {
  assertStatsVisualGeometry,
  STATS_VISUAL_STATES,
  STATS_VISUAL_THEME_CASES,
  STATS_VISUAL_VIEWPORTS,
} = (await import(
  new URL('../tests/e2e/stats-visual-evidence.ts', import.meta.url).href
)) as typeof StatsVisualEvidenceModule;

function validateRenderedTheme(value: unknown, label: string): void {
  const theme: JsonRecord = jsonRecord(value, label);
  assertExactJsonKeys(theme, ['background', 'color', 'colorScheme', 'theme'], label);
  for (const key of ['background', 'color', 'colorScheme', 'theme']) {
    jsonString(theme[key], `${label}.${key}`);
  }
}

function validateRenderedDetails(value: unknown, label: string): void {
  for (const item of jsonArray(value, label)) {
    const detail: JsonRecord = jsonRecord(item, `${label}[]`);
    assertExactJsonKeys(detail, ['open', 'text'], `${label}[]`);
    jsonBoolean(detail.open, `${label}[].open`);
    jsonString(detail.text, `${label}[].text`);
  }
}

function validateRenderedSnapshot(value: unknown, label: string): void {
  const rendered: JsonRecord = jsonRecord(value, label);
  assertExactJsonKeys(rendered, ['sha256', 'snapshot'], label);
  const snapshot: string = jsonString(rendered.snapshot, `${label}.snapshot`);
  const sha256: string = jsonString(rendered.sha256, `${label}.sha256`);
  if (
    snapshot.length < 1 ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    createHash('sha256').update(snapshot).digest('hex') !== sha256
  ) {
    throw new Error(`${label} hash contract is invalid.`);
  }
  const parsed: JsonRecord = jsonRecord(JSON.parse(snapshot) as unknown, `${label}.snapshot`);
  assertExactJsonKeys(
    parsed,
    ['bodyText', 'cards', 'details', 'resolvedTheme', 'tables'],
    `${label}.snapshot`,
  );
  jsonString(parsed.bodyText, `${label}.snapshot.bodyText`);
  for (const item of jsonArray(parsed.cards, `${label}.snapshot.cards`)) {
    jsonString(item, `${label}.snapshot.cards[]`);
  }
  for (const item of jsonArray(parsed.tables, `${label}.snapshot.tables`)) {
    jsonString(item, `${label}.snapshot.tables[]`);
  }
  validateRenderedDetails(parsed.details, `${label}.snapshot.details`);
  validateRenderedTheme(parsed.resolvedTheme, `${label}.snapshot.resolvedTheme`);
}

const GEOMETRY_KEYS: readonly string[] = [
  'chartTextFontSizes',
  'clock',
  'diagnostics',
  'disclosureCount',
  'disclosureRowCounts',
  'disclosuresKeyboardUsable',
  'documentHorizontalOverflow',
  'hasSessions',
  'renderedState',
  'sessionArticleWidths',
  'sessionArticlesClientWidth',
  'sessionArticlesDisplay',
  'sessionArticlesHorizontalOverflow',
  'sessionArticlesScrollWidth',
  'sessionTableClientWidth',
  'sessionTableDisplay',
  'sessionTableScrollWidth',
  'state',
  'themeCase',
  'viewport',
];

function validateSessionWidths(geometry: JsonRecord, label: string): void {
  for (const item of jsonArray(geometry.sessionArticleWidths, `${label}.sessionArticleWidths`)) {
    const widths: JsonRecord = jsonRecord(item, `${label}.sessionArticleWidths[]`);
    assertExactJsonKeys(widths, ['clientWidth', 'scrollWidth'], `${label}.sessionArticleWidths[]`);
    jsonFiniteNumber(widths.clientWidth, `${label}.sessionArticleWidths[].clientWidth`);
    jsonFiniteNumber(widths.scrollWidth, `${label}.sessionArticleWidths[].scrollWidth`);
  }
  jsonNullableNumber(geometry.sessionArticlesClientWidth, `${label}.sessionArticlesClientWidth`);
  jsonNullableString(geometry.sessionArticlesDisplay, `${label}.sessionArticlesDisplay`);
  jsonNullableNumber(
    geometry.sessionArticlesHorizontalOverflow,
    `${label}.sessionArticlesHorizontalOverflow`,
  );
  jsonNullableNumber(geometry.sessionArticlesScrollWidth, `${label}.sessionArticlesScrollWidth`);
  jsonNullableNumber(geometry.sessionTableClientWidth, `${label}.sessionTableClientWidth`);
  jsonNullableString(geometry.sessionTableDisplay, `${label}.sessionTableDisplay`);
  jsonNullableNumber(geometry.sessionTableScrollWidth, `${label}.sessionTableScrollWidth`);
}

function validateStateSessionContract(geometry: JsonRecord, label: string): void {
  const stateId: string = jsonString(geometry.state, `${label}.state`);
  const state: (typeof STATS_VISUAL_STATES)[number] | undefined = STATS_VISUAL_STATES.find(
    (candidate): boolean => candidate.id === stateId,
  );
  if (state === undefined) {
    throw new Error(`${label}.state is not a declared Stats visual state.`);
  }
  const hasSessions: boolean = jsonBoolean(geometry.hasSessions, `${label}.hasSessions`);
  if (hasSessions !== state.hasSessions) {
    throw new Error(`${label}.hasSessions differs from the declared Stats visual state.`);
  }
}

function validateGeometry(
  value: unknown,
  index: number,
): StatsVisualCaptureResult['geometry'][number] {
  const label: string = `Stats geometry[${String(index)}]`;
  const geometry: JsonRecord = jsonRecord(value, label);
  assertExactJsonKeys(geometry, GEOMETRY_KEYS, label);
  for (const item of jsonArray(geometry.chartTextFontSizes, `${label}.chartTextFontSizes`)) {
    jsonFiniteNumber(item, `${label}.chartTextFontSizes[]`);
  }
  validateStatsClock(geometry.clock, `${label}.clock`);
  validateStatsDiagnostics(geometry.diagnostics, `${label}.diagnostics`);
  jsonSafeInteger(geometry.disclosureCount, `${label}.disclosureCount`);
  for (const item of jsonArray(geometry.disclosureRowCounts, `${label}.disclosureRowCounts`)) {
    jsonSafeInteger(item, `${label}.disclosureRowCounts[]`);
  }
  jsonBoolean(geometry.disclosuresKeyboardUsable, `${label}.disclosuresKeyboardUsable`);
  jsonFiniteNumber(geometry.documentHorizontalOverflow, `${label}.documentHorizontalOverflow`);
  validateStateSessionContract(geometry, label);
  validateRenderedSnapshot(geometry.renderedState, `${label}.renderedState`);
  validateSessionWidths(geometry, label);
  jsonString(geometry.themeCase, `${label}.themeCase`);
  validateStatsViewport(geometry.viewport, `${label}.viewport`);
  const typed = geometry as unknown as StatsVisualCaptureResult['geometry'][number];
  assertStatsVisualGeometry(typed);
  return typed;
}

function geometryKey(entry: StatsVisualCaptureResult['geometry'][number]): string {
  return `${entry.state}/${entry.themeCase}/${String(entry.viewport.width)}x${String(entry.viewport.height)}`;
}

export function validateStatsGeometryInventory(
  value: unknown,
): StatsVisualCaptureResult['geometry'] {
  const geometry: StatsVisualCaptureResult['geometry'] = jsonArray(value, 'Stats geometry').map(
    validateGeometry,
  );
  const observed: string[] = geometry.map(geometryKey);
  const expected: string[] = STATS_VISUAL_STATES.flatMap((state) =>
    STATS_VISUAL_THEME_CASES.flatMap((themeCase) =>
      STATS_VISUAL_VIEWPORTS.map(
        (viewport): string =>
          `${state.id}/${themeCase.id}/${String(viewport.width)}x${String(viewport.height)}`,
      ),
    ),
  );
  if (
    observed.length !== expected.length ||
    new Set(observed).size !== observed.length ||
    observed.some((key: string): boolean => !expected.includes(key))
  ) {
    throw new Error('Stats geometry state, theme, and viewport inventory differs.');
  }
  return geometry;
}
