import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyStatsEvidenceDirectory } from '../../../scripts/verify-stats-evidence';
import type {
  StatsVisualEvidenceRecord,
  StatsVisualGeometry,
} from '../../e2e/stats-visual-evidence';
import {
  STATS_VISUAL_CAPTURE_SCOPES,
  STATS_VISUAL_STATES,
  STATS_VISUAL_THEME_CASES,
  STATS_VISUAL_VIEWPORTS,
} from '../../e2e/stats-visual-evidence';
import { STATS_VISUAL_CLOCK_AUDIT_AT, STATS_VISUAL_SEED_AT } from '../../e2e/stats-visual-seeds';

const fixtures: string[] = [];

afterEach(async (): Promise<void> => {
  await Promise.all(
    fixtures
      .splice(0)
      .map(
        async (fixture: string): Promise<void> =>
          await rm(fixture, { force: true, recursive: true }),
      ),
  );
});

function geometry(width: 375 | 768 | 1280, hasSessions: boolean): StatsVisualGeometry {
  const responsive: boolean = width <= 768;
  const snapshot: string = JSON.stringify({
    bodyText: 'same',
    cards: [],
    details: [],
    resolvedTheme: { background: 'white', color: 'black', colorScheme: 'light', theme: 'auto' },
    tables: [],
  });
  return {
    chartTextFontSizes: [12],
    clock: { beforeFreeze: STATS_VISUAL_CLOCK_AUDIT_AT, now: STATS_VISUAL_SEED_AT },
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
    hasSessions,
    renderedState: { sha256: createHash('sha256').update(snapshot).digest('hex'), snapshot },
    sessionArticleWidths: !hasSessions
      ? []
      : responsive
        ? [{ clientWidth: width - 72, scrollWidth: width - 72 }]
        : [{ clientWidth: 0, scrollWidth: 0 }],
    sessionArticlesClientWidth: !hasSessions ? null : responsive ? width - 72 : 0,
    sessionArticlesDisplay: !hasSessions ? null : responsive ? 'grid' : 'none',
    sessionArticlesHorizontalOverflow: hasSessions ? 0 : null,
    sessionArticlesScrollWidth: !hasSessions ? null : responsive ? width - 72 : 0,
    sessionTableClientWidth: !hasSessions ? null : responsive ? 0 : width - 72,
    sessionTableDisplay: !hasSessions ? null : responsive ? 'none' : 'block',
    sessionTableScrollWidth: !hasSessions ? null : responsive ? 0 : width - 72,
    viewport: { height: width === 375 ? 667 : 800, width },
  };
}

async function fixture(): Promise<{
  directory: string;
  report: Record<string, unknown>;
  reportFile: string;
}> {
  const directory: string = await mkdtemp(path.join(tmpdir(), 'stats-verifier-'));
  fixtures.push(directory);
  const reportFile: string = 'stats-production-run-report.json';
  const payloads: Map<number, Buffer> = new Map(
    STATS_VISUAL_VIEWPORTS.map((viewport) => [
      viewport.width,
      PNG.sync.write(new PNG({ height: viewport.height, width: viewport.width })),
    ]),
  );
  const inventory: StatsVisualEvidenceRecord[] = STATS_VISUAL_STATES.flatMap((state) =>
    STATS_VISUAL_THEME_CASES.flatMap((themeCase) =>
      STATS_VISUAL_VIEWPORTS.flatMap((viewport) =>
        STATS_VISUAL_CAPTURE_SCOPES.map((scope): StatsVisualEvidenceRecord => {
          const payload: Buffer = payloads.get(viewport.width) as Buffer;
          return {
            buildSource: 'production',
            bytes: payload.byteLength,
            file: `stats-production-${state.id}-${themeCase.id}-${String(viewport.width)}-${scope}.png`,
            image: { height: viewport.height, width: viewport.width },
            scope,
            seed: { at: STATS_VISUAL_SEED_AT, sha256: 'a'.repeat(64), state: state.id },
            sha256: createHash('sha256').update(payload).digest('hex'),
            state: state.id,
            themeCase: themeCase.id,
            viewport,
          };
        }),
      ),
    ),
  );
  await Promise.all(
    inventory.map(
      async (record): Promise<void> =>
        await writeFile(
          path.join(directory, record.file),
          payloads.get(record.viewport.width) as Buffer,
        ),
    ),
  );
  const report: Record<string, unknown> = {
    browser: 'Playwright bundled Chromium with the production extension build',
    buildSource: 'production',
    diagnostics: {
      blockedRequests: 0,
      consoleErrors: 0,
      pageErrors: 0,
      requestErrors: 0,
      workerErrors: 0,
    },
    diagnosticsBoundary: 'owned Stats page and browser context closed before report write',
    geometry: STATS_VISUAL_STATES.flatMap((state) =>
      STATS_VISUAL_THEME_CASES.flatMap((themeCase) =>
        STATS_VISUAL_VIEWPORTS.map((viewport) => ({
          ...geometry(viewport.width as 375 | 768 | 1280, state.hasSessions),
          state: state.id,
          themeCase: themeCase.id,
        })),
      ),
    ),
    inventory,
    schemaVersion: 3,
    screenshotCount: 216,
    workerClock: { beforeFreeze: STATS_VISUAL_CLOCK_AUDIT_AT, now: STATS_VISUAL_SEED_AT },
  };
  await writeFile(path.join(directory, reportFile), `${JSON.stringify(report)}\n`);
  return { directory, report, reportFile };
}

