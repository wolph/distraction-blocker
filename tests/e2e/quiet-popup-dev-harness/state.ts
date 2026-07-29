/** Source-rendering fixtures for visual checks. Packaged E2E tests exercise real commands. */
import {
  cancelPhrase,
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  emptySnapshotV2,
  rulesFromLists,
} from '../../../src/shared/constants';
import type { Request } from '../../../src/shared/messages';
import { isSessionSnapshotV2 } from '../../../src/shared/runtime-validation';
import type {
  EndAuthorityV2,
  GateState,
  SessionConfigV2,
  SessionSnapshotV2,
  SettingsV2,
  SetupState,
  ThemeMode,
} from '../../../src/shared/types';
import type { WorkTab, WorkTargetResult } from '../../../src/shared/work-target';

const parameters: URLSearchParams = new URLSearchParams(location.search);
const scenario: string = parameters.get('state') ?? 'idle';
const theme: ThemeMode = parameters.get('theme') === 'dark' ? 'dark' : 'light';
const now: number = Date.now();
const minute: number = 60_000;
const settings: SettingsV2 = { ...structuredClone(DEFAULT_SETTINGS), theme };
const setup: SetupState = {
  ...structuredClone(DEFAULT_SETUP),
  blockingRegistration: 'ready',
  completed: true,
  storageMode: 'local',
  websiteAccess: 'granted',
};
const workTab: WorkTab = {
  tabId: 7,
  title:
    scenario === 'long'
      ? 'Review the release notes and compatibility checks for the upcoming deployment across supported platforms'
      : 'Project notes',
  hostname: 'example.com',
};
const closedAuthority: EndAuthorityV2 = {
  kind: 'friction-gate',
  gate: null,
  copy: { actionLabel: scenario === 'indefinite' ? 'Unlock' : 'End session' },
  actions: { open: 'open-end-gate' },
};

function previewSnapshot(): SessionSnapshotV2 {
  const empty: SessionSnapshotV2 = { ...emptySnapshotV2(now), theme };
  if (scenario === 'idle') return empty;
  const indefinite: boolean = scenario === 'indefinite';
  const phase: 'focus' | 'paused' | 'break' =
    scenario === 'paused' ? 'paused' : scenario === 'break' ? 'break' : 'focus';
  const config: SessionConfigV2 = {
    mode: 'blacklist',
    strictness: 'friction',
    duration: indefinite ? { kind: 'until-stopped' } : { kind: 'timed', minutes: 50 },
    cycling: scenario === 'cycle' || phase === 'break' ? settings.defaultCycling : null,
    intention: scenario === 'long' ? workTab.title : 'Write the release notes',
    source: 'manual',
    scheduleOccurrence: null,
    rules: rulesFromLists(DEFAULT_LISTS),
  };
  const gate: GateState & { kind: 'cancel' } = {
    kind: 'cancel',
    host: null,
    openedAt: now,
    readyAt: now + 10_000,
    requiredPhrase: cancelPhrase(config.intention),
    forceEndAvailable: false,
  };
  const endAuthority: EndAuthorityV2 =
    scenario === 'gate'
      ? {
          kind: 'friction-gate',
          gate,
          copy: {
            title: 'End this session',
            back: 'Keep focusing',
            phraseLabel: 'Type this to confirm:',
            confirm: 'End the session',
            intentionReminder: config.intention,
          },
          actions: { abandon: 'abandon-gate', confirm: 'confirm-gate' },
        }
      : closedAuthority;
  const sessionEndsAt: number | null = indefinite ? null : now + 45 * minute;
  return {
    ...empty,
    lifecycle: { kind: 'active', endAuthority },
    phase,
    config,
    startedAt: now - 5 * minute,
    phaseStartedAt: now - 3 * minute,
    phaseEndsAt: indefinite
      ? null
      : phase !== 'focus'
        ? now + 2 * minute
        : scenario === 'cycle'
          ? now + 20 * minute
          : sessionEndsAt,
    sessionEndsAt,
    sessionFocusedMs: (phase === 'focus' ? 5 : 2) * minute,
    bankMs: 5 * minute,
    bankAccrualPerMs: phase === 'focus' ? 1 / 6 : 0,
    gate: scenario === 'gate' ? gate : null,
  };
}

const snapshot: SessionSnapshotV2 = previewSnapshot();
if (!isSessionSnapshotV2(snapshot)) throw new Error(`Invalid popup preview: ${scenario}`);
const target: WorkTargetResult =
  scenario === 'missing'
    ? { ok: true, sessionId: 'preview', state: 'unavailable', title: null }
    : {
        ok: true,
        sessionId: 'preview',
        state: 'ready',
        title: workTab.title,
        hostname: workTab.hostname,
      };

async function sendMessage(request: Request): Promise<unknown> {
  switch (request.type) {
    case 'getSetupState':
      return structuredClone(setup);
    case 'getSettings':
      return structuredClone(settings);
    case 'getLists':
      return structuredClone(DEFAULT_LISTS);
    case 'getSnapshot':
      return structuredClone(snapshot);
    case 'getWorkTabs':
      return { ok: true, tabs: [structuredClone(workTab)] };
    case 'getWorkTarget':
      return structuredClone(target);
    default:
      return { ok: false, error: 'Use the installed extension to run session commands.' };
  }
}

const event: { addListener: () => void; removeListener: () => void } = {
  addListener: (): void => {},
  removeListener: (): void => {},
};

globalThis.chrome = {
  runtime: {
    id: 'quiet-popup-preview',
    getURL: (path: string): string => `/${path}`,
    sendMessage,
    onMessage: event,
    openOptionsPage: async (): Promise<void> => {},
  },
  tabs: {
    query: async (): Promise<unknown[]> => [
      { id: workTab.tabId, windowId: 1, title: workTab.title, url: 'https://example.com/notes' },
    ],
  },
  windows: { getCurrent: async (): Promise<{ id: number }> => ({ id: 1 }) },
  storage: { onChanged: event },
} as unknown as typeof chrome;
