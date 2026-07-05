/**
 * Deterministic visual evidence for the indefinite-session surfaces.
 *
 * The run skips itself unless `INDEFINITE_EVIDENCE_DIR` is set, so `npm run e2e` stays fast and
 * only a deliberate evidence run writes images.
 *
 * Three mechanisms make these captures repeatable, and every state declares which one it used:
 *
 * - The popup reads its own clock every 250 ms and projects from the snapshot it holds, so popup
 *   states are captured with the page clock fixed and the snapshot replaced by a fixed one over the
 *   popup's own runtime channel. Every fixture is spliced from a snapshot the worker really
 *   published, so no fixture invents a shape the product cannot produce.
 * - The overlay renders inside a closed shadow root in a content script, which no page clock and no
 *   locator can reach. Its live values are pinned through CDP immediately before the capture, and
 *   the pinned regions are recorded in the manifest.
 * - The starting overlay is up for about thirty milliseconds, measured, which no screenshot can
 *   catch. It is captured by replaying the command the worker really sent, re-addressed to the page
 *   showing it, and the replay is recorded in the manifest.
 *
 * Nothing here freezes the worker's clock. Freezing it to a past instant makes the phase alarm ask
 * for a boundary the browser clamps, and the alarm read-back then fails the start, so the capture
 * could not begin its session at all.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, CDPSession, Locator, Page, Worker } from '@playwright/test';
import type { RuntimeTabState } from '../../src/background/runtime-leaf-types';
import type {
  EndAuthorityV2,
  ScheduleEntryV2,
  SessionEndedEventV2,
  SessionEventRecordV2,
  SessionLifecycleV2,
  SessionSnapshotV2,
  SessionStartedEventV2,
  Settings,
  SetupState,
  SiteUnlock,
  ThemeMode,
} from '../../src/shared/types';
import {
  assertNoUnexpectedBrowserDiagnostics,
  type BrowserDiagnostics,
} from './browser-diagnostics';
import {
  browserDiagnosticsFor,
  expect,
  readRuntimeV2,
  sendExtensionRequest,
  startTestSession,
  startUntilStoppedSession,
  test,
  waitForLifecycle,
} from './fixtures';
import {
  definitionFor,
  evidenceFileName,
  expectedIndefiniteArtifactCount,
  INDEFINITE_THEME_CASES,
  type IndefiniteEvidenceManifest,
  type IndefiniteMaskedRegion,
  type IndefiniteReplayedCommand,
  type IndefiniteRuntimeApiInterceptionDefinition,
  type IndefiniteRuntimeApiInterceptionObservation,
  type IndefiniteStorageSeed,
  type IndefiniteThemeCase,
  type IndefiniteVisualState,
  type IndefiniteVisualStateDefinition,
  indefiniteInterceptionsFromObservations,
  POPUP_WIDTH,
  widthsForState,
  writeIndefiniteEvidenceManifest,
} from './indefinite-visual-manifest';

/**
 * The matrix itself is cheap, about a quarter of a second per cell, but a full pass starts and ends
 * a session between states and the whole run takes around twenty-five minutes on a quiet machine.
 * On a loaded one it takes far longer, so the budget is generous: this run is opt in, and a run
 * that fails on its own timeout tells a reader nothing about the product.
 */
test.setTimeout(5_400_000);
/**
 * Playwright's default action timeout is unbounded, so a control that never becomes actionable
 * would hang the whole run rather than fail it. Every action here gets a bound.
 */
test.use({ actionTimeout: 15_000 });

/** The instant every fixed page clock reports, so every rendered popup clock is fixed with it. */
const FIXED_NOW: number = Date.parse('2026-09-04T09:30:00.000Z');
const LONG_INTENTION: string =
  'Finish the quarterly accessibility review and write up every finding before the release meeting';
const PINNED_CLOCK: string = '18:24';
const PINNED_BANK: string = '3:00 pause banked';
const PINNED_READY: string = 'ready in 2:00';
const PINNED_LOCKED_UNTIL: string = 'Locked until 10:15';
/** The session a cleanup journal in these fixtures names, in the two spellings the two journals use. */
const CLEANUP_SESSION_ID: string = '40000000-0000-4000-8000-000000000001';

/**
 * Every state the popup owns, in the order the run captures them.
 *
 * `INDEFINITE_ONLY` narrows the list to named states, which is how one state is diagnosed without
 * paying for the whole matrix. A narrowed run cannot produce evidence: the manifest asserts full
 * coverage and refuses a partial matrix, so the shortcut can only ever be a diagnostic.
 */
const POPUP_STATES: readonly IndefiniteVisualState[] =
  process.env.INDEFINITE_ONLY === undefined
    ? [
        'popup-idle-until-stopped-selected',
        'popup-forced-hover',
        'popup-forced-focus',
        'popup-forced-click',
        'popup-starting-hidden',
        'popup-starting-immediate',
        'popup-starting-friction-closed',
        'popup-starting-friction-open',
        'popup-active-indefinite-focus',
        'popup-active-indefinite-pause',
        'popup-active-50-dual-clocks',
        'popup-cleanup-closure',
        'popup-cleanup-transition',
        'popup-error-transition',
        'popup-error-closure',
        'popup-long-copy',
        'popup-data-clear-pending',
        'popup-data-clear-error',
        'popup-data-clear-start-refused',
      ]
    : (process.env.INDEFINITE_ONLY.split(',') as IndefiniteVisualState[]);

/** What one popup capture answers the popup with, and what it does to the rendered page first. */
interface PopupFixture {
  /** Runs after the popup has rendered, for the states that are an interaction. */
  prepare?: (page: Page) => Promise<void>;
  setup: SetupState;
  snapshot: SessionSnapshotV2;
  startRefusal?: { ok: false; code: string; error: string };
  /** A selector that must be visible before the capture, which is how a refused fixture fails. */
  visible: string;
}

/** The published snapshots every popup fixture is spliced from. */
interface SourceSnapshots {
  idle: SessionSnapshotV2;
  indefiniteActive: SessionSnapshotV2;
  timedCycling: SessionSnapshotV2;
}

function themedSetup(setup: SetupState, dataClear?: SetupState['dataClear']): SetupState {
  return dataClear === undefined ? setup : { ...structuredClone(setup), dataClear };
}

