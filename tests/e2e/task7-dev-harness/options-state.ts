import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  emptySnapshot,
} from '../../../src/shared/constants';
import type { ListsConfig, SetupState, ThemeMode } from '../../../src/shared/types';

type Listener = (message: unknown) => void;

const params: URLSearchParams = new URLSearchParams(location.search);
const requestedTheme: string = params.get('theme') ?? 'auto';
let theme: ThemeMode =
  requestedTheme === 'light' || requestedTheme === 'dark' ? requestedTheme : 'auto';
const settings = { ...DEFAULT_SETTINGS, theme };
let lists: ListsConfig = {
  ...structuredClone(DEFAULT_LISTS),
  categories: {
    forums: true,
    gaming: true,
    mail: true,
    news: true,
    shopping: true,
    social: true,
    video: true,
  },
  exclusions: { social: ['facebook.com'] },
};
const setup: SetupState = {
  ...DEFAULT_SETUP,
  blockingRegistration: 'ready',
  completed: true,
  storageError: 'sync-publish-failed',
  storageMode: 'local',
  syncWriteStatus: 'error',
  websiteAccess: 'granted',
};
let snapshot = { ...emptySnapshot(Date.now()), theme };
const listeners: Set<Listener> = new Set<Listener>();

globalThis.chrome = {
  downloads: { download: async (): Promise<number> => 1 },
  permissions: {
    contains: async (): Promise<boolean> => true,
    request: async (): Promise<boolean> => true,
  },
  runtime: {
    getURL: (value: string): string => value,
    id: 'focus-lock-task7-source-harness',
    onMessage: {
      addListener: (listener: Listener): void => {
        listeners.add(listener);
      },
      removeListener: (listener: Listener): void => {
        listeners.delete(listener);
      },
    },
    sendMessage: async (request: Record<string, unknown>): Promise<unknown> => {
      if (request.type === 'getSettings') return structuredClone(settings);
      if (request.type === 'getLists') return structuredClone(lists);
      if (request.type === 'getSnapshot') return structuredClone(snapshot);
      if (request.type === 'getSetupState') return structuredClone(setup);
      if (request.type === 'exportEvents') return { json: '[]' };
      if (request.type === 'updateLists' && typeof request.lists === 'object') {
        lists = structuredClone(request.lists as ListsConfig);
        return { ok: true };
      }
      if (request.type === 'updateTheme' && typeof request.theme === 'string') {
        theme = request.theme as ThemeMode;
        settings.theme = theme;
        snapshot = { ...snapshot, theme };
        for (const listener of listeners) {
          listener({ snapshot: structuredClone(snapshot), type: 'stateChanged' });
        }
        return { ok: true };
      }
      if (request.type === 'clearFocusLockData') {
        return { ok: true, scope: request.scope, status: 'cleared' };
      }
      return { ok: true };
    },
  },
  tabs: { create: async (): Promise<unknown> => ({ id: 1 }) },
} as unknown as typeof chrome;
