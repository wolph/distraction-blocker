import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CDPSession, Page, TestInfo, Worker } from '@playwright/test';
import { PNG } from 'pngjs';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, rulesFromLists } from '../../src/shared/constants';
import type { Ack } from '../../src/shared/messages';
import type { ListsConfig, OnboardingDraft, SessionConfig, Settings } from '../../src/shared/types';
import { assertNoUnexpectedBrowserDiagnostics } from './browser-diagnostics';
import { browserDiagnosticsFor, expect, sendExtensionRequest, test } from './fixtures';
import { freezeStatsVisualWorkerClock, installStatsVisualPageClock } from './stats-visual-evidence';
import {
  buildStatsVisualSeed,
  STATS_VISUAL_SEED_AT,
  type StatsVisualSeed,
} from './stats-visual-seeds';

const REPOSITORY_ROOT: string = fileURLToPath(new URL('../../', import.meta.url));
const SCREENSHOT_DIRECTORY: string = path.join(REPOSITORY_ROOT, 'store/assets/screenshots');
const STORE_SCREENSHOT_SPEC: string = fileURLToPath(import.meta.url);
const SCREENSHOT_FILES: readonly string[] = [
  '01-start-session.png',
  '02-blocked-page.png',
  '03-onboarding.png',
  '04-stats.png',
  '05-privacy-data.png',
];

interface CaptureGeometry {
  deviceScaleFactor: number;
  viewport: { height: number; width: number };
}

const POPUP_CAPTURE: CaptureGeometry = {
  deviceScaleFactor: 4 / 3,
  viewport: {
    height: 600,
    width: 960,
  },
};
const PAGE_CAPTURE: CaptureGeometry = {
  deviceScaleFactor: 1.6,
  viewport: {
    height: 500,
    width: 800,
  },
};
const DETAIL_CAPTURE: CaptureGeometry = {
  deviceScaleFactor: 4 / 3,
  viewport: {
    height: 600,
    width: 960,
  },
};
const TALL_CAPTURE: CaptureGeometry = {
  deviceScaleFactor: 20 / 17,
  viewport: {
    height: 680,
    width: 1088,
  },
};
const STATS_CAPTURE: CaptureGeometry = {
  deviceScaleFactor: 20 / 23,
  viewport: {
    height: 920,
    width: 1472,
  },
};
const STORE_IMAGE_SIZE: Readonly<{ height: number; width: number }> = {
  height: 800,
  width: 1280,
};
const STORE_INTENTION: string = 'Finish the release notes';
const STORE_TIMEZONE: string = 'Europe/Amsterdam';
// Set UPDATE_STORE_SCREENSHOTS=1 to atomically replace tracked PNGs. Unset compares only.
const UPDATE_SCREENSHOTS_ENV: string = 'UPDATE_STORE_SCREENSHOTS';

function parseScreenshotUpdateMode(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new Error(`${UPDATE_SCREENSHOTS_ENV} must be unset or exactly 1`);
}