describe('Stats evidence report JSON boundary', () => {
  // Verifies a real evidence fixture on disk, so it needs more than the default timeout.
  it('rejects diagnostics, geometry, key-set, and type mutations', async () => {
    const current = await fixture();
    await writeFile(
      path.join(current.directory, current.reportFile),
      `${JSON.stringify(current.report)}\n`,
    );
    await expect(
      verifyStatsEvidenceDirectory({
        buildSource: 'production',
        evidenceDirectory: current.directory,
        reportFile: current.reportFile,
      }),
    ).resolves.toBeDefined();
    const mutations: Array<(report: Record<string, unknown>) => void> = [
      (report): void => {
        report.diagnostics = {};
      },
      (report): void => {
        (report.diagnostics as Record<string, unknown>).workerErrors = 0.5;
      },
      (report): void => {
        ((report.geometry as StatsVisualGeometry[])[0] as StatsVisualGeometry).chartTextFontSizes =
          [1];
      },
      (report): void => {
        (
          (report.geometry as StatsVisualGeometry[])[0] as StatsVisualGeometry
        ).documentHorizontalOverflow = 999;
      },
      (report): void => {
        const record = (report.geometry as Array<StatsVisualGeometry & { state: string }>).find(
          (entry): boolean =>
            entry.state === 'one-active-hour-sync' && entry.viewport.width === 768,
        );
        if (record !== undefined) record.hasSessions = false;
      },
      (report): void => {
        const record = (report.geometry as Array<StatsVisualGeometry & { state: string }>).find(
          (entry): boolean =>
            entry.state === 'all-hours-boundaries-local' && entry.viewport.width === 1280,
        );
        if (record !== undefined) record.hasSessions = false;
      },
      (report): void => {
        const record = (report.geometry as Array<StatsVisualGeometry & { state: string }>).find(
          (entry): boolean => entry.state === 'no-activity-local' && entry.viewport.width === 768,
        );
        if (record !== undefined) record.hasSessions = true;
      },
      (report): void => {
        const records = report.geometry as unknown[];
        records[records.length - 1] = records[0];
      },
      (report): void => {
        ((report.geometry as Array<{ state: string }>)[0] as { state: string }).state = 'bad-state';
      },
      (report): void => {
        report.screenshotCount = '216';
      },
      (report): void => {
        const first = (report.geometry as Array<{ renderedState: { sha256: string } }>)[0];
        if (first !== undefined) first.renderedState.sha256 = 'b'.repeat(64);
      },
      (report): void => {
        report.unexpected = true;
      },
    ];
    for (const mutate of mutations) {
      const changed: Record<string, unknown> = structuredClone(current.report);
      mutate(changed);
      await writeFile(
        path.join(current.directory, current.reportFile),
        `${JSON.stringify(changed)}\n`,
      );
      await expect(
        verifyStatsEvidenceDirectory({
          buildSource: 'production',
          evidenceDirectory: current.directory,
          reportFile: current.reportFile,
        }),
      ).rejects.toThrow();
    }
  }, 30_000);
});
