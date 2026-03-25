/**
 * The state, theme, and viewport matrix the indefinite-session evidence run captures, and the
 * manifest it writes beside the images.
 *
 * This module declares its own interception and seed interfaces rather than borrowing the
 * onboarding ones, which close `requestType` and `state` over that slice's two cases.
 *
 * Every capture states how it was made deterministic, because half of these surfaces tick. A popup
 * that reads a live snapshot and its own clock renders a different number every run, so the states
 * that show a clock are given a fixed snapshot and a frozen page clock, and the ones whose values
 * come from the worker's clock and cannot be fixed have those regions masked instead. The
 * declaration is part of the evidence: a reviewer looking at a still clock should be able to see
 * why it is still.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ThemeMode } from '../../src/shared/types';

/**
 * Every surface state this slice captures.
 *
 * The starting overlay is not among them, and the reason is measured rather than assumed: it is on
 * screen for about thirty milliseconds during a start, which no screenshot can catch, and replaying
 * the command the worker itself sent into a fresh document is refused by the content script. It
 * needs a seam in the product, not a trick in the test, so it is reported rather than faked.
 */
export type IndefiniteVisualState =
  | 'popup-idle-until-stopped-selected'
  | 'popup-forced-hover'
  | 'popup-forced-focus'
  | 'popup-forced-click'
  | 'popup-starting-hidden'
  | 'popup-starting-immediate'
  | 'popup-starting-friction-closed'
  | 'popup-starting-friction-open'
  | 'popup-active-indefinite-focus'
  | 'popup-active-indefinite-pause'
  | 'popup-active-50-dual-clocks'
  | 'popup-cleanup-closure'
  | 'popup-cleanup-transition'
  | 'popup-error-transition'
  | 'popup-error-closure'
  | 'popup-long-copy'
  | 'popup-data-clear-pending'
  | 'popup-data-clear-error'
  | 'popup-data-clear-start-refused'
  | 'overlay-active-indefinite'
  | 'overlay-active-timed'
  | 'overlay-stopped'
  | 'schedule-editor-window'
  | 'schedule-editor-until-stopped'
  | 'schedule-row-until-stopped'
  | 'settings-session-status-indefinite'
  | 'settings-session-status-timed'
  | 'settings-session-status-error'
  | 'stats-until-stopped-rows';

/** The surface a state is captured on, which decides the widths it is captured at. */
export type IndefiniteVisualSurface = 'popup' | 'overlay' | 'page';

/** Both halves of every capture: the whole surface, and the component the state is about. */
export type IndefiniteEvidenceScope = 'full' | 'focused';

/**
 * How one capture was made to render the same pixels twice.
 *
 * `static` states show no clock at all. `fixed-snapshot` states are given a frozen page clock and a
 * snapshot the page cannot outrun. `masked-clock` states keep a live value the worker's own clock
 * produces, which no page-side freeze can reach, so the region carrying it is masked.
 */
export type IndefiniteDeterminism = 'static' | 'fixed-snapshot' | 'masked-clock';

export interface IndefiniteVisualStateDefinition {
  determinism: IndefiniteDeterminism;
  /** The component the focused capture crops to. */
  focusSelector: string;
  id: IndefiniteVisualState;
  surface: IndefiniteVisualSurface;
}

export interface IndefiniteThemeCase {
  colorScheme: 'light' | 'dark';
  id: string;
  theme: ThemeMode;
}

export interface IndefiniteViewport {
  height: number;
  surfaces: readonly IndefiniteVisualSurface[];
  width: number;
}

/** One captured image, as it is recorded in the manifest. */
export interface IndefiniteEvidenceRecord {
  bytes: number;
  path: string;
  scope: IndefiniteEvidenceScope;
  sha256: string;
  state: IndefiniteVisualState;
  themeId: string;
  width: number;
}