async function assertScreenshotInventory(directory: string): Promise<void> {
  const entries: string[] = (await readdir(directory)).sort();
  expect(entries).toEqual([...SCREENSHOT_FILES]);

  for (const file of SCREENSHOT_FILES) {
    const payload: Buffer = await readFile(path.join(directory, file));
    expect(payload.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const image: PNG = PNG.sync.read(payload);
    expect({ height: image.height, width: image.width }, file).toEqual({
      height: 800,
      width: 1280,
    });
    for (let alphaOffset: number = 3; alphaOffset < image.data.length; alphaOffset += 4) {
      if (image.data[alphaOffset] !== 255) {
        const pixelIndex: number = (alphaOffset - 3) / 4;
        throw new Error(
          `${file} must be fully opaque at every decoded pixel; pixel ${String(pixelIndex)} has alpha ${String(image.data[alphaOffset])}`,
        );
      }
    }
    const cornerPixelOffsets: readonly number[] = [
      3,
      (image.width - 1) * 4 + 3,
      (image.height - 1) * image.width * 4 + 3,
      (image.height * image.width - 1) * 4 + 3,
    ];
    expect(
      cornerPixelOffsets.map((offset: number): number => image.data[offset] ?? 0),
      `${file} must reach every square image corner without transparent padding`,
    ).toEqual([255, 255, 255, 255]);
  }
}

async function captureStoreScreenshot(
  page: Page,
  directory: string,
  file: string,
  geometry: CaptureGeometry,
): Promise<void> {
  const session: CDPSession = await page.context().newCDPSession(page);
  try {
    await session.send('Emulation.setDeviceMetricsOverride', {
      deviceScaleFactor: geometry.deviceScaleFactor,
      height: geometry.viewport.height,
      mobile: false,
      screenHeight: geometry.viewport.height,
      screenWidth: geometry.viewport.width,
      width: geometry.viewport.width,
    });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await page.evaluate(async (): Promise<void> => {
      await document.fonts.ready;
      await new Promise<void>((resolve: () => void): void => {
        requestAnimationFrame((): number => requestAnimationFrame(resolve));
      });
    });
    const viewport: { deviceScaleFactor: number; height: number; width: number } =
      await storeViewportMetadata(page);
    expect({ height: viewport.height, width: viewport.width }).toEqual(geometry.viewport);
    expect(viewport.deviceScaleFactor).toBeCloseTo(geometry.deviceScaleFactor, 5);
    const screenshot = await session.send('Page.captureScreenshot', {
      captureBeyondViewport: true,
      clip: {
        height: geometry.viewport.height,
        scale: 1,
        width: geometry.viewport.width,
        x: 0,
        y: 0,
      },
      format: 'png',
      fromSurface: true,
    });
    const payload: Buffer = Buffer.from(screenshot.data, 'base64');
    await writeFile(path.join(directory, file), payload);
    const image: PNG = PNG.sync.read(payload);
    expect({ height: image.height, width: image.width }, file).toEqual(STORE_IMAGE_SIZE);
  } finally {
    await session.detach();
  }
}

async function setCaptureTimezone(page: Page): Promise<CDPSession> {
  const session: CDPSession = await page.context().newCDPSession(page);
  await session.send('Emulation.setTimezoneOverride', { timezoneId: STORE_TIMEZONE });
  const timezone: string = await page.evaluate(
    (): string => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  expect(timezone).toBe(STORE_TIMEZONE);
  return session;
}

async function publishCapturedScreenshots(
  captureDirectory: string,
  canonicalDirectory: string,
  updateCanonical: boolean,
): Promise<void> {
  if (updateCanonical) {
    const captures: readonly { file: string; payload: Buffer }[] = await Promise.all(
      SCREENSHOT_FILES.map(
        async (file: string): Promise<{ file: string; payload: Buffer }> => ({
          file,
          payload: await readFile(path.join(captureDirectory, file)),
        }),
      ),
    );
    const staged: readonly { target: string; temporary: string }[] = await Promise.all(
      captures.map(async ({ file, payload }): Promise<{ target: string; temporary: string }> => {
        const target: string = path.join(canonicalDirectory, file);
        const temporary: string = path.join(canonicalDirectory, `.${file}.${randomUUID()}.tmp`);
        await writeFile(temporary, payload, { flag: 'wx' });
        return { target, temporary };
      }),
    );
    try {
      for (const { target, temporary } of staged) await rename(temporary, target);
    } finally {
      await Promise.all(
        staged.map(({ temporary }): Promise<void> => rm(temporary, { force: true })),
      );
    }
    return;
  }
  for (const file of SCREENSHOT_FILES) {
    const [capture, canonical]: [Buffer, Buffer] = await Promise.all([
      readFile(path.join(captureDirectory, file)),
      readFile(path.join(canonicalDirectory, file)),
    ]);
    if (!capture.equals(canonical)) {
      throw new Error(`${file} differs from the tracked canonical PNG`);
    }
  }
}

async function runHostileTimezoneCapture(outputDirectory: string): Promise<string> {
  const executable: string = path.join(REPOSITORY_ROOT, 'node_modules/.bin/playwright');
  const environment: NodeJS.ProcessEnv = { ...process.env, TZ: 'UTC' };
  delete environment[UPDATE_SCREENSHOTS_ENV];
  const args: readonly string[] = [
    'test',
    `--config=${path.join(REPOSITORY_ROOT, 'playwright.config.ts')}`,
    STORE_SCREENSHOT_SPEC,
    '--grep=captures five truthful release states',
    `--output=${outputDirectory}`,
    '--reporter=line',
    '--workers=1',
  ];
  return await new Promise<string>((resolve, reject): void => {
    const child: ChildProcessWithoutNullStreams = spawn(executable, args, {
      cwd: REPOSITORY_ROOT,
      env: environment,
    });
    let output: string = '';
    child.stdout.on('data', (chunk: Buffer): void => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer): void => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code: number | null): void => {
      if (code === 0) resolve(output);
      else reject(new Error(`UTC capture exited ${String(code)}\n${output}`));
    });
  });
}

