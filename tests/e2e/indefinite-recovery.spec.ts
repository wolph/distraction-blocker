/**
 * Worker restart and browser relaunch flows for the "Until stopped" session.
 *
 * This file exists for one failure the rest of the suite cannot see: a session that comes back
 * from the dead, or fails to come back at all. Every scenario therefore reads the durable runtime
 * the worker booted from rather than only the surface it painted, and every wait is on a condition
 * that the product itself moved.
 *
 * Two mechanisms drive the restarts, both already owned by `fixtures.ts`. `freshInstallExtension`
 * stops and restarts the extension worker inside one browser, which is eviction. `restartableExtension`
 * closes the browser and launches it again from the same persistent profile with
 * `--restore-last-session`, which is a real relaunch with the blocked tabs restored.
 */

import type { Page, Worker } from '@playwright/test';
import type { EnforcementCheckpoint } from '../../src/background/enforcement-persistence-v2';
import type { RuntimeStateV2 } from '../../src/background/runtime-v2-types';
import { rulesFromLists } from '../../src/shared/constants';
import type {
  HandledScheduleOccurrence,
  ListsConfig,
  ScheduleEntryV2,
  SessionConfigV2,
  SessionEndedEventV2,
  SessionEventRecordV2,
  SessionLifecycleV2,
  SessionSnapshotV2,
  SessionStartedEventV2,
  Settings,
  SetupState,
} from '../../src/shared/types';
import {
  assertNoUnexpectedBrowserDiagnostics,
  type BrowserDiagnostics,
} from './browser-diagnostics';
import {
  type ExtensionLaunch,
  expect,
  type FreshInstallExtension,
  type FreshInstallLaunch,
  type RestartableExtension,
  readEventsV2FromWorker,
  readRuntimeV2,
  sendExtensionRequest,
  startTestSession,
  startUntilStoppedSession,
  test,
  waitForLifecycle,
} from './fixtures';

/**
 * A relaunch costs several browser starts, a recovery, and sometimes a closure cleanup, and these
 * scenarios share a machine with the rest of the suite. Measured with a load average near thirty,
 * one of them spent more than three minutes before reaching its first assertion, so the budget is
 * five minutes. Every wait inside is still on a condition. This only says how long the file is
 * willing to be patient before calling a hang a hang.
 */
const RECOVERY_TIMEOUT_MS: number = 300_000;

/**
 * Configured for the file rather than called inside each test, because a per-test call runs after
 * the fixture has already been built, and building one of these fixtures is itself several browser
 * launches. A relaunch scenario that spends its whole budget in setup is the one failure mode a
 * per-test timeout cannot cover.
 */
test.describe.configure({ timeout: RECOVERY_TIMEOUT_MS });

const UNTIL_STOPPED_LABEL: string = 'Until stopped';
const FOCUS_TIME_LABEL: string = 'Focus time';
const END_SESSION_LABEL: string = 'End session';
const BLOCKED_HOST: string = 'blocked.example';

/** Local wall-clock windows cannot straddle local midnight, as in the product flow spec. */
const MIDNIGHT_GUARD_MINUTES: number = 20;

function expectNoDiagnostics(diagnostics: BrowserDiagnostics): void {
  expect((): void => assertNoUnexpectedBrowserDiagnostics(diagnostics)).not.toThrow();
}

/**
 * A fresh profile taken all the way to a usable extension: website access granted, setup finished,
 * and the popup open. This is the only fixture that can stop and restart the worker, so every
 * eviction scenario starts here.
 */
async function installedExtension(
  freshInstallExtension: FreshInstallExtension,
): Promise<FreshInstallLaunch> {
  await freshInstallExtension.launch();
  const launch: FreshInstallLaunch = await freshInstallExtension.grantWebsiteAccess();
  const setup: SetupState = await freshInstallExtension.completeSetup('local');
  expect(setup).toMatchObject({
    completed: true,
    storageMode: 'local',
    websiteAccess: 'granted',
    blockingRegistration: 'ready',
  });
  // The popup was opened before setup finished, so it is still rendering the setup gate. Reloading
  // it and waiting for the start form is what makes a later click on a session control a click on
  // a control that exists.
  await launch.extPage.reload();
  await expect(launch.extPage.getByRole('button', { name: /^Start/ })).toBeVisible();
  return launch;
}