/** One interception of the popup's own runtime channel, with the count it is expected to reach. */
export interface IndefiniteRuntimeApiInterception {
  behavior: 'fixed-snapshot' | 'fixed-setup-state' | 'refuse-start';
  /**
   * How `observedCount` is held against `expectedCount`. A snapshot is answered exactly once per
   * load, and a second answer means the page refused the first and reloaded, which is a signal
   * worth failing on. The setup record has no such rule: the popup rereads it whenever the stored
   * record changes, which the worker may do at any time, so its count is a floor rather than a
   * number.
   */
  countRule: 'exact' | 'at-least';
  expectedCount: number;
  observedCount: number;
  passthrough: 'all-other-calls';
  purpose: string;
  requestType: 'getSnapshot' | 'getSetupState' | 'startSession';
  scope: 'chrome.runtime.sendMessage';
  state: IndefiniteVisualState;
}

export type IndefiniteRuntimeApiInterceptionDefinition = Omit<
  IndefiniteRuntimeApiInterception,
  'observedCount'
>;

export interface IndefiniteRuntimeApiInterceptionObservation {
  requestType: IndefiniteRuntimeApiInterception['requestType'];
  state: IndefiniteVisualState;
}

/** One region whose live value was pinned before the capture, with the selectors it covered. */
export interface IndefiniteMaskedRegion {
  selectors: string[];
  state: IndefiniteVisualState;
}

/**
 * One command the worker really sent, replayed into the page that shows it. The starting overlay is
 * up for about thirty milliseconds, measured, so it is captured by replay rather than by chase.
 */
export interface IndefiniteReplayedCommand {
  purpose: string;
  rewrittenFields: string[];
  source: string;
  state: IndefiniteVisualState;
}

/** One value written into extension storage before a capture, recorded by content hash. */
export interface IndefiniteStorageSeed {
  key: string;
  purpose: string;
  sha256: string;
  state: IndefiniteVisualState;
}

export interface IndefiniteEvidenceManifest {
  artifactCount: number;
  artifacts: IndefiniteEvidenceRecord[];
  chromeVersion: string;
  determinism: Array<{ determinism: IndefiniteDeterminism; state: IndefiniteVisualState }>;
  maskedRegions: IndefiniteMaskedRegion[];
  replayedCommands: IndefiniteReplayedCommand[];
  runtimeApiInterceptions: IndefiniteRuntimeApiInterception[];
  sourceCommit: string;
  stateCount: number;
  states: IndefiniteVisualState[];
  storageSeeds: IndefiniteStorageSeed[];
  themes: string[];
  /** Browser diagnostics the run did not expect. A complete run leaves this empty. */
  unexpectedDiagnostics: string[];
  viewportWidths: number[];
  worktreeClean: boolean;
}

/**
 * The popup is captured at its own width. Chrome gives the toolbar popup 340 CSS pixels, so a
 * capture at any other width is evidence about a page nobody sees.
 */
export const POPUP_WIDTH: number = 340;

export const INDEFINITE_THEME_CASES: readonly IndefiniteThemeCase[] = [
  { id: 'auto-light', theme: 'auto', colorScheme: 'light' },
  { id: 'auto-dark', theme: 'auto', colorScheme: 'dark' },
  { id: 'light-dark-media', theme: 'light', colorScheme: 'dark' },
  { id: 'dark-light-media', theme: 'dark', colorScheme: 'light' },
];

export const INDEFINITE_VIEWPORTS: readonly IndefiniteViewport[] = [
  { width: POPUP_WIDTH, height: 600, surfaces: ['popup'] },
  { width: 375, height: 844, surfaces: ['overlay', 'page'] },
  { width: 768, height: 900, surfaces: ['overlay', 'page'] },
  { width: 1280, height: 900, surfaces: ['overlay', 'page'] },
];

