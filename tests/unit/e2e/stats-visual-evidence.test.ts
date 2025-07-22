import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isStatsBundle } from '../../../src/shared/runtime-validation';
import {
  assertStatsVisualEvidenceDirectory,
  assertStatsVisualGeometry,
  assertStatsVisualInventoryCoverage,
  assertStatsVisualSeedParity,
  expectedStatsVisualEvidenceCount,
  STATS_VISUAL_CAPTURE_SCOPES,
  STATS_VISUAL_STATES,
  STATS_VISUAL_THEME_CASES,
  STATS_VISUAL_VIEWPORTS,
  type StatsVisualEvidenceRecord,
  type StatsVisualGeometry,
} from '../../e2e/stats-visual-evidence';
import { buildStatsVisualSeed, STATS_VISUAL_SEED_AT } from '../../e2e/stats-visual-seeds';

const fixtures: string[] = [];

afterEach(async (): Promise<void> => {
  await Promise.all(
    fixtures.splice(0).map(async (fixture: string): Promise<void> => {
      await rm(fixture, { force: true, recursive: true });
    }),
  );
});

function pngHeader(width: number, height: number): Buffer {
  const payload: Buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(payload);
  payload.writeUInt32BE(width, 16);
  payload.writeUInt32BE(height, 20);
  return payload;
}