async function freezeIsolatedPageWorlds(
  session: CDPSession,
  isolatedContextIds: ReadonlySet<number>,
): Promise<void> {
  await Promise.all(
    [...isolatedContextIds].map(async (contextId: number): Promise<void> => {
      await session.send('Runtime.evaluate', {
        contextId,
        expression: `Date.now = () => ${String(STATS_VISUAL_SEED_AT)}`,
      });
    }),
  );
}

async function blurIsolatedPageWorlds(
  session: CDPSession,
  isolatedContextIds: ReadonlySet<number>,
): Promise<void> {
  await Promise.all(
    [...isolatedContextIds].map(async (contextId: number): Promise<void> => {
      await session.send('Runtime.evaluate', {
        contextId,
        expression: 'document.activeElement?.blur()',
      });
    }),
  );
}

async function storeViewportMetadata(page: Page): Promise<{
  deviceScaleFactor: number;
  height: number;
  width: number;
}> {
  return await page.evaluate((): { deviceScaleFactor: number; height: number; width: number } => ({
    height: window.innerHeight,
    deviceScaleFactor: window.devicePixelRatio,
    width: window.innerWidth,
  }));
}

function storeLists(): ListsConfig {
  return {
    ...structuredClone(DEFAULT_LISTS),
    categories: {
      ...DEFAULT_LISTS.categories,
      social: true,
    },
    custom: [
      { kind: 'host', pattern: 'blocked.example' },
      { kind: 'regex', pattern: '(^|\\.)research\\.example\\.org$' },
    ],
  };
}

function storeSettings(): Settings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    cyclingOnByDefault: false,
    defaultMode: 'blacklist',
    defaultStrictness: 'friction',
    theme: 'light',
  };
}

async function requireAck(ack: Ack, operation: string): Promise<void> {
  if (!ack.ok) throw new Error(`${operation}: ${ack.error}`);
}

async function freezeWorkerClock(worker: Worker): Promise<void> {
  const clock = await freezeStatsVisualWorkerClock(worker);
  expect(clock).toEqual({
    beforeFreeze: expect.any(Number),
    now: STATS_VISUAL_SEED_AT,
  });
}

async function installPageClock(page: Page): Promise<void> {
  await page.addInitScript((at: number): void => {
    Date.now = (): number => at;
  }, STATS_VISUAL_SEED_AT);
}

async function settleSync(controlPage: Page): Promise<void> {
  await expect
    .poll(async (): Promise<string> => {
      const setup = await sendExtensionRequest(controlPage, { type: 'getSetupState' });
      if (setup.syncWriteStatus !== 'pending') return setup.syncWriteStatus;
      const retried = await sendExtensionRequest(controlPage, { type: 'retrySync' });
      if (!retried.ok) throw new Error(`could not settle Chrome Sync: ${retried.error}`);
      return (await sendExtensionRequest(controlPage, { type: 'getSetupState' })).syncWriteStatus;
    })
    .toBe('idle');
}