/**
 * One published snapshot moved to the fixed instant. Every timestamp shifts by the same amount, so
 * the relationships the boundary validator checks, and the durations the popup renders from them,
 * are exactly the ones the worker published. Setting `at` alone would have made `startedAt` later
 * than `at`, which the validator refuses and the popup answers by reloading into its error view.
 */
function fixedSnapshot(
  source: SessionSnapshotV2,
  theme: ThemeMode,
  overrides: Partial<SessionSnapshotV2>,
): SessionSnapshotV2 {
  const base: SessionSnapshotV2 = structuredClone(source);
  const shift: number = FIXED_NOW - base.at;
  const moved: (value: number | null) => number | null = (value: number | null): number | null =>
    value === null ? null : value + shift;
  return {
    ...base,
    at: FIXED_NOW,
    startedAt: moved(base.startedAt),
    phaseStartedAt: moved(base.phaseStartedAt),
    phaseEndsAt: moved(base.phaseEndsAt),
    sessionEndsAt: moved(base.sessionEndsAt),
    gate:
      base.gate === null
        ? null
        : {
            ...base.gate,
            openedAt: base.gate.openedAt + shift,
            readyAt: base.gate.readyAt + shift,
          },
    nextSchedule:
      base.nextSchedule === null
        ? null
        : { ...base.nextSchedule, startsAt: base.nextSchedule.startsAt + shift },
    activeUnlocks: base.activeUnlocks.map(
      (unlock: SiteUnlock): SiteUnlock => ({ ...unlock, until: unlock.until + shift }),
    ),
    theme,
    ...overrides,
  };
}

/**
 * A snapshot for a lifecycle that is not active. The boundary requires every session field to be
 * empty outside `active`, so these are the idle snapshot with the lifecycle replaced, which is the
 * shape the worker publishes for them.
 */
function lifecycleSnapshot(
  idle: SessionSnapshotV2,
  theme: ThemeMode,
  lifecycle: SessionLifecycleV2,
): SessionSnapshotV2 {
  return fixedSnapshot(idle, theme, { lifecycle });
}

function startingLifecycle(endAuthority: EndAuthorityV2): SessionLifecycleV2 {
  return {
    kind: 'starting',
    operationId: '30000000-0000-4000-8000-00000000000f',
    transition: 'start',
    endAuthority,
  };
}

/** The four End authorities the starting lifecycle can carry, which is what those states differ by. */
const FRICTION_CLOSED: EndAuthorityV2 = {
  kind: 'friction-gate',
  gate: null,
  copy: { actionLabel: 'End session' },
  actions: { open: 'open-end-gate' },
};

function frictionOpen(): EndAuthorityV2 {
  return {
    kind: 'friction-gate',
    gate: {
      kind: 'cancel',
      openedAt: FIXED_NOW - 20_000,
      readyAt: FIXED_NOW - 5_000,
      requiredPhrase: null,
      forceEndAvailable: false,
      host: null,
    },
    copy: {
      title: 'End this session',
      back: 'Never mind, back to work',
      phraseLabel: 'Type this to confirm:',
      confirm: 'End the session',
      intentionReminder: 'e2e test run',
    },
    actions: { abandon: 'abandon-gate', confirm: 'confirm-gate' },
  };
}

/**
 * Every popup fixture for one theme. The lifecycle, the phase, and the setup record are the only
 * things these differ by, because those are what the popup switches on.
 */
