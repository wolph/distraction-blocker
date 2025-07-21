import { DEFAULT_SETTINGS } from '../../../src/shared/constants';
import type { ThemeMode } from '../../../src/shared/types';
import {
  buildStatsVisualSeed,
  type StatsVisualSeed,
  type StatsVisualStateId,
} from '../stats-visual-seeds';

type Listener = (message: unknown) => void;

function requestedState(): StatsVisualStateId {
  const state: string = new URLSearchParams(location.search).get('state') ?? 'no-activity-local';
  if (state === 'one-active-hour-sync' || state === 'all-hours-boundaries-local') return state;
  return 'no-activity-local';
}

const seed: StatsVisualSeed = buildStatsVisualSeed(requestedState(), Date.now());
const storedTheme: string | null = sessionStorage.getItem('focus-lock-stats-task5-theme');
let theme: ThemeMode =
  storedTheme === 'dark' || storedTheme === 'light' || storedTheme === 'auto'
    ? storedTheme
    : 'auto';
const listeners: Set<Listener> = new Set<Listener>();

globalThis.chrome = {
  runtime: {
    getURL: (value: string): string => value,
    id: 'focus-lock-stats-task5-source-harness',
    onMessage: {
      addListener: (listener: Listener): void => {
        listeners.add(listener);
      },
      removeListener: (listener: Listener): void => {
        listeners.delete(listener);
      },
    },
    openOptionsPage: async (): Promise<void> => undefined,
    sendMessage: async (request: { theme?: ThemeMode; type?: string }): Promise<unknown> => {
      if (request.type === 'getSettings') return { ...DEFAULT_SETTINGS, theme };
      if (request.type === 'getSetupState') {
        return {
          blockingRegistration: 'ready',
          completed: true,
          dataClear: { phase: null, scope: null, status: 'idle' },
          legacyImported: false,
          storageError: null,
          storageMode: seed.storageMode,
          syncWriteStatus: 'idle',
          version: 1,
          websiteAccess: 'granted',
          websiteAccessNotice: null,
        };
      }
      if (request.type === 'getStats') return structuredClone(seed.bundle);
      if (request.type === 'exportEvents') return { json: JSON.stringify(seed.events) };
      if (request.type === 'updateTheme' && request.theme !== undefined) {
        theme = request.theme;
        sessionStorage.setItem('focus-lock-stats-task5-theme', theme);
        for (const listener of listeners) {
          listener({ type: 'stateChanged' });
        }
        return { ok: true };
      }
      return { ok: true };
    },
  },
  storage: {
    local: {
      get: async (): Promise<Record<string, string>> => ({
        deviceId: 'focus-lock-stats-task5-source-harness',
      }),
    },
  },
} as unknown as typeof chrome;
