/**
 * The upgrade a real v1 profile takes into this build, replayed end to end.
 *
 * A profile read through the options page could not boot: its settings
 * predated `allowForceEnd`, its v1 runtime sat under a v2 schema marker, and Chrome Sync was stuck
 * in publish error behind one blocked aggregate. The popup answered "Setup status unavailable" to
 * every request. This spec seeds exactly that profile into a persistent browser profile, relaunches
 * the browser over it, and asks the product for what the repair promised: boot, migrate once, run
 * a session, and republish. Every assertion reads the durable storage the worker booted from, not
 * only the surface it painted.
 */

import type { Locator, Page, Worker } from '@playwright/test';
import { parseStoredEventLogV2 } from '../../src/background/event-log-v2';
import type { RuntimeStateV2 } from '../../src/background/runtime-v2-types';
import { isSettings } from '../../src/shared/runtime-validation';
import {
  LOCAL_EVENTS,
  LOCAL_RUNTIME,
  LOCAL_RUNTIME_MIGRATION,
  LOCAL_RUNTIME_REJECTED,
  LOCAL_RUNTIME_SCHEMA,
  LOCAL_SETTINGS,
  SYNC_SETTINGS,
} from '../../src/shared/storage-keys';
import type { SessionEventRecordV2, Settings, SetupState } from '../../src/shared/types';
import {
  type LegacyUpgradeProfile,
  type LegacyUpgradeSettingsV1,
  legacyUpgradeProfile,
  legacyUpgradeSettingsV1,
} from '../fixtures/legacy-upgrade-profile';
import {
  assertNoUnexpectedBrowserDiagnostics,
  type BrowserDiagnostics,
} from './browser-diagnostics';
import {
  type ExtensionLaunch,
  expect,
  readRuntimeV2,
  sendExtensionRequest,
  startTestSession,
  test,
  waitForLifecycle,
} from './fixtures';

/**
 * Two browser launches, a legacy migration, a session, and a Chrome Sync republish share one
 * machine with the rest of the suite, so the budget follows `indefinite-recovery.spec.ts`. Every
 * wait inside is still on a condition the product moved.
 */
test.describe.configure({ timeout: 300_000 });

const SYNC_RETRY_LABEL: string = 'Retry Chrome Sync';

function expectNoDiagnostics(diagnostics: BrowserDiagnostics): void {
  expect((): void => assertNoUnexpectedBrowserDiagnostics(diagnostics)).not.toThrow();
}

/** The worker handle a read should use right now, as in `indefinite-recovery.spec.ts`. */
function liveWorker(launch: ExtensionLaunch): Worker {
  return launch.context.serviceWorkers()[0] ?? launch.worker;
}

/** The settings the profile stores once the parser has read them: the bypass defaulted off. */
function canonicalSettings(): Settings {
  const legacy: LegacyUpgradeSettingsV1 = legacyUpgradeSettingsV1();
  return { ...legacy, gate: { ...legacy.gate, allowForceEnd: false } };
}

interface SeededAreas {
  local: Record<string, unknown>;
  sync: Record<string, unknown>;
}

/**
 * Replaces both storage areas with the profile and answers what the worker holds a moment later.
 * The running worker reacts to Chrome Sync changes, so the remote area is written first and given
 * a second to settle before the local area, whose seed has to be the last write before the close.
 * The read-back is what proves the seed is what the relaunch will find.
 */
async function seedProfile(worker: Worker, profile: LegacyUpgradeProfile): Promise<SeededAreas> {
  return await worker.evaluate(async (seed: LegacyUpgradeProfile): Promise<SeededAreas> => {
    const settle = async (): Promise<void> =>
      await new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, 1_000);
      });
    await chrome.storage.sync.clear();
    await chrome.storage.sync.set(seed.sync);
    await settle();
    await chrome.storage.local.clear();
    await chrome.storage.local.set(seed.local);
    await settle();
    return {
      local: await chrome.storage.local.get(null),
      sync: await chrome.storage.sync.get(null),
    };
  }, profile);
}

interface StoredAfterUpgrade {
  local: Record<string, unknown>;
  syncSettings: unknown;
}

async function readStoredAfterUpgrade(worker: Worker): Promise<StoredAfterUpgrade> {
  return await worker.evaluate(
    async (keys: { local: string[]; syncSettings: string }): Promise<StoredAfterUpgrade> => ({
      local: await chrome.storage.local.get(keys.local),
      syncSettings: (await chrome.storage.sync.get(keys.syncSettings))[keys.syncSettings],
    }),
    {
      local: [
        LOCAL_SETTINGS,
        LOCAL_RUNTIME,
        LOCAL_RUNTIME_SCHEMA,
        LOCAL_RUNTIME_MIGRATION,
        LOCAL_RUNTIME_REJECTED,
        LOCAL_EVENTS,
      ],
      syncSettings: SYNC_SETTINGS,
    },
  );
}

async function setupOf(extPage: Page): Promise<SetupState> {
  return await sendExtensionRequest(extPage, { type: 'getSetupState' });
}

/** Retries the blocked publication through the options page, the way a person would. */
async function retryChromeSync(launch: ExtensionLaunch): Promise<void> {
  const optionsPage: Page = await launch.context.newPage();
  await optionsPage.goto(
    `chrome-extension://${launch.extensionId}/src/options/options.html#privacy`,
  );
  await expect(optionsPage.getByRole('heading', { name: 'Privacy and data' })).toBeVisible();
  const retry: Locator = optionsPage.getByRole('button', { name: SYNC_RETRY_LABEL, exact: true });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(optionsPage.getByText('Chrome Sync changes saved.')).toBeVisible();
  await optionsPage.close();
}