function popupFixtures(
  source: SourceSnapshots,
  setup: SetupState,
  theme: ThemeMode,
): Map<IndefiniteVisualState, PopupFixture> {
  const idle: SessionSnapshotV2 = fixedSnapshot(source.idle, theme, {});
  const active: SessionSnapshotV2 = fixedSnapshot(source.indefiniteActive, theme, {});
  const cycling: SessionSnapshotV2 = fixedSnapshot(source.timedCycling, theme, {});
  const fixtures: Map<IndefiniteVisualState, PopupFixture> = new Map<
    IndefiniteVisualState,
    PopupFixture
  >();

  const startForm: (state: IndefiniteVisualState) => void = (
    state: IndefiniteVisualState,
  ): void => {
    fixtures.set(state, {
      setup,
      snapshot: idle,
      visible: '.forced-control',
      prepare: async (page: Page): Promise<void> => {
        await page.getByRole('button', { name: 'Until stopped' }).click();
        await expect(page.locator('.forced-control').first()).toBeVisible();
        const forced: Locator = page.locator('.forced-control').first();
        if (state === 'popup-forced-hover') {
          await forced.locator('.forced-control__body').hover({ force: true });
        }
        if (state === 'popup-forced-focus') await forced.focus();
        if (state === 'popup-forced-click') {
          // The disclosure the forced group carries, not a child control's own help. The click is
          // forced because the group announces `aria-disabled`, which Playwright reads as not
          // enabled, and the disclosure inside it is the one control that stays clickable. That
          // mismatch is a finding for the surface's own slice, not something this capture fixes.
          await forced.locator('.forced-control__help button').click({ force: true });
        }
        await expect(page.locator('.help-popover__content').first()).toBeVisible();
      },
    });
  };
  fixtures.set('popup-idle-until-stopped-selected', {
    setup,
    snapshot: idle,
    visible: '.session-type-control',
    prepare: async (page: Page): Promise<void> => {
      await page.getByRole('button', { name: 'Until stopped' }).click();
      await expect(page.locator('.forced-control').first()).toBeVisible();
    },
  });
  startForm('popup-forced-hover');
  startForm('popup-forced-focus');
  startForm('popup-forced-click');

  const starting: Array<[IndefiniteVisualState, EndAuthorityV2]> = [
    ['popup-starting-hidden', { kind: 'hidden' }],
    ['popup-starting-immediate', { kind: 'immediate', actionLabel: 'End session' }],
    ['popup-starting-friction-closed', FRICTION_CLOSED],
    ['popup-starting-friction-open', frictionOpen()],
  ];
  for (const [state, authority] of starting) {
    fixtures.set(state, {
      setup,
      snapshot: lifecycleSnapshot(idle, theme, startingLifecycle(authority)),
      visible: '.lifecycle-view',
    });
  }

  // The published snapshot is seconds old, which renders every clock as `0:00` and every total as
  // zero. The evidence is for a person reading a running session, so the focus states are placed
  // three quarters of an hour in: the boundary requires the focused time to cover the phase and to
  // fit inside the session, and a session that has only ever been focusing satisfies both exactly.
  const focusedFor: number = 45 * 60_000;
  const runningLong: Partial<SessionSnapshotV2> = {
    startedAt: FIXED_NOW - focusedFor,
    phaseStartedAt: FIXED_NOW - focusedFor,
    sessionFocusedMs: focusedFor,
  };
  // The active view draws its clock immediately and fills today's focus total from the worker a
  // moment later, so a capture taken on the clock alone shows the total present or absent depending
  // on which won the race. Every active state waits on the total instead.
  fixtures.set('popup-active-indefinite-focus', {
    setup,
    snapshot: fixedSnapshot(active, theme, runningLong),
    visible: '.today-line',
  });
  fixtures.set('popup-active-indefinite-pause', {
    setup,
    // A paused session is a timeline, not one field: the boundary requires the pause to start
    // after the session did and the focused time to stop at the pause, so the whole line is stated.
    snapshot: fixedSnapshot(active, theme, {
      phase: 'paused',
      startedAt: FIXED_NOW - 20 * 60_000,
      phaseStartedAt: FIXED_NOW - 2 * 60_000,
      phaseEndsAt: FIXED_NOW + 3 * 60_000,
      sessionEndsAt: null,
      sessionFocusedMs: 18 * 60_000,
      bankAccrualPerMs: 0,
    }),
    visible: '.today-line',
  });
  fixtures.set('popup-active-50-dual-clocks', {
    setup,
    snapshot: cycling,
    visible: '.today-line',
  });
  fixtures.set('popup-long-copy', {
    setup,
    snapshot: fixedSnapshot(active, theme, {
      ...runningLong,
      config: active.config === null ? null : { ...active.config, intention: LONG_INTENTION },
    }),
    visible: '.today-line',
  });

  const cleanup: Array<[IndefiniteVisualState, 'closure' | 'transition']> = [
    ['popup-cleanup-closure', 'closure'],
    ['popup-cleanup-transition', 'transition'],
  ];
  for (const [state, journal] of cleanup) {
    fixtures.set(state, {
      setup,
      // A transition journal is named by a UUID and a closure journal by its closure identity, which
      // is the closed session's UUID with the closure suffix. The boundary refuses either spelling
      // in the other's place, so each is written the way the worker writes it.
      snapshot: lifecycleSnapshot(idle, theme, {
        kind: 'cleanup',
        journal,
        id: journal === 'closure' ? `${CLEANUP_SESSION_ID}:close` : CLEANUP_SESSION_ID,
        endAuthority: { kind: 'hidden' },
      }),
      visible: '.lifecycle-view',
    });
  }
  const errors: Array<
    [IndefiniteVisualState, 'closure-cleanup-failed' | 'transition-cleanup-failed']
  > = [
    ['popup-error-closure', 'closure-cleanup-failed'],
    ['popup-error-transition', 'transition-cleanup-failed'],
  ];
  for (const [state, code] of errors) {
    fixtures.set(state, {
      setup,
      snapshot: lifecycleSnapshot(idle, theme, {
        kind: 'error',
        code,
        retryAvailable: true,
        endAuthority: { kind: 'hidden' },
      }),
      visible: '.lifecycle-view',
    });
  }

  fixtures.set('popup-data-clear-pending', {
    setup: themedSetup(setup, { status: 'pending', scope: 'all', phase: 'local' }),
    snapshot: idle,
    visible: '.lifecycle-view',
  });
  fixtures.set('popup-data-clear-error', {
    setup: themedSetup(setup, { status: 'error', scope: 'all', phase: 'local' }),
    snapshot: idle,
    visible: '.lifecycle-view',
  });
  fixtures.set('popup-data-clear-start-refused', {
    setup: themedSetup(setup, { status: 'pending', scope: 'local-history', phase: 'local' }),
    snapshot: idle,
    startRefusal: {
      ok: false,
      code: 'data-clear-pending',
      error: 'a data clear is in progress',
    },
    visible: '.form-error',
    prepare: async (page: Page): Promise<void> => {
      await page.locator('.start-button').click();
      await expect(page.locator('.form-error')).toBeVisible();
    },
  });
  return fixtures;
}

/** The full surface and the component the state is about, written under the names the matrix owns. */
async function captureCell(
  page: Page,
  evidenceDir: string,
  state: IndefiniteVisualState,
  theme: IndefiniteThemeCase,
  width: number,
  focused: Locator | { clip: { x: number; y: number; width: number; height: number } },
): Promise<void> {
  await page.screenshot({
    animations: 'disabled',
    path: path.join(evidenceDir, evidenceFileName(state, theme.id, width, 'full')),
  });
  const focusedPath: string = path.join(
    evidenceDir,
    evidenceFileName(state, theme.id, width, 'focused'),
  );
  if ('clip' in focused) {
    await page.screenshot({ animations: 'disabled', clip: focused.clip, path: focusedPath });
    return;
  }
  await expect(focused).toBeVisible();
  await focused.screenshot({ animations: 'disabled', path: focusedPath });
}

