import type * as StatsVisualEvidenceModule from '../tests/e2e/stats-visual-evidence';
import type {
  StatsVisualClockAudit,
  StatsVisualDiagnosticCounts,
} from '../tests/e2e/stats-visual-evidence';
import type * as StatsVisualSeedsModule from '../tests/e2e/stats-visual-seeds';

const { assertStatsVisualDiagnostics } = (await import(
  new URL('../tests/e2e/stats-visual-evidence.ts', import.meta.url).href
)) as typeof StatsVisualEvidenceModule;
const { STATS_VISUAL_CLOCK_AUDIT_AT, STATS_VISUAL_SEED_AT } = (await import(
  new URL('../tests/e2e/stats-visual-seeds.ts', import.meta.url).href
)) as typeof StatsVisualSeedsModule;

export type JsonRecord = Record<string, unknown>;

export function jsonRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

export function assertExactJsonKeys(
  value: JsonRecord,
  keys: readonly string[],
  label: string,
): void {
  const actual: string[] = Object.keys(value).sort();
  const expected: string[] = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} keys differ.`);
  }
}

export function jsonFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

export function jsonSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer.`);
  }
  return value;
}

export function jsonString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}

export function jsonBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return value;
}

export function jsonArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

export function jsonNullableNumber(value: unknown, label: string): number | null {
  return value === null ? null : jsonFiniteNumber(value, label);
}

export function jsonNullableString(value: unknown, label: string): string | null {
  return value === null ? null : jsonString(value, label);
}

export function validateStatsDiagnostics(
  value: unknown,
  label: string,
): StatsVisualDiagnosticCounts {
  const diagnostics: JsonRecord = jsonRecord(value, label);
  const keys: readonly string[] = [
    'blockedRequests',
    'consoleErrors',
    'pageErrors',
    'requestErrors',
    'workerErrors',
  ];
  assertExactJsonKeys(diagnostics, keys, label);
  for (const key of keys) {
    if (jsonSafeInteger(diagnostics[key], `${label}.${key}`) !== 0) {
      throw new Error(`${label}.${key} must be zero.`);
    }
  }
  const typed: StatsVisualDiagnosticCounts = diagnostics as unknown as StatsVisualDiagnosticCounts;
  assertStatsVisualDiagnostics(typed);
  return typed;
}

export function validateStatsClock(value: unknown, label: string): StatsVisualClockAudit {
  const clock: JsonRecord = jsonRecord(value, label);
  assertExactJsonKeys(clock, ['beforeFreeze', 'now'], label);
  if (
    jsonSafeInteger(clock.beforeFreeze, `${label}.beforeFreeze`) !== STATS_VISUAL_CLOCK_AUDIT_AT ||
    jsonSafeInteger(clock.now, `${label}.now`) !== STATS_VISUAL_SEED_AT
  ) {
    throw new Error(`${label} does not match the frozen evidence clock contract.`);
  }
  return clock as unknown as StatsVisualClockAudit;
}

export function validateStatsViewport(
  value: unknown,
  label: string,
): { height: number; width: number } {
  const viewport: JsonRecord = jsonRecord(value, label);
  assertExactJsonKeys(viewport, ['height', 'width'], label);
  return {
    height: jsonSafeInteger(viewport.height, `${label}.height`),
    width: jsonSafeInteger(viewport.width, `${label}.width`),
  };
}