function requireSessionId(runtime: RuntimeStateV2): string {
  const sessionId: string | undefined = runtime.session?.sessionId;
  if (sessionId === undefined) throw new Error('no durable session is active');
  return sessionId;
}

test('the 7 September profile boots, migrates once, runs a session, and republishes to Chrome Sync', async ({
  restartableExtension,
}) => {
  const profile: LegacyUpgradeProfile = legacyUpgradeProfile();
  const seededEvents: unknown[] = profile.local[LOCAL_EVENTS] as unknown[];

  const first: ExtensionLaunch = await restartableExtension.launch();
  const seeded: SeededAreas = await seedProfile(first.worker, legacyUpgradeProfile());
  // The relaunch must find the profile as modelled. A worker that rewrote a key in reaction to the
  // seed would turn the scenario into a different upgrade than the one it reproduces.
  expect(seeded.local).toEqual(profile.local);
  expect(seeded.sync).toEqual(profile.sync);
  await restartableExtension.close();

  const second: ExtensionLaunch = await restartableExtension.launch();
  await second.extPage.reload();
  // The idle form, not a failure screen: this is the line the profile could not cross before.
  await expect(second.extPage.getByRole('button', { name: /^Start/ })).toBeVisible();
  await expect(second.extPage.getByText('Setup status unavailable')).toHaveCount(0);
  await expect(second.extPage.getByText(/could not start/)).toHaveCount(0);
  const bootedSetup: SetupState = await setupOf(second.extPage);
  expect(bootedSetup).toMatchObject({
    completed: true,
    legacyImported: true,
    storageMode: 'sync',
    websiteAccess: 'granted',
    blockingRegistration: 'ready',
  });
  expect([null, 'sync-publish-failed']).toContain(bootedSetup.storageError);

  // A session on the migrated runtime. Timed long enough that its own timer cannot end it first.
  await startTestSession(second.extPage, {
    strictness: 'flexible',
    duration: { kind: 'timed', minutes: 5 },
    intention: 'first session after the upgrade',
  });
  const sessionId: string = requireSessionId(await readRuntimeV2(liveWorker(second)));
  expect(await sendExtensionRequest(second.extPage, { type: 'requestSessionEnd' })).toEqual({
    ok: true,
    code: 'ok',
  });
  await waitForLifecycle(second.extPage, 'idle', 60_000);

  // The blocked publication clears on its own when the boot republishes it, and through the
  // options page when it does not. Both paths converge on an idle Chrome Sync with no error.
  const afterSession: SetupState = await setupOf(second.extPage);
  if (afterSession.syncWriteStatus === 'error') {
    await retryChromeSync(second);
  }
  // Recorded rather than asserted: which path a run takes depends on whether the boot's own
  // republish reached Chrome before the session ended, and both are the product working.
  test.info().annotations.push({
    type: 'sync recovery path',
    description:
      afterSession.syncWriteStatus === 'error'
        ? 'options page Retry Chrome Sync'
        : `boot republished on its own (${afterSession.syncWriteStatus})`,
  });
  await expect
    .poll(
      async (): Promise<string> => {
        const setup: SetupState = await setupOf(second.extPage);
        return `${setup.syncWriteStatus}/${String(setup.storageError)}`;
      },
      { timeout: 60_000 },
    )
    .toBe('idle/null');

  const stored: StoredAfterUpgrade = await readStoredAfterUpgrade(liveWorker(second));
  expect(isSettings(stored.syncSettings)).toBe(true);
  expect(stored.syncSettings).toEqual(canonicalSettings());
  expect(stored.local[LOCAL_SETTINGS]).toEqual(canonicalSettings());
  expect(stored.local[LOCAL_RUNTIME]).toMatchObject({ runtimeSchemaVersion: 2, session: null });
  expect(stored.local[LOCAL_RUNTIME_SCHEMA]).toEqual({ runtimeSchemaVersion: 2 });
  expect(stored.local[LOCAL_RUNTIME_MIGRATION]).toBeUndefined();
  expect(stored.local[LOCAL_RUNTIME_REJECTED]).toBeUndefined();

  // The v1 log survives whole, and only this run's session follows it. The v2 log keeps
  // unversioned records beside the versioned ones (a phase change, a budget grant), so the added
  // records are held to the shipped parser keeping every one of them, to all of them naming the
  // session this run started, and to the versioned start and end being among them.
  const events: unknown[] = stored.local[LOCAL_EVENTS] as unknown[];
  expect(Array.isArray(events)).toBe(true);
  expect(events.slice(0, seededEvents.length)).toEqual(seededEvents);
  const added: SessionEventRecordV2[] = parseStoredEventLogV2(events.slice(seededEvents.length));
  expect(added).toHaveLength(events.length - seededEvents.length);
  expect(added.length).toBeGreaterThanOrEqual(2);
  for (const record of added) expect(record.sessionId).toBe(sessionId);
  const addedIds: string[] = added.flatMap((record: SessionEventRecordV2): string[] =>
    'version' in record && record.version === 2 ? [record.eventId] : [],
  );
  expect(addedIds).toContain(`${sessionId}:start`);
  expect(addedIds).toContain(`${sessionId}:end`);

  expectNoDiagnostics(restartableExtension.diagnostics);
});