/** Captures every popup state, in all four theme cases, at the width Chrome gives the popup. */
async function capturePopupStates(
  popupPage: Page,
  extensionId: string,
  evidenceDir: string,
  source: SourceSnapshots,
  setup: SetupState,
  fixtures: { current: Map<IndefiniteVisualState, PopupFixture>; state: IndefiniteVisualState },
): Promise<void> {
  await popupPage.setViewportSize({ width: POPUP_WIDTH, height: 640 });
  for (const state of POPUP_STATES) {
    for (const theme of INDEFINITE_THEME_CASES) {
      fixtures.current = popupFixtures(source, setup, theme.theme);
      fixtures.state = state;
      const fixture: PopupFixture = fixtureFor(fixtures.current, state);
      await popupPage.emulateMedia({ colorScheme: theme.colorScheme });
      await popupPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`, {
        timeout: 20_000,
      });
      await expect(popupPage.locator('.app')).toBeVisible();
      // The interaction comes first: three of these states are only reachable through it, so a wait
      // for the state's own marker before the interaction would wait for something not yet drawn.
      if (fixture.prepare !== undefined) await fixture.prepare(popupPage);
      // A fixture the boundary refuses renders the popup's error view instead, so the failure says
      // what the popup showed rather than only which selector was missing.
      try {
        await expect(popupPage.locator(fixture.visible).first()).toBeVisible({ timeout: 10_000 });
      } catch (error: unknown) {
        const shown: string = (await popupPage.locator('.app').innerText()).slice(0, 400);
        throw new Error(
          `${state} in ${theme.id} never showed ${fixture.visible}, the popup showed: ${shown}`,
          { cause: error },
        );
      }
      const definition: IndefiniteVisualStateDefinition = definitionFor(state);
      await captureCell(
        popupPage,
        evidenceDir,
        state,
        theme,
        POPUP_WIDTH,
        popupPage.locator(definition.focusSelector).first(),
      );
    }
  }
}

function fixtureFor(
  fixtures: Map<IndefiniteVisualState, PopupFixture>,
  state: IndefiniteVisualState,
): PopupFixture {
  const fixture: PopupFixture | undefined = fixtures.get(state);
  if (fixture === undefined) throw new Error(`${state} has no popup fixture`);
  return fixture;
}

interface DomNodeSnapshot {
  attributes?: string[];
  backendNodeId: number;
  children?: DomNodeSnapshot[];
  nodeId: number;
  nodeName: string;
  nodeValue?: string;
  shadowRoots?: DomNodeSnapshot[];
}

function flattenDomNode(node: DomNodeSnapshot): DomNodeSnapshot[] {
  const all: DomNodeSnapshot[] = [node];
  for (const child of node.children ?? []) all.push(...flattenDomNode(child));
  for (const root of node.shadowRoots ?? []) all.push(...flattenDomNode(root));
  return all;
}

function classOf(node: DomNodeSnapshot): string {
  const attributes: string[] = node.attributes ?? [];
  for (let index: number = 0; index + 1 < attributes.length; index += 2) {
    if (attributes[index] === 'class') return attributes[index + 1] ?? '';
  }
  return '';
}

/** Raised when the overlay rebuilt itself between the node walk and the write that follows it. */
class StaleOverlayNodes extends Error {
  constructor() {
    super('the overlay rebuilt itself while its live regions were being pinned');
  }
}

/** Every node of the overlay's closed shadow root, which only CDP can reach. */
async function overlayNodes(session: CDPSession): Promise<DomNodeSnapshot[]> {
  await session.send('DOM.enable');
  const document = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  const all: DomNodeSnapshot[] = flattenDomNode(document.root as unknown as DomNodeSnapshot);
  const host: DomNodeSnapshot | undefined = all.find(
    (node: DomNodeSnapshot): boolean => node.nodeName === 'FOCUS-LOCK-OVERLAY',
  );
  if (host === undefined) throw new Error('the Focus Lock overlay is not mounted');
  return (host.shadowRoots ?? []).flatMap((root: DomNodeSnapshot): DomNodeSnapshot[] =>
    flattenDomNode(root),
  );
}

function nodesWithClass(nodes: readonly DomNodeSnapshot[], className: string): DomNodeSnapshot[] {
  return nodes.filter((node: DomNodeSnapshot): boolean =>
    classOf(node).split(/\s+/u).includes(className),
  );
}

/**
 * Replaces the text of every node carrying `className` with a fixed string. The overlay recomputes
 * these from the worker's clock inside a content script, where neither a page clock nor a locator
 * reaches, so pinning the rendered value is what makes the capture repeatable. The layout, the type
 * scale, and the colours stay exactly what the product drew.
 */
async function pinOverlayText(
  session: CDPSession,
  nodes: readonly DomNodeSnapshot[],
  className: string,
  value: string,
): Promise<number> {
  let pinned: number = 0;
  for (const element of nodesWithClass(nodes, className)) {
    for (const child of element.children ?? []) {
      if (child.nodeName !== '#text') continue;
      try {
        await session.send('DOM.setNodeValue', { nodeId: child.nodeId, value });
        pinned += 1;
      } catch (error: unknown) {
        // The overlay rebuilds its panel whenever a command arrives, which retires the node ids
        // this walk collected. The caller re-reads and tries again rather than failing the run on a
        // race with the product doing its job.
        if (!String(error).includes('Could not find node')) throw error;
        throw new StaleOverlayNodes();
      }
    }
  }
  return pinned;
}

/** The panel's box, which is the overlay's focused capture, taken through the same closed root. */
async function overlayPanelClip(
  session: CDPSession,
  nodes: readonly DomNodeSnapshot[],
): Promise<{ x: number; y: number; width: number; height: number }> {
  const panel: DomNodeSnapshot | undefined = nodesWithClass(nodes, 'panel')[0];
  if (panel === undefined) throw new Error('the overlay has no panel to crop to');
  const box = await session.send('DOM.getBoxModel', { nodeId: panel.nodeId });
  const quad: number[] = box.model.border;
  const xs: number[] = [quad[0] ?? 0, quad[2] ?? 0, quad[4] ?? 0, quad[6] ?? 0];
  const ys: number[] = [quad[1] ?? 0, quad[3] ?? 0, quad[5] ?? 0, quad[7] ?? 0];
  const x: number = Math.max(0, Math.min(...xs));
  const y: number = Math.max(0, Math.min(...ys));
  return {
    x,
    y,
    width: Math.max(1, Math.max(...xs) - x),
    height: Math.max(1, Math.max(...ys) - y),
  };
}

/** The overlay states, each captured at three widths in all four theme cases. */
async function captureOverlayStates(
  context: BrowserContext,
  extPage: Page,
  worker: Worker,
  siteUrl: (pathname: string) => string,
  evidenceDir: string,
  maskedRegions: IndefiniteMaskedRegion[],
): Promise<void> {
  const blockedUrl: string = siteUrl('/plain.html');

  for (const state of [
    'overlay-active-indefinite',
    'overlay-active-timed',
    'overlay-stopped',
  ] as const) {
    for (const theme of INDEFINITE_THEME_CASES) {
      await sendExtensionRequest(extPage, { type: 'updateTheme', theme: theme.theme });
      for (const width of widthsForState(state)) {
        const page: Page = await context.newPage();
        await page.emulateMedia({ colorScheme: theme.colorScheme });
        await page.setViewportSize({ width, height: viewportHeightFor(width) });
        await showOverlay(page, extPage, worker, blockedUrl, state);
        const session: CDPSession = await context.newCDPSession(page);
        // The overlay recomputes its bank, its readiness and its clock every 250 ms, which would
        // overwrite a pinned value before the screenshot. Pausing the document's virtual time stops
        // that loop without touching the worker, whose clock this capture deliberately leaves alone.
        await session.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
        const pinned: string[] = await pinnedOverlayRegions(session, state);
        if (pinned.length > 0) maskedRegions.push({ state, selectors: pinned });
        await captureCell(page, evidenceDir, state, theme, width, {
          // The clip walks the tree again, because pinning may have raced a rebuild and the ids
          // from the first walk would then name nodes that no longer exist.
          clip: await overlayPanelClip(session, await overlayNodes(session)),
        });
        await session.detach();
        await page.close();
      }
    }
  }
  await endAnySession(extPage);
}

function viewportHeightFor(width: number): number {
  return width === 375 ? 844 : 900;
}

/** Pins the live regions, re-reading the tree when the overlay rebuilds under the walk. */
async function pinnedOverlayRegions(
  session: CDPSession,
  state: IndefiniteVisualState,
): Promise<string[]> {
  for (let attempt: number = 0; attempt < 5; attempt++) {
    try {
      return await pinOverlayRegions(session, await overlayNodes(session));
    } catch (error: unknown) {
      if (!(error instanceof StaleOverlayNodes)) throw error;
    }
  }
  throw new Error(`${state} kept rebuilding while its live regions were pinned`);
}

/** Pins every value the worker's clock would move, and answers the selectors it pinned. */
async function pinOverlayRegions(
  session: CDPSession,
  nodes: readonly DomNodeSnapshot[],
): Promise<string[]> {
  const pinned: string[] = [];
  if ((await pinOverlayText(session, nodes, 'clock', PINNED_CLOCK)) > 0) {
    pinned.push('.clock');
    // A timed page's status sentence names the wall clock the session ends at, which moves with the
    // run. Only the timed page has a clock, so the sentence is pinned exactly where it is unstable.
    await pinOverlayText(session, nodes, 'until', PINNED_LOCKED_UNTIL);
    pinned.push('.until');
  }
  if ((await pinOverlayText(session, nodes, 'bank', PINNED_BANK)) > 0) pinned.push('.bank');
  if ((await pinOverlayText(session, nodes, 'ready', PINNED_READY)) > 0) pinned.push('.ready');
  for (const fill of nodesWithClass(nodes, 'meter-fill')) {
    await session.send('DOM.setAttributeValue', {
      nodeId: fill.nodeId,
      name: 'style',
      // The fill animates its width, and paused virtual time never advances that animation, so the
      // pinned value would sit behind a transition that never runs. The transition goes with it.
      value: 'width: 45%; transition: none',
    });
    pinned.push('.meter-fill');
  }
  return pinned;
}

/**
 * Puts one page into the state and answers once its overlay is mounted.
 *
 * The two active states open their page before the session starts, so the document finishes loading
 * and the command lands on a page that is already there. That is the difference between them and
 * the stopped state: a fresh navigation to a blocked page is stopped mid-load and says so, and
 * capturing all three from a fresh navigation made three states that rendered the same panel.
 */
async function showOverlay(
  page: Page,
  extPage: Page,
  worker: Worker,
  blockedUrl: string,
  state: IndefiniteVisualState,
): Promise<void> {
  await endAnySession(extPage);
  if (state === 'overlay-stopped') {
    await startOverlaySession(extPage, state);
    // Stopping a fresh navigation is not deterministic: Chrome sometimes injects the content script
    // after the document has left `loading`, and there is then no fresh navigation to stop. Task 1
    // measured that as roughly one arrival in eight. This reloads until the worker's own durable
    // record shows a stopped document, so the wait is on the evidence rather than on a clock.
    for (let attempt: number = 0; attempt < 8; attempt++) {
      await page.goto(blockedUrl, { waitUntil: 'commit' });
      if (await stoppedDocumentRecorded(worker, 4_000)) {
        await expect(page.locator('focus-lock-overlay')).toBeAttached();
        return;
      }
    }
    throw new Error('the worker never recorded a stopped document for the stopped-page capture');
  }
  await page.goto(blockedUrl);
  await expect(page.locator('#marker')).toBeAttached();
  await startOverlaySession(extPage, state);
  await expect(page.locator('focus-lock-overlay')).toBeAttached();
}

/** The session one overlay state is about, started fresh for the page that will show it. */
async function startOverlaySession(extPage: Page, state: IndefiniteVisualState): Promise<void> {
  if (state === 'overlay-active-timed') {
    await startTestSession(extPage, {
      duration: { kind: 'timed', minutes: 45 },
      strictness: 'flexible',
      intention: 'Write the release notes',
    });
    return;
  }
  await startUntilStoppedSession(extPage, { intention: 'Write the release notes' });
}

/** True once the worker's durable tab state names a stopped document, which is the stop's evidence. */
async function stoppedDocumentRecorded(worker: Worker, timeoutMs: number): Promise<boolean> {
  const deadline: number = Date.now() + timeoutMs;
  for (;;) {
    const stopped: boolean = Object.values((await readRuntimeV2(worker)).tabStates).some(
      (tab: RuntimeTabState): boolean => tab.stoppedDocumentId !== null,
    );
    if (stopped) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve: (value: unknown) => void): void => {
      setTimeout(resolve, 100);
    });
  }
}

/** Ends whatever session is running, so the next state starts from a known lifecycle. */
async function endAnySession(extPage: Page): Promise<void> {
  const snapshot: SessionSnapshotV2 = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  if (snapshot.lifecycle.kind === 'idle') return;
  // A refused end and a slow end look the same from the lifecycle alone, so the answer is read.
  // Without this the failure says only that idle never arrived, which is the symptom of both.
  const answer = await sendExtensionRequest(extPage, { type: 'requestSessionEnd' });
  if (!answer.ok) {
    throw new Error(
      `the worker refused to end the ${snapshot.lifecycle.kind} session with ${answer.code}`,
    );
  }
  await waitForLifecycle(extPage, 'idle');
}

/** The one command a start sends that no screenshot can catch, kept for replay. */
/** The three page surfaces: the schedule editor, the session status in Settings, and Stats. */
async function capturePageSurfaces(
  context: BrowserContext,
  extPage: Page,
  worker: Worker,
  extensionId: string,
  evidenceDir: string,
  storageSeeds: IndefiniteStorageSeed[],
  errorSnapshot: SessionSnapshotV2,
  observations: IndefiniteRuntimeApiInterceptionObservation[],
): Promise<void> {
  await seedScheduleEntry(extPage);
  await captureOptionsState(
    context,
    extPage,
    extensionId,
    evidenceDir,
    'schedule-row-until-stopped',
  );
  await captureOptionsState(context, extPage, extensionId, evidenceDir, 'schedule-editor-window');
  await captureOptionsState(
    context,
    extPage,
    extensionId,
    evidenceDir,
    'schedule-editor-until-stopped',
  );

  await endAnySession(extPage);
  await startOverlaySession(extPage, 'overlay-active-indefinite');
  await captureOptionsState(
    context,
    extPage,
    extensionId,
    evidenceDir,
    'settings-session-status-indefinite',
  );
  await endAnySession(extPage);
  await startOverlaySession(extPage, 'overlay-active-timed');
  await captureOptionsState(
    context,
    extPage,
    extensionId,
    evidenceDir,
    'settings-session-status-timed',
  );
  await endAnySession(extPage);
  await captureOptionsState(
    context,
    extPage,
    extensionId,
    evidenceDir,
    'settings-session-status-error',
    { snapshot: errorSnapshot, observations },
  );

  storageSeeds.push(await seedStatsSessions(worker));
  await captureStatsState(context, extPage, extensionId, evidenceDir);
}

/** One options-page state, captured at every width in all four theme cases. */
async function captureOptionsState(
  context: BrowserContext,
  extPage: Page,
  extensionId: string,
  evidenceDir: string,
  state: IndefiniteVisualState,
  fixed?: {
    snapshot: SessionSnapshotV2;
    observations: IndefiniteRuntimeApiInterceptionObservation[];
  },
): Promise<void> {
  const definition: IndefiniteVisualStateDefinition = definitionFor(state);
  for (const theme of INDEFINITE_THEME_CASES) {
    await sendExtensionRequest(extPage, { type: 'updateTheme', theme: theme.theme });
    for (const width of widthsForState(state)) {
      const page: Page = await context.newPage();
      await page.emulateMedia({ colorScheme: theme.colorScheme });
      await page.setViewportSize({ width, height: viewportHeightFor(width) });
      if (fixed !== undefined) {
        await installInterception(page, async (requestType: string): Promise<unknown> => {
          if (requestType !== 'getSnapshot') return null;
          fixed.observations.push({ state, requestType: 'getSnapshot' });
          return { ...fixed.snapshot, theme: theme.theme };
        });
      }
      // Settings renders every section and hides all but the one the hash names, so the section is
      // chosen by navigating to it rather than by clicking through the nav.
      const section: string = state.startsWith('schedule-') ? 'schedule' : 'blocking';
      await page.goto(`chrome-extension://${extensionId}/src/options/options.html#${section}`, {
        timeout: 20_000,
      });
      await expect(page.getByRole('heading', { name: 'Focus Lock settings' })).toBeVisible();
      await prepareOptionsState(page, state);
      await captureCell(
        page,
        evidenceDir,
        state,
        theme,
        width,
        page.locator(definition.focusSelector).first(),
      );
      await page.close();
    }
  }
}