/** The restored tab for one URL after a relaunch, waited for rather than assumed. */
async function restoredPage(launch: ExtensionLaunch, url: string): Promise<Page> {
  await expect
    .poll((): boolean => launch.context.pages().some((page: Page): boolean => page.url() === url), {
      timeout: 30_000,
    })
    .toBe(true);
  const page: Page | undefined = launch.context
    .pages()
    .find((candidate: Page): boolean => candidate.url() === url);
  if (page === undefined) throw new Error(`the relaunched browser did not restore ${url}`);
  return page;
}

/**
 * The worker handle a read should use right now. A worker that was stopped, evicted, or restarted
 * leaves the handle the launch answered with dead, and a poll against a dead handle never reports
 * anything but the exception it keeps swallowing. The context always knows the live one.
 */
function liveWorker(launch: ExtensionLaunch): Worker {
  return launch.context.serviceWorkers()[0] ?? launch.worker;
}

/**
 * The tab IDs at `url` still carrying a mute this extension applied. A cleanup that settled a claim
 * without undoing its effect, or that undid one tab's mute twice and never the other's, leaves an
 * entry here.
 */
async function mutedByExtension(worker: Worker, url: string): Promise<number[]> {
  return await worker.evaluate(async (target: string): Promise<number[]> => {
    const tabs: chrome.tabs.Tab[] = await chrome.tabs.query({});
    return tabs
      .filter(
        (tab: chrome.tabs.Tab): boolean =>
          tab.url === target &&
          tab.mutedInfo?.muted === true &&
          tab.mutedInfo.extensionId === chrome.runtime.id,
      )
      .map((tab: chrome.tabs.Tab): number => tab.id ?? -1);
  }, url);
}

function requireCheckpoint(runtime: RuntimeStateV2): EnforcementCheckpoint {
  const checkpoint: EnforcementCheckpoint | null = runtime.enforcementCheckpoint;
  if (checkpoint === null) throw new Error('the runtime carries no enforcement checkpoint');
  return checkpoint;
}

function requireSessionId(runtime: RuntimeStateV2): string {
  const sessionId: string | undefined = runtime.session?.sessionId;
  if (sessionId === undefined) throw new Error('no durable session is active');
  return sessionId;
}

/** Every version 2 event of one kind, which is what a duplicate check has to count. */
function eventIdsOfKind(
  events: SessionEventRecordV2[],
  kind: 'sessionStarted' | 'sessionEnded',
): string[] {
  const ids: string[] = [];
  for (const event of events) {
    if ('version' in event && event.version === 2 && event.t === kind) {
      const identified: SessionStartedEventV2 | SessionEndedEventV2 = event;
      ids.push(identified.eventId);
    }
  }
  return ids;
}

function endEventFor(events: SessionEventRecordV2[], sessionId: string): SessionEndedEventV2 {
  const found: SessionEventRecordV2 | undefined = events.find(
    (event: SessionEventRecordV2): boolean =>
      'version' in event && event.version === 2 && event.eventId === `${sessionId}:end`,
  );
  if (found === undefined || !('version' in found) || found.t !== 'sessionEnded') {
    throw new Error(`no end event was recorded for session ${sessionId}`);
  }
  return found;
}

async function snapshotOf(extPage: Page): Promise<SessionSnapshotV2> {
  return await sendExtensionRequest(extPage, { type: 'getSnapshot' });
}

async function waitForPhase(
  extPage: Page,
  phase: string,
  timeoutMs: number,
): Promise<SessionSnapshotV2> {
  await expect
    .poll(async (): Promise<string> => (await snapshotOf(extPage)).phase, { timeout: timeoutMs })
    .toBe(phase);
  return await snapshotOf(extPage);
}