describe('Stats visual seed matrix', () => {
  it('passes the production Stats response boundary on a month transition', () => {
    const now: number = STATS_VISUAL_SEED_AT;
    for (const state of STATS_VISUAL_STATES) {
      expect(isStatsBundle(buildStatsVisualSeed(state.id, now).bundle), state.id).toBe(true);
    }
  });

  it('covers empty, one-hour, 24-hour, numeric, domain, session, and storage boundaries', () => {
    const now: number = STATS_VISUAL_SEED_AT;
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
        STATS_VISUAL_CAPTURE_SCOPES.map((scope) => {
          const file: string = `stats-production-${state.id}-${themeCase.id}-${String(viewport.width)}-${scope}.png`;
          const payload: Buffer = pngHeader(viewport.width, viewport.height);
          return {
            buildSource: 'production' as const,
            bytes: payload.byteLength,
            file,
            image: { height: viewport.height, width: viewport.width },
            scope,
            seed: {
              at: STATS_VISUAL_SEED_AT,
              sha256: 'a'.repeat(64),
              state: state.id,
            },
            sha256: createHash('sha256').update(payload).digest('hex'),
            state: state.id,
            themeCase: themeCase.id,
            viewport,
          };
        }),
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

  it('rejects missing bytes, wrong hashes, stale filenames, and viewport drift', () => {
    const record: StatsVisualEvidenceRecord = completeInventory()[0] as StatsVisualEvidenceRecord;
    for (const mutation of [
      { bytes: 0 },
      { file: `stale-${record.file}` },
      { image: { height: record.image.height, width: record.image.width + 1 } },
      { seed: { ...record.seed, state: 'one-active-hour-sync' as const } },
      { sha256: 'bad' },
      { viewport: { ...record.viewport, height: record.viewport.height + 1 } },
    ]) {
      expect(() =>
        assertStatsVisualInventoryCoverage(
          completeInventory().map((item, index) =>
            index === 0 ? ({ ...item, ...mutation } as StatsVisualEvidenceRecord) : item,
          ),
          'production',
        ),
      ).toThrow();
    }
  });

  it('requires exact disk parity and verifies PNG bytes, signature, dimensions, and SHA-256', async () => {
    const directory: string = await mkdtemp(path.join(tmpdir(), 'stats-evidence-integrity-'));
    fixtures.push(directory);
    const record: StatsVisualEvidenceRecord = completeInventory()[0] as StatsVisualEvidenceRecord;
    const payload: Buffer = pngHeader(record.image.width, record.image.height);
    await writeFile(path.join(directory, record.file), payload);
    await expect(assertStatsVisualEvidenceDirectory(directory, [record])).resolves.toBeUndefined();

    await writeFile(path.join(directory, 'stale.png'), payload);
    await expect(assertStatsVisualEvidenceDirectory(directory, [record])).rejects.toThrow(
      /unexpected|parity|stale/i,
    );
    await rm(path.join(directory, 'stale.png'));
    const corrupt: Buffer = Buffer.from(await readFile(path.join(directory, record.file)));
    corrupt[0] = 0;
    await writeFile(path.join(directory, record.file), corrupt);
    await expect(assertStatsVisualEvidenceDirectory(directory, [record])).rejects.toThrow(
      /PNG|signature/i,
    );
  });

  it('requires one deterministic per-state seed identity across dev and production', () => {
    const production: StatsVisualEvidenceRecord[] = completeInventory();
    const dev: StatsVisualEvidenceRecord[] = production.map(
      (record: StatsVisualEvidenceRecord): StatsVisualEvidenceRecord => ({
        ...record,
        buildSource: 'dev',
        file: record.file.replace('stats-production-', 'stats-dev-'),
      }),
    );
    expect(() => assertStatsVisualSeedParity(dev, production)).not.toThrow();
    dev[0] = {
      ...(dev[0] as StatsVisualEvidenceRecord),
      seed: { ...(dev[0] as StatsVisualEvidenceRecord).seed, sha256: 'b'.repeat(64) },
    };
    expect(() => assertStatsVisualSeedParity(dev, production)).toThrow(/seed|parity/i);
  });
});

function validGeometry(width: 375 | 768 | 1280 = 375): StatsVisualGeometry {
  const responsiveArticles: boolean = width <= 768;
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
    disclosureRowCounts: [7, 7, 6, 24],
    disclosuresKeyboardUsable: true,
    documentHorizontalOverflow: 0,
    hasSessions: true,
    sessionArticleWidths: responsiveArticles
      ? [{ clientWidth: width - 72, scrollWidth: width - 72 }]
      : [{ clientWidth: 0, scrollWidth: 0 }],
    sessionArticlesClientWidth: responsiveArticles ? width - 72 : 0,
    sessionArticlesDisplay: responsiveArticles ? 'grid' : 'none',
    sessionArticlesHorizontalOverflow: 0,
    sessionArticlesScrollWidth: responsiveArticles ? width - 72 : 0,
    sessionTableClientWidth: responsiveArticles ? 0 : width - 72,
    sessionTableDisplay: responsiveArticles ? 'none' : 'block',
    sessionTableScrollWidth: responsiveArticles ? 0 : width - 72,
    viewport: { height: width === 375 ? 667 : 800, width },
  };
}

describe('Stats visual geometry audit', () => {
  it.each([375, 768, 1280] as const)(
    'accepts the non-scrolling session layout at %ipx',
    (width: 375 | 768 | 1280): void => {
      expect(() => assertStatsVisualGeometry(validGeometry(width))).not.toThrow();
    },
  );

  it.each([
    ['font size', { chartTextFontSizes: [11.99] }],
    ['document overflow', { documentHorizontalOverflow: 1 }],
    ['session overflow', { sessionArticlesHorizontalOverflow: 1 }],
    ['session article width', { sessionArticleWidths: [{ clientWidth: 303, scrollWidth: 304 }] }],
    ['tablet table', { viewport: { height: 800, width: 768 }, sessionTableDisplay: 'block' }],
    ['mobile table', { sessionTableDisplay: 'block' }],
    [
      'desktop table width',
      {
        viewport: { height: 800, width: 1280 },
        sessionArticlesDisplay: 'none',
        sessionTableClientWidth: 800,
        sessionTableDisplay: 'block',
        sessionTableScrollWidth: 801,
      },
    ],
    ['keyboard disclosure', { disclosuresKeyboardUsable: false }],
    ['empty disclosure table', { disclosureRowCounts: [7, 0, 6, 24] }],
    ['browser diagnostic', { diagnostics: { ...validGeometry().diagnostics, workerErrors: 1 } }],
  ])('rejects %s regressions', (_label, mutation) => {
    expect(() => assertStatsVisualGeometry({ ...validGeometry(), ...mutation })).toThrow();
  });
});