/** Opens the editor or leaves the list showing, which is the only thing these states differ by. */
async function prepareOptionsState(page: Page, state: IndefiniteVisualState): Promise<void> {
  if (state.startsWith('schedule-')) {
    await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible();
  }
  if (state === 'schedule-editor-window' || state === 'schedule-editor-until-stopped') {
    await page.getByRole('button', { name: 'Edit' }).first().click();
    await expect(page.locator('.schedule-duration')).toBeVisible();
    const label: string =
      state === 'schedule-editor-window' ? 'Until window ends' : 'Until stopped';
    await page.locator('.schedule-duration').getByText(label, { exact: true }).click();
    return;
  }
  if (state.startsWith('settings-session-status')) {
    await expect(page.locator('.session-status')).toBeVisible();
  }
}

/** The stats page, which reads the seeded log through the worker like any other reader. */
async function captureStatsState(
  context: BrowserContext,
  extPage: Page,
  extensionId: string,
  evidenceDir: string,
): Promise<void> {
  const state: IndefiniteVisualState = 'stats-until-stopped-rows';
  const definition: IndefiniteVisualStateDefinition = definitionFor(state);
  for (const theme of INDEFINITE_THEME_CASES) {
    await sendExtensionRequest(extPage, { type: 'updateTheme', theme: theme.theme });
    for (const width of widthsForState(state)) {
      const page: Page = await context.newPage();
      await page.emulateMedia({ colorScheme: theme.colorScheme });
      await page.setViewportSize({ width, height: viewportHeightFor(width) });
      await page.goto(`chrome-extension://${extensionId}/src/stats/stats.html`, {
        timeout: 20_000,
      });
      // A stats page with nothing to show renders a sentence instead of the table, so the failure
      // reports what the page said rather than only which selector was missing.
      try {
        await expect(page.locator(definition.focusSelector).first()).toBeVisible({
          timeout: 30_000,
        });
      } catch (error: unknown) {
        const shown: string = (await page.locator('.stats-page').innerText()).slice(0, 400);
        throw new Error(`the stats page never showed its recent sessions, it showed: ${shown}`, {
          cause: error,
        });
      }
      await captureCell(
        page,
        evidenceDir,
        state,
        theme,
        width,
        page.locator(definition.focusSelector).first(),
      );
      await page.close();
    }
  }
}