export const INDEFINITE_VISUAL_STATE_DEFINITIONS: readonly IndefiniteVisualStateDefinition[] = [
  {
    id: 'popup-idle-until-stopped-selected',
    surface: 'popup',
    determinism: 'fixed-snapshot',
    focusSelector: '.session-type-control',
  },
  {
    id: 'popup-forced-hover',
    surface: 'popup',
    determinism: 'fixed-snapshot',
    focusSelector: '.forced-control',
  },
  {
    id: 'popup-forced-focus',
    surface: 'popup',
    determinism: 'fixed-snapshot',
    focusSelector: '.forced-control',
  },
  {
    id: 'popup-forced-click',
    surface: 'popup',
    determinism: 'fixed-snapshot',
    focusSelector: '.forced-control',
  },
  {
    id: 'popup-starting-hidden',
    surface: 'popup',
    determinism: 'fixed-snapshot',
    focusSelector: '.lifecycle-view',
  },
  {
    id: 'popup-starting-immediate',
    surface: 'popup',
    determinism: 'fixed-snapshot',
    focusSelector: '.lifecycle-view',
  },
  {
    id: 'popup-starting-friction-closed',
    surface: 'popup',
    determinism: 'fixed-snapshot',
    focusSelector: '.lifecycle-view',
  },
  {
    id: 'popup-starting-friction-open',
    surface: 'popup',
    determinism: 'fixed-snapshot',
    focusSelector: '.lifecycle-view',
  },
  {
    id: 'popup-active-indefinite-focus',
    surface: 'popup',
    determinism: 'fixed-snapshot',
    focusSelector: '.clock-stack',
  },
  {
    id: 'popup-active-indefinite-pause',
    surface: 'popup',
    determinism: 'fixed-snapshot',
    focusSelector: '.clock-stack',
  },
  {
    id: 'popup-active-50-dual-clocks',
    surface: 'popup',
    determinism: 'fixed-snapshot',
    focusSelector: '.clock-stack',
  },
  {
    id: 'popup-cleanup-closure',
    surface: 'popup',
    determinism: 'fixed-snapshot',
    focusSelector: '.lifecycle-view',
  },
  {
    id: 'popup-cleanup-transition',
    surface: 'popup',
    determinism: 'fixed-snapshot',
    focusSelector: '.lifecycle-view',
  },
  {
    id: 'popup-error-transition',
    surface: 'popup',
    determinism: 'fixed-snapshot',
    focusSelector: '.lifecycle-view',
  },
  {
    id: 'popup-error-closure',
    surface: 'popup',
    determinism: 'fixed-snapshot',
    focusSelector: '.lifecycle-view',
  },
  {
    id: 'popup-long-copy',
    surface: 'popup',
    determinism: 'fixed-snapshot',
    focusSelector: '.clock-stack',
  },
  {
    id: 'popup-data-clear-pending',
    surface: 'popup',
    determinism: 'fixed-snapshot',
    focusSelector: '.lifecycle-view',
  },
  {
    id: 'popup-data-clear-error',
    surface: 'popup',
    determinism: 'fixed-snapshot',
    focusSelector: '.lifecycle-view',
  },
  {
    id: 'popup-data-clear-start-refused',
    surface: 'popup',
    determinism: 'fixed-snapshot',
    // The refusal and the button it answers, because the sentence alone crops to a line of text
    // that says nothing about where the user met it.
    focusSelector: '.start-form__actions',
  },
  {
    id: 'overlay-active-indefinite',
    surface: 'overlay',
    determinism: 'masked-clock',
    focusSelector: '.panel',
  },
  {
    id: 'overlay-active-timed',
    surface: 'overlay',
    determinism: 'masked-clock',
    focusSelector: '.panel',
  },
  {
    id: 'overlay-stopped',
    surface: 'overlay',
    determinism: 'static',
    focusSelector: '.panel',
  },
  {
    id: 'schedule-editor-window',
    surface: 'page',
    determinism: 'static',
    focusSelector: '.schedule-duration',
  },
  {
    id: 'schedule-editor-until-stopped',
    surface: 'page',
    determinism: 'static',
    focusSelector: '.schedule-duration',
  },
  {
    id: 'schedule-row-until-stopped',
    surface: 'page',
    determinism: 'static',
    focusSelector: '.schedule',
  },
  {
    id: 'settings-session-status-indefinite',
    surface: 'page',
    determinism: 'static',
    focusSelector: '.session-status',
  },
  {
    id: 'settings-session-status-timed',
    surface: 'page',
    determinism: 'static',
    focusSelector: '.session-status',
  },
  {
    id: 'settings-session-status-error',
    surface: 'page',
    determinism: 'fixed-snapshot',
    focusSelector: '.session-status',
  },
  {
    id: 'stats-until-stopped-rows',
    surface: 'page',
    determinism: 'static',
    // Stats renders its recent sessions two ways: a table above 768 pixels and a card list at or
    // below it, with the other one display: none. The card that holds whichever is showing is the
    // only crop that exists at all three widths, and it is also the more useful one, because the
    // evidence is about the plan and outcome wording rather than about the table element.
    focusSelector: '.card:has-text("Recent sessions on this machine")',
  },
];

