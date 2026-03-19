import { type Mock, vi } from 'vitest';
import { DEFAULT_SETUP } from '../../../src/shared/constants';
import type { Request } from '../../../src/shared/messages';

type Responder = (req: Request) => unknown;

export interface ChromeFake {
  /** every request sent through the fake, in order */
  sent: Request[];
  /** set the response for a request type, either a value or a function of the request */
  respond(type: Request['type'], value: unknown | Responder): void;
  /** deliver a broadcast to every onMessage listener */
  emit(message: unknown): void;
  /** deliver a local storage change to every storage.onChanged listener */
  emitStorageChange(changes: Record<string, chrome.storage.StorageChange>, area?: string): void;
  /** storage.local.get used by the Data section */
  storageGet: Mock;
}

/**
 * Installs a minimal chrome global covering what the options page calls:
 * runtime.sendMessage, runtime.onMessage, storage.local.get, storage.onChanged.
 */
export function installChromeFake(): ChromeFake {
  const sent: Request[] = [];
  const responders: Map<string, unknown | Responder> = new Map();
  responders.set('getSetupState', structuredClone(DEFAULT_SETUP));
  const listeners: Set<(message: unknown) => void> = new Set();
  type StorageListener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => void;
  const storageListeners: Set<StorageListener> = new Set();
  const storageGet: Mock = vi.fn(
    async (): Promise<Record<string, unknown>> => ({
      deviceId: '123e4567-e89b-42d3-a456-426614174000',
    }),
  );

  const fake: unknown = {
    runtime: {
      sendMessage: async (req: Request): Promise<unknown> => {
        sent.push(req);
        const responder: unknown | Responder = responders.get(req.type);
        if (responder === undefined) {
          throw new Error(`chrome fake: no response registered for ${req.type}`);
        }
        return typeof responder === 'function' ? (responder as Responder)(req) : responder;
      },
      onMessage: {
        addListener: (fn: (message: unknown) => void): void => {
          listeners.add(fn);
        },
        removeListener: (fn: (message: unknown) => void): void => {
          listeners.delete(fn);
        },
      },
    },
    storage: {
      local: {
        get: storageGet,
      },
      onChanged: {
        addListener: (fn: StorageListener): void => {
          storageListeners.add(fn);
        },
        removeListener: (fn: StorageListener): void => {
          storageListeners.delete(fn);
        },
      },
    },
  };

  (globalThis as { chrome?: unknown }).chrome = fake;

  return {
    sent,
    respond: (type: Request['type'], value: unknown | Responder): void => {
      responders.set(type, value);
    },
    emit: (message: unknown): void => {
      for (const fn of listeners) fn(message);
    },
    emitStorageChange: (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string = 'local',
    ): void => {
      for (const fn of storageListeners) fn(changes, area);
    },
    storageGet,
  };
}