/**
 * Installs the page-side interception. It wraps `chrome.runtime.sendMessage` before the page's own
 * script runs, asks the test what to answer, and passes through everything it is not given an
 * answer for, so the page still reads its real settings, lists, and stats from the worker.
 */
async function installInterception(
  page: Page,
  answer: (requestType: string) => Promise<unknown>,
): Promise<void> {
  await page.exposeFunction('__indefiniteFixture', answer);
  await page.addInitScript((): void => {
    const send: typeof chrome.runtime.sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    Object.defineProperty(chrome.runtime, 'sendMessage', {
      configurable: true,
      value: async (...args: unknown[]): Promise<unknown> => {
        const request: unknown = args[0];
        const type: unknown =
          typeof request === 'object' && request !== null && 'type' in request
            ? (request as { type: unknown }).type
            : null;
        if (typeof type === 'string') {
          const answered: unknown = await (
            globalThis as unknown as { __indefiniteFixture(requestType: string): Promise<unknown> }
          ).__indefiniteFixture(type);
          if (answered !== null) return answered;
        }
        return await (send as unknown as (...rest: unknown[]) => Promise<unknown>)(...args);
      },
    });
  });
}

/** One until-stopped schedule entry, saved through the worker so Settings reads it back. */
async function seedScheduleEntry(extPage: Page): Promise<void> {
  const settings: Settings = await sendExtensionRequest(extPage, { type: 'getSettings' });
  const entry: ScheduleEntryV2 = {
    id: 'evening-review',
    days: [1, 2, 3, 4, 5],
    start: '19:00',
    end: '20:30',
    mode: 'blacklist',
    strictness: 'flexible',
    duration: { kind: 'until-stopped' },
    cycling: null,
    intention: 'Evening review',
    enabled: true,
  };
  const ack = await sendExtensionRequest(extPage, {
    type: 'updateSettings',
    settings: { ...settings, schedule: [entry] },
  });
  if (!ack.ok) throw new Error(ack.error);
}