export const INDEFINITE_VISUAL_STATES: readonly IndefiniteVisualState[] =
  INDEFINITE_VISUAL_STATE_DEFINITIONS.map(
    (definition: IndefiniteVisualStateDefinition): IndefiniteVisualState => definition.id,
  );

const SCOPES: readonly IndefiniteEvidenceScope[] = ['full', 'focused'];

/** The widths one state must be captured at, which is decided by the surface it lives on. */
export function widthsForState(state: IndefiniteVisualState): number[] {
  const definition: IndefiniteVisualStateDefinition = definitionFor(state);
  return INDEFINITE_VIEWPORTS.filter((viewport: IndefiniteViewport): boolean =>
    viewport.surfaces.includes(definition.surface),
  ).map((viewport: IndefiniteViewport): number => viewport.width);
}

export function definitionFor(state: IndefiniteVisualState): IndefiniteVisualStateDefinition {
  const definition: IndefiniteVisualStateDefinition | undefined =
    INDEFINITE_VISUAL_STATE_DEFINITIONS.find(
      (candidate: IndefiniteVisualStateDefinition): boolean => candidate.id === state,
    );
  if (definition === undefined) throw new Error(`${state} is not a declared visual state`);
  return definition;
}

/** The file name one cell of the matrix owns. The name is the coordinates, in one order. */
export function evidenceFileName(
  state: IndefiniteVisualState,
  themeId: string,
  width: number,
  scope: IndefiniteEvidenceScope,
): string {
  return `${state}-${themeId}-${String(width)}-${scope}.png`;
}

/**
 * Throws unless every cell of the matrix is present exactly once: every state, in all four theme
 * cases, at every width its surface is captured at, in both scopes. A missing cell is a state
 * nobody looked at, which is the failure this evidence exists to prevent.
 */
