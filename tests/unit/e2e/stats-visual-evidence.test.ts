import { describe, expect, it } from 'vitest';
import { isStatsBundle } from '../../../src/shared/runtime-validation';
import {
  assertStatsVisualGeometry,
  assertStatsVisualInventoryCoverage,
  expectedStatsVisualEvidenceCount,
  STATS_VISUAL_CAPTURE_SCOPES,
  STATS_VISUAL_STATES,
  STATS_VISUAL_THEME_CASES,
  STATS_VISUAL_VIEWPORTS,
  type StatsVisualEvidenceRecord,
  type StatsVisualGeometry,
} from '../../e2e/stats-visual-evidence';
import { buildStatsVisualSeed } from '../../e2e/stats-visual-seeds';

describe('Stats visual seed matrix', () => {
  it('passes the production Stats response boundary on a month transition', () => {
    const now: number = new Date(2026, 8, 1, 12).getTime();
    for (const state of STATS_VISUAL_STATES) {
      expect(isStatsBundle(buildStatsVisualSeed(state.id, now).bundle), state.id).toBe(true);
    }
  });

  it('covers empty, one-hour, 24-hour, numeric, domain, session, and storage boundaries', () => {
    const now: number = new Date(2026, 8, 1, 12).getTime();
    const seeds = STATS_VISUAL_STATES.map((state) => buildStatsVisualSeed(state.id, now));
    const attemptHours: number[][] = seeds.map((seed) =>
      seed.events
        .filter((event) => event.t === 'attempt')
        .map((event) => new Date(event.at).getHours()),
    );
    const aggregateAttempts: Array<[string, number]> = seeds.flatMap((seed) =>
      seed.bundle.days.flatMap((day) => Object.entries(day.attempts)),
    );
    const sessionOutcomes: string[] = seeds.flatMap((seed) =>
      seed.events
        .filter((event) => event.t === 'sessionCompleted' || event.t === 'sessionCanceled')
        .map((event) => event.t),
    );

    expect(seeds.some((seed) => seed.bundle.days.length === 0 && seed.events.length === 0)).toBe(
      true,
    );
    expect(attemptHours.some((hours) => new Set(hours).size === 1)).toBe(true);
    expect(attemptHours.some((hours) => new Set(hours).size === 24)).toBe(true);
    expect(aggregateAttempts.some(([, count]) => count >= 1_000_000)).toBe(true);
    expect(aggregateAttempts.some(([domain]) => domain.length >= 60)).toBe(true);
    expect(sessionOutcomes).toContain('sessionCompleted');
    expect(sessionOutcomes).toContain('sessionCanceled');
    expect(new Set(seeds.map((seed) => seed.storageMode))).toEqual(new Set(['local', 'sync']));
  });
});

function completeInventory(): StatsVisualEvidenceRecord[] {
  return STATS_VISUAL_STATES.flatMap((state) =>
    STATS_VISUAL_THEME_CASES.flatMap((themeCase) =>
      STATS_VISUAL_VIEWPORTS.flatMap((viewport) =>
        STATS_VISUAL_CAPTURE_SCOPES.map((scope) => ({
          buildSource: 'production' as const,
          file: `stats-production-${state.id}-${themeCase.id}-${String(viewport.width)}-${scope}.png`,
          scope,
          state: state.id,
          themeCase: themeCase.id,
          viewport,
        })),
      ),
    ),
  );
}

describe('Stats visual evidence inventory', () => {
  it('keeps an exact independent matrix contract', () => {
    const inventory: StatsVisualEvidenceRecord[] = completeInventory();
    expect(inventory).toHaveLength(expectedStatsVisualEvidenceCount());
    expect(() => assertStatsVisualInventoryCoverage(inventory, 'production')).not.toThrow();
    expect(() => assertStatsVisualInventoryCoverage(inventory.slice(1), 'production')).toThrow(
      /missing/i,
    );
    const duplicate: StatsVisualEvidenceRecord = inventory[1] as StatsVisualEvidenceRecord;
    expect(() =>
      assertStatsVisualInventoryCoverage([...inventory.slice(1), duplicate], 'production'),
    ).toThrow(/duplicate/i);
  });
});

function validGeometry(): StatsVisualGeometry {
  return {
    chartTextFontSizes: [12, 13],
    diagnostics: {
      blockedRequests: 0,
      consoleErrors: 0,
      pageErrors: 0,
      requestErrors: 0,
      workerErrors: 0,
    },
    disclosureCount: 4,
    disclosuresKeyboardUsable: true,
    documentHorizontalOverflow: 0,
    hasSessions: true,
    sessionArticlesDisplay: 'grid',
    sessionArticlesHorizontalOverflow: 0,
    sessionTableDisplay: 'none',
    viewport: { height: 667, width: 375 },
  };
}

describe('Stats visual geometry audit', () => {
  it('accepts the mobile-native session layout and readable chart text', () => {
    expect(() => assertStatsVisualGeometry(validGeometry())).not.toThrow();
  });

  it.each([
    ['font size', { chartTextFontSizes: [11.99] }],
    ['document overflow', { documentHorizontalOverflow: 1 }],
    ['session overflow', { sessionArticlesHorizontalOverflow: 1 }],
    ['mobile table', { sessionTableDisplay: 'block' }],
    ['keyboard disclosure', { disclosuresKeyboardUsable: false }],
    ['browser diagnostic', { diagnostics: { ...validGeometry().diagnostics, workerErrors: 1 } }],
  ])('rejects %s regressions', (_label, mutation) => {
    expect(() => assertStatsVisualGeometry({ ...validGeometry(), ...mutation })).toThrow();
  });
});