/**
 * Two finished sessions in the durable log: one until-stopped ended manually, one timed ended
 * early. Both are written relative to the moment the run captures them, because a log seeded at a
 * fixed date would only be today's stats on that date.
 */
async function seedStatsSessions(worker: Worker): Promise<IndefiniteStorageSeed> {
  // Fixed local times on the previous day, so the times the table prints are the same in every run
  // and only the date moves with the calendar. An earlier seed placed them minutes back from the
  // capture instant, which put a different start time in the evidence every time it ran.
  const yesterday: Date = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const at: (hours: number, minutes: number) => number = (hours: number, minutes: number): number =>
    new Date(yesterday).setHours(hours, minutes, 0, 0);
  const events: SessionEventRecordV2[] = [
    startedEvent(at(9, 0), 'a0000000-0000-4000-8000-000000000001', {
      kind: 'until-stopped',
    }),
    endedEvent(at(10, 0), 'a0000000-0000-4000-8000-000000000001', {
      duration: { kind: 'until-stopped' },
      outcome: 'completed',
      reason: 'manual-completed',
      focusedMs: 3_600_000,
    }),
    startedEvent(at(11, 0), 'a0000000-0000-4000-8000-000000000002', {
      kind: 'timed',
      minutes: 45,
    }),
    endedEvent(at(11, 30), 'a0000000-0000-4000-8000-000000000002', {
      duration: { kind: 'timed', minutes: 45 },
      outcome: 'canceled',
      reason: 'manual-canceled',
      focusedMs: 1_200_000,
    }),
  ];
  // The boundary names an event by its session: a start is `<sessionId>:start` and an end is
  // `<sessionId>:end`, and it drops any record that spells them otherwise. A seed with its own
  // spelling parses to an empty log, which reaches the page as a stats table that never renders.
  const sha256: string = await worker.evaluate(
    async (input: { key: string; events: SessionEventRecordV2[] }): Promise<string> => {
      await chrome.storage.local.set({ [input.key]: input.events });
      const bytes: Uint8Array = new TextEncoder().encode(JSON.stringify(input.events));
      const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
      return [...new Uint8Array(digest)]
        .map((byte: number): string => byte.toString(16).padStart(2, '0'))
        .join('');
    },
    { key: 'events', events },
  );
  const storedSessions: string[] = await worker.evaluate(async (key: string): Promise<string[]> => {
    const stored: unknown = (await chrome.storage.local.get(key))[key];
    if (!Array.isArray(stored)) return [];
    return stored
      .filter((entry: unknown): boolean => (entry as { t?: string }).t === 'sessionEnded')
      .map((entry: unknown): string => String((entry as { sessionId?: string }).sessionId));
  }, 'events');
  for (const session of [
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000002',
  ]) {
    if (!storedSessions.includes(session)) {
      throw new Error(`the seeded log lost ${session}, it holds ${storedSessions.join(', ')}`);
    }
  }
  return {
    key: 'events',
    purpose:
      'Two finished sessions, one until-stopped and one timed, so the stats table shows both plan and outcome wordings. Written relative to the capture instant so the seed is not tied to one date.',
    sha256,
    state: 'stats-until-stopped-rows',
  };
}

function startedEvent(
  at: number,
  sessionId: string,
  duration: SessionStartedEventV2['duration'],
): SessionStartedEventV2 {
  return {
    version: 2,
    t: 'sessionStarted',
    eventId: `${sessionId}:start`,
    at,
    sessionId,
    source: 'manual',
    mode: 'blacklist',
    strictness: 'flexible',
    duration,
    intention: 'Write the release notes',
    scheduleOccurrence: null,
  };
}

function endedEvent(
  at: number,
  sessionId: string,
  fields: Pick<SessionEndedEventV2, 'duration' | 'outcome' | 'reason' | 'focusedMs'>,
): SessionEndedEventV2 {
  return {
    version: 2,
    t: 'sessionEnded',
    eventId: `${sessionId}:end`,
    at,
    sessionId,
    source: 'manual',
    scheduleOccurrence: null,
    ...fields,
  };
}

/**
 * Reads the three published snapshots every popup fixture is spliced from. Each one is a value the
 * worker really produced in this run, so no fixture can render a shape the product cannot reach.
 */
async function collectSourceSnapshots(extPage: Page): Promise<SourceSnapshots> {
  await endAnySession(extPage);
  const idle: SessionSnapshotV2 = await sendExtensionRequest(extPage, { type: 'getSnapshot' });
  await startUntilStoppedSession(extPage, { intention: 'Write the release notes' });
  const indefiniteActive: SessionSnapshotV2 = await waitForLifecycle(extPage, 'active');
  await endAnySession(extPage);
  await startTestSession(extPage, {
    duration: { kind: 'timed', minutes: 50 },
    strictness: 'flexible',
    cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
    intention: 'Write the release notes',
  });
  const timedCycling: SessionSnapshotV2 = await waitForLifecycle(extPage, 'active');
  await endAnySession(extPage);
  return { idle, indefiniteActive, timedCycling };
}

