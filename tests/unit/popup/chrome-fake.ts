/**
 * Minimal chrome global fake for popup component tests. Import this module
 * first in every popup test so globalThis.chrome exists before the code
 * under test loads.
 */
import { type Mock, vi } from 'vitest';

type MessageListener = (msg: unknown) => void;

export const sendMessageMock: Mock = vi.fn();
export const openOptionsPageMock: Mock = vi.fn();
export const tabsCreateMock: Mock = vi.fn();
export const tabsQueryMock: Mock = vi.fn(async (): Promise<unknown[]> => []);
export const permissionsRequestMock: Mock = vi.fn(async (): Promise<boolean> => false);

export const messageListeners: MessageListener[] = [];

/** Push a worker broadcast through every captured onMessage listener. */
export function emitMessage(msg: unknown): void {
  for (const listener of [...messageListeners]) {
    listener(msg);
  }
}

export function resetChromeFake(): void {
  sendMessageMock.mockReset();
  openOptionsPageMock.mockReset();
  tabsCreateMock.mockReset();
  tabsQueryMock.mockReset();
  tabsQueryMock.mockResolvedValue([]);
  permissionsRequestMock.mockReset();
  permissionsRequestMock.mockResolvedValue(false);
  messageListeners.length = 0;
}

const chromeFake = {
  runtime: {
    sendMessage: sendMessageMock,
    onMessage: {
      addListener: (listener: MessageListener): void => {
        messageListeners.push(listener);
      },
      removeListener: (listener: MessageListener): void => {
        const index: number = messageListeners.indexOf(listener);
        if (index >= 0) messageListeners.splice(index, 1);
      },
    },
    openOptionsPage: openOptionsPageMock,
    getURL: (path: string): string => `chrome-extension://fake-id/${path}`,
  },
  tabs: {
    create: tabsCreateMock,
    query: tabsQueryMock,
  },
  permissions: {
    request: permissionsRequestMock,
  },
};

// Boundary cast: the fake implements only the slice of chrome the popup uses.
(globalThis as { chrome?: unknown }).chrome = chromeFake;