export function assertIndefiniteEvidenceCoverage(
  records: readonly IndefiniteEvidenceRecord[],
): void {
  const seen: Map<string, number> = new Map<string, number>();
  for (const record of records) {
    const key: string = evidenceFileName(record.state, record.themeId, record.width, record.scope);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const missing: string[] = [];
  for (const state of INDEFINITE_VISUAL_STATES) {
    for (const theme of INDEFINITE_THEME_CASES) {
      for (const width of widthsForState(state)) {
        for (const scope of SCOPES) {
          const key: string = evidenceFileName(state, theme.id, width, scope);
          const count: number = seen.get(key) ?? 0;
          if (count === 1) {
            seen.delete(key);
            continue;
          }
          missing.push(count === 0 ? `${key} is missing` : `${key} was captured ${count} times`);
        }
      }
    }
  }
  const unexpected: string[] = [...seen.keys()].map(
    (key: string): string => `${key} is unexpected`,
  );
  const problems: string[] = [...missing, ...unexpected];
  if (problems.length > 0) {
    throw new Error(`indefinite evidence coverage is incomplete: ${problems.join(', ')}`);
  }
}

/** The number of images a complete run writes, which the spec asserts against what it wrote. */
export function expectedIndefiniteArtifactCount(): number {
  return INDEFINITE_VISUAL_STATES.reduce(
    (total: number, state: IndefiniteVisualState): number =>
      total + widthsForState(state).length * INDEFINITE_THEME_CASES.length * SCOPES.length,
    0,
  );
}

export function indefiniteInterceptionsFromObservations(
  definitions: readonly IndefiniteRuntimeApiInterceptionDefinition[],
  observations: readonly IndefiniteRuntimeApiInterceptionObservation[],
): IndefiniteRuntimeApiInterception[] {
  return definitions.map(
    (definition: IndefiniteRuntimeApiInterceptionDefinition): IndefiniteRuntimeApiInterception => ({
      ...definition,
      observedCount: observations.filter(
        (observation: IndefiniteRuntimeApiInterceptionObservation): boolean =>
          observation.state === definition.state &&
          observation.requestType === definition.requestType,
      ).length,
    }),
  );
}

const PNG_SIGNATURE: Buffer = Buffer.from('89504e470d0a1a0a', 'hex');

/** Holds one interception to its declared count, by the rule that interception declared. */
export function assertInterceptionCount(interception: IndefiniteRuntimeApiInterception): void {
  const met: boolean =
    interception.countRule === 'exact'
      ? interception.observedCount === interception.expectedCount
      : interception.observedCount >= interception.expectedCount;
  if (met) return;
  throw new Error(
    `${interception.state} answered ${String(interception.observedCount)} ${interception.requestType} calls, not ${interception.countRule === 'exact' ? '' : 'at least '}${String(interception.expectedCount)}`,
  );
}

export interface WriteIndefiniteEvidenceManifestOptions {
  chromeVersion: string;
  evidenceDir: string;
  maskedRegions: IndefiniteMaskedRegion[];
  replayedCommands: IndefiniteReplayedCommand[];
  runtimeApiInterceptions: IndefiniteRuntimeApiInterception[];
  sourceCommit: string;
  storageSeeds: IndefiniteStorageSeed[];
  unexpectedDiagnostics: string[];
  worktreeClean: boolean;
}

/**
 * Reads the images the run wrote, proves each one is a PNG, hashes it, and writes the manifest
 * that names them. Coverage is asserted from the file names on disk rather than from what the spec
 * believes it captured, so a capture that silently wrote nothing fails here.
 */
export async function writeIndefiniteEvidenceManifest(
  options: WriteIndefiniteEvidenceManifestOptions,
): Promise<IndefiniteEvidenceManifest> {
  const names: string[] = (await readdir(options.evidenceDir))
    .filter((name: string): boolean => name.endsWith('.png'))
    .sort((left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0));
  const artifacts: IndefiniteEvidenceRecord[] = await Promise.all(
    names.map(async (name: string): Promise<IndefiniteEvidenceRecord> => {
      const contents: Buffer = await readFile(path.join(options.evidenceDir, name));
      if (!contents.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
        throw new Error(`${name} does not contain PNG image data`);
      }
      return {
        ...parseEvidenceFileName(name),
        path: name,
        bytes: contents.byteLength,
        sha256: createHash('sha256').update(contents).digest('hex'),
      };
    }),
  );
  assertIndefiniteEvidenceCoverage(artifacts);
  for (const interception of options.runtimeApiInterceptions) {
    assertInterceptionCount(interception);
  }
  const manifest: IndefiniteEvidenceManifest = {
    artifactCount: artifacts.length,
    artifacts,
    chromeVersion: options.chromeVersion,
    determinism: INDEFINITE_VISUAL_STATE_DEFINITIONS.map(
      (
        definition: IndefiniteVisualStateDefinition,
      ): { determinism: IndefiniteDeterminism; state: IndefiniteVisualState } => ({
        state: definition.id,
        determinism: definition.determinism,
      }),
    ),
    maskedRegions: options.maskedRegions,
    replayedCommands: options.replayedCommands,
    runtimeApiInterceptions: options.runtimeApiInterceptions,
    sourceCommit: options.sourceCommit,
    stateCount: INDEFINITE_VISUAL_STATES.length,
    states: [...INDEFINITE_VISUAL_STATES],
    storageSeeds: options.storageSeeds,
    themes: INDEFINITE_THEME_CASES.map((theme: IndefiniteThemeCase): string => theme.id),
    unexpectedDiagnostics: options.unexpectedDiagnostics,
    viewportWidths: INDEFINITE_VIEWPORTS.map(
      (viewport: IndefiniteViewport): number => viewport.width,
    ),
    worktreeClean: options.worktreeClean,
  };
  await writeFile(
    path.join(options.evidenceDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

/** The coordinates a file name carries, read back from the name the capture gave it. */
export function parseEvidenceFileName(name: string): {
  scope: IndefiniteEvidenceScope;
  state: IndefiniteVisualState;
  themeId: string;
  width: number;
} {
  for (const state of INDEFINITE_VISUAL_STATES) {
    for (const theme of INDEFINITE_THEME_CASES) {
      for (const width of widthsForState(state)) {
        for (const scope of SCOPES) {
          if (evidenceFileName(state, theme.id, width, scope) === name) {
            return { state, themeId: theme.id, width, scope };
          }
        }
      }
    }
  }
  throw new Error(`${name} does not name a cell of the indefinite evidence matrix`);
}