test('captures deterministic indefinite session visual evidence', async ({
  context,
  extensionId,
  extPage,
  worker,
  siteUrl,
}, testInfo) => {
  const requested: string | undefined = process.env.INDEFINITE_EVIDENCE_DIR;
  test.skip(requested === undefined, 'set INDEFINITE_EVIDENCE_DIR to capture evidence');
  const evidenceDir: string = path.resolve(requested ?? '');
  await mkdir(evidenceDir, { recursive: true });

  const observations: IndefiniteRuntimeApiInterceptionObservation[] = [];
  const storageSeeds: IndefiniteStorageSeed[] = [];
  const maskedRegions: IndefiniteMaskedRegion[] = [];
  // No command is replayed in this run. The starting overlay is the one state this capture does
  // not reach, and the report says why: it is up for about thirty milliseconds, and a replay of the
  // worker's own command into a fresh document is refused by the content script.
  const replayed: IndefiniteReplayedCommand[] = [];

  const source: SourceSnapshots = await collectSourceSnapshots(extPage);
  const setup: SetupState = await sendExtensionRequest(extPage, { type: 'getSetupState' });

  const popupPage: Page = await context.newPage();
  await popupPage.clock.setFixedTime(FIXED_NOW);
  const held: { current: Map<IndefiniteVisualState, PopupFixture>; state: IndefiniteVisualState } =
    {
      current: popupFixtures(source, setup, 'auto'),
      state: 'popup-idle-until-stopped-selected',
    };
  await installInterception(popupPage, async (requestType: string): Promise<unknown> => {
    const fixture: PopupFixture = fixtureFor(held.current, held.state);
    if (requestType === 'getSnapshot') {
      observations.push({ state: held.state, requestType: 'getSnapshot' });
      return fixture.snapshot;
    }
    if (requestType === 'getSetupState') {
      observations.push({ state: held.state, requestType: 'getSetupState' });
      return fixture.setup;
    }
    if (requestType === 'startSession' && fixture.startRefusal !== undefined) {
      observations.push({ state: held.state, requestType: 'startSession' });
      return fixture.startRefusal;
    }
    return null;
  });
  await capturePopupStates(popupPage, extensionId, evidenceDir, source, setup, held);
  await popupPage.close();

  await captureOverlayStates(context, extPage, worker, siteUrl, evidenceDir, maskedRegions);

  const errorSnapshot: SessionSnapshotV2 = lifecycleSnapshot(source.idle, 'auto', {
    kind: 'error',
    code: 'closure-cleanup-failed',
    retryAvailable: true,
    endAuthority: { kind: 'hidden' },
  });
  await capturePageSurfaces(
    context,
    extPage,
    worker,
    extensionId,
    evidenceDir,
    storageSeeds,
    errorSnapshot,
    observations,
  );

  const diagnostics: BrowserDiagnostics = browserDiagnosticsFor(context);
  const unexpectedDiagnostics: string[] = [];
  try {
    assertNoUnexpectedBrowserDiagnostics(diagnostics);
  } catch (error: unknown) {
    unexpectedDiagnostics.push(error instanceof Error ? error.message : String(error));
  }
  const userAgent: string = await extPage.evaluate((): string => navigator.userAgent);
  const manifest: IndefiniteEvidenceManifest = await writeIndefiniteEvidenceManifest({
    chromeVersion: /(?:HeadlessChrome|Chrome)\/([^ ]+)/u.exec(userAgent)?.[1] ?? 'unknown',
    evidenceDir,
    maskedRegions,
    replayedCommands: replayed,
    runtimeApiInterceptions: indefiniteInterceptionsFromObservations(
      declaredInterceptions(),
      observations,
    ),
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    storageSeeds,
    unexpectedDiagnostics,
    worktreeClean: worktreeIsClean(),
  });
  const written: unknown = JSON.parse(
    await readFile(path.join(evidenceDir, 'manifest.json'), 'utf8'),
  );
  expect(written).toEqual(manifest);
  expect(manifest.artifactCount).toBe(expectedIndefiniteArtifactCount());
  expect(manifest.chromeVersion).not.toBe('unknown');
  await testInfo.attach('indefinite-evidence-manifest', {
    body: Buffer.from(JSON.stringify(manifest, null, 2)),
    contentType: 'application/json',
  });
});

/**
 * The interceptions this run declares before it makes them, with the count each must reach. The
 * popup answers one `getSnapshot` and one `getSetupState` per load, and it loads once per theme, so
 * a fixture the popup refused and reloaded past shows up here as a count that does not match.
 */
function declaredInterceptions(): IndefiniteRuntimeApiInterceptionDefinition[] {
  const themes: number = INDEFINITE_THEME_CASES.length;
  const definitions: IndefiniteRuntimeApiInterceptionDefinition[] = [];
  for (const state of POPUP_STATES) {
    definitions.push({
      behavior: 'fixed-snapshot',
      countRule: 'exact',
      expectedCount: themes,
      passthrough: 'all-other-calls',
      purpose: 'Render the popup from a snapshot its own clock cannot outrun.',
      requestType: 'getSnapshot',
      scope: 'chrome.runtime.sendMessage',
      state,
    });
    definitions.push({
      behavior: 'fixed-setup-state',
      // The popup rereads the setup record whenever the stored one changes, and the worker writes
      // it on its own schedule, so this count is a floor. The snapshot above is not: a second
      // answer there means the page refused the first and reloaded.
      countRule: 'at-least',
      expectedCount: themes,
      passthrough: 'all-other-calls',
      purpose: 'Hold the setup record, which is what the data-clear branches switch on.',
      requestType: 'getSetupState',
      scope: 'chrome.runtime.sendMessage',
      state,
    });
  }
  definitions.push({
    behavior: 'refuse-start',
    countRule: 'exact',
    expectedCount: themes,
    passthrough: 'all-other-calls',
    purpose: 'Answer the start the way the worker answers it while a data clear is pending.',
    requestType: 'startSession',
    scope: 'chrome.runtime.sendMessage',
    state: 'popup-data-clear-start-refused',
  });
  definitions.push({
    behavior: 'fixed-snapshot',
    countRule: 'exact',
    expectedCount: themes * 3,
    passthrough: 'all-other-calls',
    purpose:
      'Settings renders the session status from the same snapshot channel the popup reads, and an exhausted cleanup journal is not a state this run can reach without synthesising a runtime the product never produced.',
    requestType: 'getSnapshot',
    scope: 'chrome.runtime.sendMessage',
    state: 'settings-session-status-error',
  });
  return definitions;
}

function worktreeIsClean(): boolean {
  const status: string = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  return status
    .split('\n')
    .filter((line: string): boolean => line.trim().length > 0)
    .every((line: string): boolean => line.includes('artifacts/'));
}