/** Shortens the pause economy so an earned pause is affordable in a second, as gates.spec does. */
async function configureFastEconomy(extPage: Page, pauseMs: number): Promise<void> {
  const settings: Settings = await sendExtensionRequest(extPage, { type: 'getSettings' });
  const ack = await sendExtensionRequest(extPage, {
    type: 'updateSettings',
    settings: {
      ...settings,
      pause: { earnRatio: 10, capMs: Math.max(60_000, pauseMs), pauseMs, unlockMs: pauseMs },
      gate: { delayMs: 500, requireTypedPhrase: false, allowForceEnd: false },
    },
  });
  if (!ack.ok) throw new Error(ack.error);
}

async function takePause(extPage: Page, pauseMs: number): Promise<SessionSnapshotV2> {
  await expect
    .poll(async (): Promise<number> => (await snapshotOf(extPage)).bankMs, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(pauseMs);
  await extPage.getByRole('button', { name: /^Pause blocking for / }).click();
  const confirm = extPage.getByRole('button', { name: 'Take the pause' });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  return await waitForPhase(extPage, 'paused', 20_000);
}

test('a worker restart during indefinite focus recovers the same session', async ({
  freshInstallExtension,
  siteUrl,
}) => {
  let launch: FreshInstallLaunch = await installedExtension(freshInstallExtension);
  const url: string = siteUrl('/plain.html');
  const blockedPage: Page = await launch.context.newPage();
  await blockedPage.goto(url);
  await startUntilStoppedSession(launch.extPage);
  await expect(blockedPage.locator('focus-lock-overlay')).toBeAttached();

  const before: RuntimeStateV2 = await readRuntimeV2(liveWorker(launch));
  const sessionId: string = requireSessionId(before);
  const activation: EnforcementCheckpoint = requireCheckpoint(before);
  expect(activation.kind).toBe('activation');
  const focusBefore: number = (await snapshotOf(launch.extPage)).sessionFocusedMs;

  launch = await freshInstallExtension.restartWorker();

  const recovered: SessionSnapshotV2 = await waitForLifecycle(launch.extPage, 'active', 60_000);
  expect(recovered.phase).toBe('focus');
  expect(recovered.sessionEndsAt).toBeNull();
  expect(recovered.phaseEndsAt).toBeNull();
  expect(recovered.config?.duration).toEqual({ kind: 'until-stopped' });

  const restarted: FreshInstallLaunch = launch;
  await expect
    .poll(
      async (): Promise<string | null> =>
        (await readRuntimeV2(liveWorker(restarted))).enforcementCheckpoint?.kind ?? null,
      { timeout: 60_000 },
    )
    .toBe('recovery');
  const after: RuntimeStateV2 = await readRuntimeV2(liveWorker(restarted));
  const recovery: EnforcementCheckpoint = requireCheckpoint(after);
  expect(requireSessionId(after)).toBe(sessionId);
  expect(recovery.sessionId).toBe(sessionId);
  expect(recovery.operationId).not.toBe(activation.operationId);
  // The blocked document answered the command this recovery replayed, under the recovery's own
  // operation. A checkpoint that named the tab without an acknowledgement would be a session that
  // believes it is enforcing a page it never reached.
  expect(
    recovery.documents.filter(
      (ack): boolean => ack.url === url && ack.operationId === recovery.operationId,
    ),
  ).not.toHaveLength(0);
  await expect(blockedPage.locator('focus-lock-overlay')).toBeAttached();

  await expect
    .poll(async (): Promise<number> => (await snapshotOf(launch.extPage)).sessionFocusedMs, {
      timeout: 30_000,
    })
    .toBeGreaterThan(focusBefore);

  expectNoDiagnostics(freshInstallExtension.diagnostics);
});

test('a browser relaunch during indefinite focus keeps the session and counts the closed time', async ({
  restartableExtension,
  siteUrl,
}) => {
  const url: string = siteUrl('/plain.html');
  const first: ExtensionLaunch = await restartableExtension.launch();
  const blockedPage: Page = await first.context.newPage();
  await blockedPage.goto(url);
  await startUntilStoppedSession(first.extPage);
  await expect(blockedPage.locator('focus-lock-overlay')).toBeAttached();

  const beforeClose: SessionSnapshotV2 = await snapshotOf(first.extPage);
  const sessionId: string = requireSessionId(await readRuntimeV2(liveWorker(first)));
  const closedAt: number = Date.now();
  await restartableExtension.close();

  const second: ExtensionLaunch = await restartableExtension.launch();
  const relaunchedAt: number = Date.now();
  const closedForMs: number = relaunchedAt - closedAt;
  expect(closedForMs).toBeGreaterThan(0);

  const recovered: SessionSnapshotV2 = await waitForLifecycle(second.extPage, 'active', 60_000);
  expect(requireSessionId(await readRuntimeV2(liveWorker(second)))).toBe(sessionId);
  expect(recovered.sessionEndsAt).toBeNull();
  expect(recovered.phase).toBe('focus');
  // Wall-clock focus semantics: a browser that was closed during focus still spent that time in
  // focus. One second of slack covers the boundary between the last durable settle and the close.
  expect(recovered.sessionFocusedMs).toBeGreaterThanOrEqual(
    beforeClose.sessionFocusedMs + closedForMs - 1_000,
  );

  await expect(second.extPage.locator('.clock-stack__note')).toHaveText(UNTIL_STOPPED_LABEL);
  await expect(
    second.extPage
      .locator('.clock-stack__row')
      .filter({
        has: second.extPage
          .locator('.clock-stack__label')
          .filter({ hasText: new RegExp(`^${FOCUS_TIME_LABEL}$`) }),
      })
      .locator('.clock-stack__value'),
  ).toBeVisible();

  const restored: Page = await restoredPage(second, url);
  await expect(restored.locator('focus-lock-overlay')).toBeAttached();

  await second.extPage.getByRole('button', { name: END_SESSION_LABEL }).click();
  await waitForLifecycle(second.extPage, 'idle', 60_000);
  const ended: SessionEndedEventV2 = endEventFor(
    await readEventsV2FromWorker(liveWorker(second)),
    sessionId,
  );
  expect(ended.reason).toBe('manual-completed');
  expect((await readRuntimeV2(liveWorker(second))).pendingClosure).toBeNull();
  await expect(restored.locator('focus-lock-overlay')).toHaveCount(0);

  expectNoDiagnostics(restartableExtension.diagnostics);
});

/**
 * The shared arrangement for the two scenarios below: a timed session whose fixed end passes while
 * the browser is closed. Answers what the relaunched browser found.
 */
async function relaunchPastTimedEnd(
  restartableExtension: RestartableExtension,
  url: string,
): Promise<{
  launch: ExtensionLaunch;
  sessionId: string;
  sessionEndsAt: number;
  firstKind: string;
}> {
  const first: ExtensionLaunch = await restartableExtension.launch();
  // Two tabs on one address, because a cleanup claim records the effect this extension applied and
  // the address it applied it to rather than the tab it applied it through. Two claims then
  // describe the same effect, and the restore may undo either one for either claim. This
  // arrangement is what keeps the assertions below on the effect rather than on a tab.
  for (let opened: number = 0; opened < 2; opened += 1) {
    const blockedPage: Page = await first.context.newPage();
    await blockedPage.goto(url);
  }
  await startTestSession(first.extPage, {
    duration: { kind: 'timed', minutes: 0.2 },
    strictness: 'flexible',
  });
  const running: SessionSnapshotV2 = await snapshotOf(first.extPage);
  const sessionEndsAt: number | null = running.sessionEndsAt;
  if (sessionEndsAt === null) throw new Error('a timed session has no end');
  // Both tabs must actually be holding the mute before the browser closes, or the assertion after
  // the relaunch that none of them still holds it would be true of a session that never muted
  // anything.
  await expect
    .poll(async (): Promise<number> => (await mutedByExtension(liveWorker(first), url)).length, {
      timeout: 20_000,
    })
    .toBe(2);
  const sessionId: string = requireSessionId(await readRuntimeV2(liveWorker(first)));
  await restartableExtension.close();

  // The end has to pass while the browser is closed, which is the whole point, so the wait is on
  // the clock reaching the session's own stored end rather than on a duration.
  await expect
    .poll((): boolean => Date.now() >= sessionEndsAt + 250, { timeout: 60_000 })
    .toBe(true);

  const launch: ExtensionLaunch = await restartableExtension.launch();
  return {
    launch,
    sessionId,
    sessionEndsAt,
    firstKind: (await snapshotOf(launch.extPage)).lifecycle.kind,
  };
}

test('a browser relaunch after a timed end closes the session and frees the next one', async ({
  restartableExtension,
  siteUrl,
}) => {
  const url: string = siteUrl('/plain.html');
  const relaunched = await relaunchPastTimedEnd(restartableExtension, url);
  const launch: ExtensionLaunch = relaunched.launch;

  // A session that came back from the dead would show here, and nowhere else in this suite.
  expect(relaunched.firstKind).not.toBe('active');
  expect(['cleanup', 'idle']).toContain(relaunched.firstKind);
  expect((await readRuntimeV2(liveWorker(launch))).session).toBeNull();

  // The closure journal is durable before its checkpoint appends the end event, so the wait is on
  // the event arriving rather than on the journal existing.
  await expect
    .poll(
      async (): Promise<string[]> =>
        (await readEventsV2FromWorker(liveWorker(launch))).map(
          (event: SessionEventRecordV2): string =>
            'eventId' in event ? String(event.eventId) : `legacy:${event.t}`,
        ),
      { timeout: 30_000 },
    )
    .toContain(`${relaunched.sessionId}:end`);
  const ended: SessionEndedEventV2 = endEventFor(
    await readEventsV2FromWorker(liveWorker(launch)),
    relaunched.sessionId,
  );
  expect(ended.reason).toBe('timer-completed');
  expect(ended.outcome).toBe('completed');
  // Exactly the stored end, not the instant the browser happened to come back.
  expect(ended.at).toBe(relaunched.sessionEndsAt);

  // The half this scenario was written to catch. The closure's tab claim was taken before the
  // relaunch and Chrome renumbers every restored tab, so a cleanup that matched claims by tab ID
  // could never settle this one: the profile stayed in cleanup, every start answered
  // `closure-cleanup-pending`, and the backoff pushed the next attempt a quarter of an hour out.
  // Fixed in `6cda903`. Reaching idle, releasing the stopped page, and starting the next session
  // is what proves it, and the three assertions below are the ones that went red before it.
  await waitForLifecycle(launch.extPage, 'idle', 90_000);
  expect((await readRuntimeV2(liveWorker(launch))).pendingClosure).toBeNull();
  const restored: Page = await restoredPage(launch, url);
  await expect(restored.locator('focus-lock-overlay')).toHaveCount(0);
  // Both tabs carried the mute and either could have satisfied either claim, so what is asserted is
  // that no tab is left holding this extension's mute, not which tab a given claim matched.
  expect(await mutedByExtension(liveWorker(launch), url)).toEqual([]);
  await startUntilStoppedSession(launch.extPage);
  await waitForLifecycle(launch.extPage, 'active', 60_000);

  // A live-view refresh during closure cleanup used to build a runtime the storage boundary
  // refused, and the restored blocked page drove one on every boot down this path. Fixed in
  // `bd3024d`, so this window is now expected to be quiet like any other.
  expectNoDiagnostics(restartableExtension.diagnostics);
});

test('a worker restart racing a start settles on exactly one outcome', async ({
  freshInstallExtension,
}) => {
  let launch: FreshInstallLaunch = await installedExtension(freshInstallExtension);
  const stored: ListsConfig = await sendExtensionRequest(launch.extPage, { type: 'getLists' });
  const lists: ListsConfig = { ...stored, custom: [{ kind: 'host', pattern: BLOCKED_HOST }] };
  expect(await sendExtensionRequest(launch.extPage, { type: 'updateLists', lists })).toEqual({
    ok: true,
  });
  const config: SessionConfigV2 = {
    mode: 'blacklist',
    strictness: 'flexible',
    duration: { kind: 'until-stopped' },
    cycling: null,
    intention: 'restart race',
    source: 'manual',
    scheduleOccurrence: null,
    rules: rulesFromLists(lists),
  };
  const startsBefore: number = eventIdsOfKind(
    await readEventsV2FromWorker(liveWorker(launch)),
    'sessionStarted',
  ).length;

  // The lists are already durable, so the only thing in flight when the worker stops is the start
  // transition itself. The start is fired and not awaited, and the restart follows with nothing
  // between them.
  const requested: Promise<unknown> = launch.extPage
    .evaluate(
      async (cfg: SessionConfigV2): Promise<unknown> =>
        await chrome.runtime.sendMessage({ type: 'startSession', config: cfg }),
      config,
    )
    .catch((): undefined => undefined);
  launch = await freshInstallExtension.restartWorker();
  const answer: unknown = await requested;

  await expect
    .poll(async (): Promise<string> => (await snapshotOf(launch.extPage)).lifecycle.kind, {
      timeout: 30_000,
    })
    .toMatch(/^(active|idle)$/);
  const settled: SessionLifecycleV2['kind'] = (await snapshotOf(launch.extPage)).lifecycle.kind;

  const startIds: string[] = eventIdsOfKind(
    await readEventsV2FromWorker(liveWorker(launch)),
    'sessionStarted',
  );
  expect(new Set(startIds).size).toBe(startIds.length);
  expect(startIds.length - startsBefore).toBeLessThanOrEqual(1);

  const runtime: RuntimeStateV2 = await readRuntimeV2(liveWorker(launch));
  expect(runtime.pendingEnforcementTransition).toBeNull();
  expect(runtime.pendingClosure).toBeNull();
  if (settled === 'idle') {
    expect(runtime.session).toBeNull();
  } else {
    // A session that survived the race is the session its own start event named, once.
    const sessionId: string = requireSessionId(runtime);
    expect(startIds.filter((id: string): boolean => id === `${sessionId}:start`)).toHaveLength(1);
  }
  // Recorded rather than asserted: which side of the race this run landed on is Chrome's timing,
  // and both sides are legal. The invariants above hold either way.
  test.info().annotations.push({
    type: 'restart race outcome',
    description: `${settled}, start answered ${JSON.stringify(answer)}`,
  });

  expectNoDiagnostics(freshInstallExtension.diagnostics);
});

test('a worker restart during an indefinite pause keeps the pause and still resumes', async ({
  freshInstallExtension,
}) => {
  const pauseMs: number = 20_000;
  let launch: FreshInstallLaunch = await installedExtension(freshInstallExtension);
  await configureFastEconomy(launch.extPage, pauseMs);
  await startUntilStoppedSession(launch.extPage);
  const sessionId: string = requireSessionId(await readRuntimeV2(liveWorker(launch)));

  const paused: SessionSnapshotV2 = await takePause(launch.extPage, pauseMs);
  const pauseEndsAt: number | null = paused.phaseEndsAt;
  if (pauseEndsAt === null) throw new Error('an indefinite pause has no end');
  expect(paused.sessionEndsAt).toBeNull();

  launch = await freshInstallExtension.restartWorker();

  const afterRestart: SessionSnapshotV2 = await snapshotOf(launch.extPage);
  expect(afterRestart.phase).toBe('paused');
  expect(afterRestart.phaseEndsAt).toBe(pauseEndsAt);
  expect(afterRestart.sessionEndsAt).toBeNull();
  expect(requireSessionId(await readRuntimeV2(liveWorker(launch)))).toBe(sessionId);

  const resumed: SessionSnapshotV2 = await waitForPhase(launch.extPage, 'focus', 60_000);
  expect(resumed.lifecycle.kind).toBe('active');
  expect(resumed.phaseEndsAt).toBeNull();
  expect(resumed.sessionEndsAt).toBeNull();
  expect(resumed.phaseStartedAt ?? 0).toBeGreaterThanOrEqual(pauseEndsAt);
  expect((await readRuntimeV2(liveWorker(launch))).pendingEnforcementTransition).toBeNull();

  expectNoDiagnostics(freshInstallExtension.diagnostics);
});

test('a scheduled indefinite session keeps its occurrence across a worker restart', async ({
  freshInstallExtension,
}) => {
  let launch: FreshInstallLaunch = await installedExtension(freshInstallExtension);
  const clock: { hours: number; minutes: number; day: number } = await liveWorker(launch).evaluate(
    (): { hours: number; minutes: number; day: number } => {
      const at: Date = new Date();
      return { hours: at.getHours(), minutes: at.getMinutes(), day: at.getDay() };
    },
  );
  const nowMinutes: number = clock.hours * 60 + clock.minutes;
  test.skip(
    nowMinutes < MIDNIGHT_GUARD_MINUTES || nowMinutes > 24 * 60 - MIDNIGHT_GUARD_MINUTES,
    'a local wall-clock window cannot stay open across local midnight',
  );
  const asHhMm: (minutes: number) => string = (minutes: number): string =>
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const entry: ScheduleEntryV2 = {
    id: 'e2e-recovery-window',
    days: [clock.day],
    start: asHhMm(nowMinutes - 1),
    end: asHhMm(nowMinutes + 9),
    duration: { kind: 'until-stopped' },
    mode: 'blacklist',
    strictness: 'flexible',
    cycling: null,
    intention: 'scheduled indefinite recovery',
    enabled: true,
  };
  const settings: Settings = await sendExtensionRequest(launch.extPage, { type: 'getSettings' });
  const ack = await sendExtensionRequest(launch.extPage, {
    type: 'updateSettings',
    settings: { ...settings, schedule: [entry] },
  });
  if (!ack.ok) throw new Error(ack.error);

  const scheduled: SessionSnapshotV2 = await waitForLifecycle(launch.extPage, 'active', 60_000);
  expect(scheduled.config?.source).toBe('schedule');
  const token: string | undefined = scheduled.config?.scheduleOccurrence?.token;
  expect(token).toBeDefined();
  const before: RuntimeStateV2 = await readRuntimeV2(liveWorker(launch));
  const sessionId: string = requireSessionId(before);
  // The whole record, not merely one with the right token and reason. A restart that lost the
  // session would let the still-open window start a new one, which would write its own handled
  // record for the same token, and a presence check would call that a pass.
  const handledBefore: HandledScheduleOccurrence[] = before.handledScheduleOccurrences.filter(
    (handled: HandledScheduleOccurrence): boolean => handled.token === token,
  );
  expect(handledBefore).toHaveLength(1);
  expect(handledBefore[0]?.reason).toBe('started');

  launch = await freshInstallExtension.restartWorker();

  const recovered: SessionSnapshotV2 = await waitForLifecycle(launch.extPage, 'active', 60_000);
  expect(requireSessionId(await readRuntimeV2(liveWorker(launch)))).toBe(sessionId);
  expect(recovered.config?.source).toBe('schedule');
  expect(recovered.config?.duration).toEqual({ kind: 'until-stopped' });
  expect(recovered.config?.scheduleOccurrence?.token).toBe(token);
  expect(recovered.sessionEndsAt).toBeNull();
  expect(
    (await readRuntimeV2(liveWorker(launch))).handledScheduleOccurrences.filter(
      (handled: HandledScheduleOccurrence): boolean => handled.token === token,
    ),
  ).toEqual(handledBefore);

  expectNoDiagnostics(freshInstallExtension.diagnostics);
});