async function seedStoreStats(controlPage: Page, worker: Worker): Promise<void> {
  const setup = await sendExtensionRequest(controlPage, { type: 'getSetupState' });
  expect(setup).toMatchObject({
    completed: true,
    storageMode: 'sync',
    syncWriteStatus: 'idle',
  });
  const seed: StatsVisualSeed = buildStatsVisualSeed('one-active-hour-sync', STATS_VISUAL_SEED_AT);
  const currentDate: Date = new Date(STATS_VISUAL_SEED_AT);
  const currentDateKey: string = `${String(currentDate.getFullYear())}-${String(
    currentDate.getMonth() + 1,
  ).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;
  const seededDay = seed.bundle.days[0];
  if (seededDay === undefined) throw new Error('store Stats seed is missing its active day');
  seededDay.date = currentDateKey;
  seededDay.focusMs = 20 * 60_000;
  seededDay.pauseMsEarned = 3 * 60_000;
  seed.bundle.streak = {
    ...seed.bundle.streak,
    activeDays: [],
    current: 0,
    freezeTokens: 0,
    lastCountedDate: null,
  };
  for (const event of seed.events) {
    if (event.t === 'sessionStarted') event.durationMin = 20;
    if (event.t === 'sessionCompleted') event.focusedMs = 20 * 60_000;
  }
  for (const event of seed.events) event.at += 24 * 60 * 60_000;
  seed.bundle.recentSessions = [...seed.events].reverse();
  seed.bundle.totals = {
    attemptsToday: 1,
    focusMsLast7Days: seededDay.focusMs,
    focusMsToday: seededDay.focusMs,
    resistedToday: seededDay.resisted,
  };
  await worker.evaluate(async (payload: StatsVisualSeed): Promise<void> => {
    const aggregateKeys = (items: Record<string, unknown>): string[] =>
      Object.keys(items).filter(
        (key: string): boolean =>
          key === 'streak' ||
          key === 'aggregatePrune' ||
          key === 'aggregateTombstones' ||
          key === 'blockedAggregatePublications' ||
          /^aggm?:/.test(key),
      );
    const [localItems, syncItems]: [Record<string, unknown>, Record<string, unknown>] =
      await Promise.all([chrome.storage.local.get(null), chrome.storage.sync.get(null)]);
    const localKeys: string[] = aggregateKeys(localItems);
    const syncKeys: string[] = aggregateKeys(syncItems);
    if (localKeys.length > 0) await chrome.storage.local.remove(localKeys);
    if (syncKeys.length > 0) await chrome.storage.sync.remove(syncKeys);
    await chrome.storage.local.set({ events: payload.events });
    const aggregates: Record<string, unknown> = Object.fromEntries(
      payload.bundle.days.map((day): [string, unknown] => [`agg:store-task4:${day.date}`, day]),
    );
    aggregates.streak = payload.bundle.streak;
    await chrome.storage.sync.set(aggregates);
  }, seed);
  const stats = await sendExtensionRequest(controlPage, { type: 'getStats', days: 14 });
  expect(stats).toMatchObject({
    totals: {
      attemptsToday: 1,
      focusMsLast7Days: 20 * 60_000,
      focusMsToday: 20 * 60_000,
    },
  });
}

test('default screenshot publication compares complete bytes without changing canonical files', async ({
  browserName: _browserName,
}, testInfo: TestInfo): Promise<void> => {
  const captureDirectory: string = testInfo.outputPath('captured');
  const canonicalDirectory: string = testInfo.outputPath('canonical');
  await Promise.all([mkdir(captureDirectory, { recursive: true }), mkdir(canonicalDirectory)]);
  await Promise.all(
    SCREENSHOT_FILES.flatMap((file: string): Promise<void>[] => {
      const payload: Buffer = Buffer.from(`canonical:${file}`);
      return [
        writeFile(path.join(captureDirectory, file), payload),
        writeFile(path.join(canonicalDirectory, file), payload),
      ];
    }),
  );
  const before: Buffer[] = await Promise.all(
    SCREENSHOT_FILES.map(
      (file: string): Promise<Buffer> => readFile(path.join(canonicalDirectory, file)),
    ),
  );

  await publishCapturedScreenshots(captureDirectory, canonicalDirectory, false);

  const after: Buffer[] = await Promise.all(
    SCREENSHOT_FILES.map(
      (file: string): Promise<Buffer> => readFile(path.join(canonicalDirectory, file)),
    ),
  );
  expect(after).toEqual(before);
  await writeFile(path.join(captureDirectory, SCREENSHOT_FILES[0] as string), 'drift');
  await expect(
    publishCapturedScreenshots(captureDirectory, canonicalDirectory, false),
  ).rejects.toThrow('differs from the tracked canonical PNG');
  expect(await readFile(path.join(canonicalDirectory, SCREENSHOT_FILES[0] as string))).toEqual(
    before[0],
  );
});

test('explicit update publication atomically replaces a safe canonical fixture', async ({
  browserName: _browserName,
}, testInfo: TestInfo): Promise<void> => {
  const captureDirectory: string = testInfo.outputPath('captured');
  const canonicalDirectory: string = testInfo.outputPath('canonical');
  await Promise.all([
    mkdir(captureDirectory, { recursive: true }),
    mkdir(canonicalDirectory, { recursive: true }),
  ]);
  await Promise.all(
    SCREENSHOT_FILES.flatMap((file: string): Promise<void>[] => [
      writeFile(path.join(captureDirectory, file), `updated:${file}`),
      writeFile(path.join(canonicalDirectory, file), `old:${file}`),
    ]),
  );

  await publishCapturedScreenshots(captureDirectory, canonicalDirectory, true);

  expect((await readdir(canonicalDirectory)).sort()).toEqual([...SCREENSHOT_FILES]);
  await Promise.all(
    SCREENSHOT_FILES.map(async (file: string): Promise<void> => {
      expect(await readFile(path.join(canonicalDirectory, file), 'utf8')).toBe(`updated:${file}`);
    }),
  );
});

test('screenshot update mode rejects every value except the documented 1', (): void => {
  expect(parseScreenshotUpdateMode(undefined)).toBe(false);
  expect(parseScreenshotUpdateMode('1')).toBe(true);
  for (const invalid of ['', '0', 'true', 'yes']) {
    expect((): boolean => parseScreenshotUpdateMode(invalid)).toThrow(
      `${UPDATE_SCREENSHOTS_ENV} must be unset or exactly 1`,
    );
  }
});

test('screenshot integrity rejects a transparent interior pixel', async ({
  browserName: _browserName,
}, testInfo: TestInfo): Promise<void> => {
  const fixtureDirectory: string = testInfo.outputPath('transparent-fixture');
  await mkdir(fixtureDirectory, { recursive: true });
  await Promise.all(
    SCREENSHOT_FILES.map(async (file: string): Promise<void> => {
      await writeFile(
        path.join(fixtureDirectory, file),
        await readFile(path.join(SCREENSHOT_DIRECTORY, file)),
      );
    }),
  );
  const target: string = path.join(fixtureDirectory, SCREENSHOT_FILES[0] as string);
  const image: PNG = PNG.sync.read(await readFile(target));
  const centerAlphaOffset: number =
    (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4 + 3;
  image.data[centerAlphaOffset] = 0;
  await writeFile(target, PNG.sync.write(image));

  await expect(assertScreenshotInventory(fixtureDirectory)).rejects.toThrow(
    'must be fully opaque at every decoded pixel',
  );
});

test('hostile UTC host timezone reproduces every tracked canonical byte', async ({
  browserName: _browserName,
}, testInfo: TestInfo): Promise<void> => {
  const before: Buffer[] = await Promise.all(
    SCREENSHOT_FILES.map(
      (file: string): Promise<Buffer> => readFile(path.join(SCREENSHOT_DIRECTORY, file)),
    ),
  );

  const output: string = await runHostileTimezoneCapture(testInfo.outputPath('utc-child'));

  expect(output).toContain('1 passed');
  const after: Buffer[] = await Promise.all(
    SCREENSHOT_FILES.map(
      (file: string): Promise<Buffer> => readFile(path.join(SCREENSHOT_DIRECTORY, file)),
    ),
  );
  expect(after).toEqual(before);
});

test('store screenshot inventory is exact, intact, opaque, and 1280 by 800', async (): Promise<void> => {
  await assertScreenshotInventory(SCREENSHOT_DIRECTORY);
});

test('captures five truthful release states with category membership in the popup and permission copy in onboarding', async ({
  context,
  extPage,
  extensionId,
  freshInstallExtension,
  restartableExtension,
  siteUrl,
  worker,
}): Promise<void> => {
  const updateCanonical: boolean = parseScreenshotUpdateMode(process.env[UPDATE_SCREENSHOTS_ENV]);
  const captureDirectory: string = test.info().outputPath('captured-store-screenshots');
  test.info().annotations.push({
    type: 'capture-geometry',
    description:
      'Popup and block use 960x600 CSS at DPR 4/3. Onboarding uses 800x500 CSS at DPR 1.6. Privacy uses 1088x680 CSS at DPR 20/17. Stats uses 1472x920 CSS at DPR 20/23. Every PNG is 1280x800.',
  });
  await mkdir(captureDirectory, { recursive: true });
  await assertScreenshotInventory(SCREENSHOT_DIRECTORY);
  await settleSync(extPage);
  const lists: ListsConfig = storeLists();
  const settings: Settings = storeSettings();
  await requireAck(
    await sendExtensionRequest(extPage, { type: 'updateSettings', settings }),
    'could not seed store screenshot settings',
  );
  await requireAck(
    await sendExtensionRequest(extPage, { type: 'updateLists', lists }),
    'could not seed store screenshot lists',
  );
  await settleSync(extPage);
  await seedStoreStats(extPage, worker);
  await settleSync(extPage);
  await freezeWorkerClock(worker);

  await test.step('01 uses the 25-minute Friction draft to show effective category membership', async (): Promise<void> => {
    const timezoneSession: CDPSession = await setCaptureTimezone(extPage);
    await extPage.setViewportSize(POPUP_CAPTURE.viewport);
    await installPageClock(extPage);
    await extPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await extPage.getByLabel('Intention').fill(STORE_INTENTION);
    await expect(extPage.getByRole('button', { name: 'Friction' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(
      extPage.getByRole('button', { name: 'Start 25 min - Block selected sites' }),
    ).toBeVisible();
    await expect(extPage.getByText('1 of 7 categories selected')).toBeVisible();
    await expect(extPage.getByText('2 extra blocked rules')).toBeVisible();
    await expect(extPage.getByRole('button', { name: 'Social media' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(extPage.getByRole('list', { name: 'Social media sites' })).toContainText(
      'instagram.com',
    );
    const frictionButton = extPage.getByRole('button', { name: 'Friction' });
    await frictionButton.click();
    await expect(
      extPage.locator('.help-popover__body', {
        hasText: 'Ending early requires a 10-second wait. No typing is required.',
      }),
    ).toBeVisible();
    await frictionButton.press('Escape');
    await frictionButton.evaluate((element: HTMLElement): void => element.blur());
    const popupGeometry = await extPage.evaluate(
      (): {
        clientHeight: number;
        frictionOffsetTop: number;
        ruleSummaryOffsetTop: number;
        scrollTop: number;
        scrollHeight: number;
      } => {
        const scroll: HTMLElement | null = document.querySelector('.start-form__scroll');
        const summary: HTMLElement | null = document.querySelector('.rule-summary');
        const friction: HTMLElement | null = document.querySelector('.session-type-control');
        if (scroll === null || summary === null || friction === null) {
          throw new Error('popup store geometry is unavailable');
        }
        scroll.scrollTop = 190;
        const rules: HTMLElement | null = document.querySelector('.rule-summary__scroll');
        if (rules !== null) rules.scrollTop = 30;
        return {
          clientHeight: scroll.clientHeight,
          frictionOffsetTop: friction.offsetTop,
          ruleSummaryOffsetTop: summary.offsetTop,
          scrollTop: scroll.scrollTop,
          scrollHeight: scroll.scrollHeight,
        };
      },
    );
    expect(popupGeometry.scrollHeight).toBeGreaterThan(popupGeometry.clientHeight);
    await test.info().attach('01-popup-geometry.json', {
      body: Buffer.from(JSON.stringify(popupGeometry, null, 2)),
      contentType: 'application/json',
    });
    await captureStoreScreenshot(
      extPage,
      captureDirectory,
      SCREENSHOT_FILES[0] as string,
      POPUP_CAPTURE,
    );
    await timezoneSession.detach();
  });

  await test.step('02 starts the seeded draft and captures a real existing-page block verdict', async (): Promise<void> => {
    const blockedLaunch = await restartableExtension.launch();
    await freezeWorkerClock(blockedLaunch.worker);
    await requireAck(
      await sendExtensionRequest(blockedLaunch.extPage, { type: 'updateSettings', settings }),
      'could not seed blocked-page settings',
    );
    await requireAck(
      await sendExtensionRequest(blockedLaunch.extPage, { type: 'updateLists', lists }),
      'could not seed blocked-page lists',
    );
    const config: SessionConfig = {
      cycling: null,
      durationMin: 25,
      intention: STORE_INTENTION,
      mode: 'blacklist',
      rules: rulesFromLists(lists),
      scheduleEntryId: null,
      source: 'manual',
      strictness: 'friction',
    };
    const blockedPage: Page = await blockedLaunch.context.newPage();
    const blockedTimezoneSession: CDPSession = await setCaptureTimezone(blockedPage);
    await blockedPage.setViewportSize(DETAIL_CAPTURE.viewport);
    const accessibilitySession = await blockedLaunch.context.newCDPSession(blockedPage);
    const isolatedContextIds: Set<number> = new Set<number>();
    accessibilitySession.on('Runtime.executionContextCreated', (payload): void => {
      if (payload.context.auxData?.type === 'isolated') {
        isolatedContextIds.add(payload.context.id);
      }
    });
    accessibilitySession.on('Runtime.executionContextDestroyed', (payload): void => {
      isolatedContextIds.delete(payload.executionContextId);
    });
    accessibilitySession.on('Runtime.executionContextsCleared', (): void => {
      isolatedContextIds.clear();
    });
    await accessibilitySession.send('Runtime.enable');
    await installPageClock(blockedPage);
    await blockedPage.goto(siteUrl('/plain.html'));
    await freezeIsolatedPageWorlds(accessibilitySession, isolatedContextIds);
    await requireAck(
      await sendExtensionRequest(blockedLaunch.extPage, { type: 'startSession', config }),
      'could not start the store screenshot session',
    );
    const snapshot = await sendExtensionRequest(blockedLaunch.extPage, { type: 'getSnapshot' });
    expect(snapshot).toMatchObject({
      config: {
        durationMin: 25,
        intention: STORE_INTENTION,
        mode: 'blacklist',
        strictness: 'friction',
      },
      phase: 'focus',
      phaseEndsAt: STATS_VISUAL_SEED_AT + 25 * 60_000,
      sessionEndsAt: STATS_VISUAL_SEED_AT + 25 * 60_000,
      startedAt: STATS_VISUAL_SEED_AT,
    });
    await expect(blockedPage.locator('focus-lock-overlay')).toBeAttached();
    const blockedState = await sendExtensionRequest(blockedLaunch.extPage, {
      type: 'getBlockState',
      docState: 'loaded',
      url: siteUrl('/plain.html'),
    });
    expect(blockedState.verdict).toEqual({
      blocked: true,
      categoryId: null,
      matchedPattern: 'blocked.example',
      reason: 'custom',
    });
    expect(blockedState.snapshot).toMatchObject({
      config: { intention: STORE_INTENTION },
      phaseEndsAt: STATS_VISUAL_SEED_AT + 25 * 60_000,
    });
    try {
      await accessibilitySession.send('Accessibility.enable');
      await expect
        .poll(async (): Promise<string[]> => {
          const tree = await accessibilitySession.send('Accessibility.getFullAXTree');
          return tree.nodes
            .map((node): string => String(node.name?.value ?? ''))
            .filter((name: string): boolean => name !== '');
        })
        .toEqual(
          expect.arrayContaining([
            'Locked until 12:25',
            '25:00',
            STORE_INTENTION,
            'Blocked by your block list: blocked.example',
          ]),
        );
      await blurIsolatedPageWorlds(accessibilitySession, isolatedContextIds);
    } finally {
      await accessibilitySession.detach();
    }
    await blockedPage.evaluate((): void => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await captureStoreScreenshot(
      blockedPage,
      captureDirectory,
      SCREENSHOT_FILES[1] as string,
      DETAIL_CAPTURE,
    );
    await blockedTimezoneSession.detach();
    await blockedPage.close();
    await restartableExtension.close();
  });

  await test.step('03 captures the real onboarding permission step while retaining the seeded category choice', async (): Promise<void> => {
    const launch = await freshInstallExtension.launch();
    const onboardingTimezoneSession: CDPSession = await setCaptureTimezone(launch.onboardingPage);
    await launch.onboardingPage.setViewportSize(PAGE_CAPTURE.viewport);
    await installPageClock(launch.onboardingPage);
    const loaded = await sendExtensionRequest(launch.extPage, { type: 'getOnboardingDraft' });
    if (!loaded.ok || loaded.draft === null) {
      throw new Error(`could not load onboarding draft: ${JSON.stringify(loaded)}`);
    }
    const draft: OnboardingDraft = {
      ...loaded.draft,
      step: 2,
      lists: {
        ...loaded.draft.lists,
        categories: { ...loaded.draft.lists.categories, social: true },
      },
      websiteAccessChoice: 'pending',
    };
    const saved = await sendExtensionRequest(launch.extPage, {
      type: 'saveOnboardingDraft',
      draft,
    });
    if (!saved.ok) throw new Error(`could not seed onboarding draft: ${saved.error}`);
    expect(saved.draft).toMatchObject({
      step: 2,
      lists: { categories: { social: true } },
      websiteAccessChoice: 'pending',
    });
    await launch.onboardingPage.reload();
    await expect(
      launch.onboardingPage.getByRole('heading', { name: 'Enable website blocking' }),
    ).toBeVisible();
    await expect(
      launch.onboardingPage.getByText(
        'Focus Lock checks page addresses locally so it can match your selected categories and sites.',
        { exact: false },
      ),
    ).toBeVisible();
    await expect(
      launch.onboardingPage.getByText('Read and change all your data on all websites'),
    ).toBeVisible();
    await launch.onboardingPage.evaluate((): void => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await captureStoreScreenshot(
      launch.onboardingPage,
      captureDirectory,
      SCREENSHOT_FILES[2] as string,
      PAGE_CAPTURE,
    );
    await onboardingTimezoneSession.detach();
  });

  await test.step('04 captures representative synchronized totals with explicit machine-only panels', async (): Promise<void> => {
    const statsPage: Page = await context.newPage();
    const statsTimezoneSession: CDPSession = await setCaptureTimezone(statsPage);
    await installStatsVisualPageClock(statsPage);
    await statsPage.setViewportSize(STATS_CAPTURE.viewport);
    await statsPage.goto(`chrome-extension://${extensionId}/src/stats/stats.html`);
    await expect(
      statsPage.getByRole('heading', { level: 1, name: 'Your focus record' }),
    ).toBeVisible();
    await expect(
      statsPage.getByText('Synced totals from this Chrome account. Local-only panels are labeled.'),
    ).toBeVisible();
    await expect(
      statsPage.locator('.tile', { hasText: 'Focus today' }).locator('.tile-value'),
    ).toHaveText('20 m');
    await expect(
      statsPage.getByRole('heading', { name: 'Attempts by hour, this machine only' }),
    ).toHaveCount(1);
    await expect(
      statsPage.getByRole('heading', { name: 'Recent sessions on this machine' }),
    ).toHaveCount(1);
    await expect(statsPage.getByText('Prepare the release summary')).toHaveCount(2);
    await statsPage.evaluate((): void => window.scrollTo(0, 24));
    await captureStoreScreenshot(
      statsPage,
      captureDirectory,
      SCREENSHOT_FILES[3] as string,
      STATS_CAPTURE,
    );
    await statsTimezoneSession.detach();
    await statsPage.close();
  });

  await test.step('05 captures Privacy and data with Sync enabled and exact data scopes', async (): Promise<void> => {
    await expect
      .poll(
        async (): Promise<string> =>
          (await sendExtensionRequest(extPage, { type: 'getSetupState' })).syncWriteStatus,
      )
      .toBe('idle');
    const optionsPage: Page = await context.newPage();
    const optionsTimezoneSession: CDPSession = await setCaptureTimezone(optionsPage);
    await optionsPage.setViewportSize(TALL_CAPTURE.viewport);
    await installPageClock(optionsPage);
    await optionsPage.goto(`chrome-extension://${extensionId}/src/options/options.html#privacy`);
    await expect(
      optionsPage.getByRole('heading', { level: 2, name: 'Privacy and data' }),
    ).toBeVisible();
    await expect(
      optionsPage.getByRole('switch', { name: 'Sync Focus Lock data across Chrome devices' }),
    ).toBeChecked();
    await expect(optionsPage.getByText('Chrome Sync is on.')).toBeVisible();
    await expect(optionsPage.getByRole('heading', { name: 'Synced' })).toBeVisible();
    await expect(optionsPage.getByRole('heading', { name: 'Local only' })).toBeVisible();
    const syncedScope = optionsPage.locator('.privacy-data-scope', {
      has: optionsPage.getByRole('heading', { name: 'Synced' }),
    });
    await expect(syncedScope.getByRole('listitem')).toHaveText([
      'Settings',
      'Block and allow lists',
      'Pause balance',
      'Streaks',
      'Domain-level blocked-attempt aggregates',
    ]);
    const localOnlyScope = optionsPage.locator('.privacy-data-scope', {
      has: optionsPage.getByRole('heading', { name: 'Local only' }),
    });
    await expect(localOnlyScope.getByRole('listitem')).toHaveText([
      'Full URLs',
      'Focus intentions',
      'Detailed session events',
      'Active runtime session',
    ]);
    await expect(
      optionsPage.getByText('Nothing is sent to the Focus Lock developer.'),
    ).toBeVisible();
    await optionsPage.evaluate((): void => {
      const privacyHeading: HTMLHeadingElement | undefined = [
        ...document.querySelectorAll('h2'),
      ].find(
        (heading: HTMLHeadingElement): boolean =>
          heading.textContent?.trim() === 'Privacy and data',
      );
      if (privacyHeading === undefined) throw new Error('Privacy and data heading is unavailable');
      window.scrollTo(0, Math.max(0, privacyHeading.offsetTop - 56));
    });
    await captureStoreScreenshot(
      optionsPage,
      captureDirectory,
      SCREENSHOT_FILES[4] as string,
      TALL_CAPTURE,
    );
    await optionsTimezoneSession.detach();
    await optionsPage.close();
  });

  await assertScreenshotInventory(captureDirectory);
  assertNoUnexpectedBrowserDiagnostics(browserDiagnosticsFor(context));
  assertNoUnexpectedBrowserDiagnostics(freshInstallExtension.diagnostics);
  assertNoUnexpectedBrowserDiagnostics(restartableExtension.diagnostics);
  await publishCapturedScreenshots(captureDirectory, SCREENSHOT_DIRECTORY, updateCanonical);
  await assertScreenshotInventory(SCREENSHOT_DIRECTORY);
});
