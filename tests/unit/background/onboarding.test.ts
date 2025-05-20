import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOnboardingService } from '../../../src/background/onboarding';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, DEFAULT_SETUP } from '../../../src/shared/constants';
import { LOCAL_ONBOARDING_DRAFT } from '../../../src/shared/storage-keys';
import type { OnboardingDraft, SetupState } from '../../../src/shared/types';

const onboardingUrl: string = 'chrome-extension://test-id/src/onboarding/onboarding.html';
let localState: Record<string, unknown>;
let setup: SetupState;
let tabs: chrome.tabs.Tab[];
let queryResults: chrome.tabs.Tab[][] | null;

function draft(revision: number, social: boolean = false): OnboardingDraft {
  return {
    version: 1,
    revision,
    step: 1,
    settings: structuredClone(DEFAULT_SETTINGS),
    lists: {
      ...structuredClone(DEFAULT_LISTS),
      categories: { ...DEFAULT_LISTS.categories, social },
    },
    websiteAccessChoice: 'pending',
    syncEnabled: true,
  };
}

function installChromeFake(options?: { staleUpdateId?: number }): void {
  vi.stubGlobal('chrome', {
    runtime: {
      getURL: (path: string): string => `chrome-extension://test-id/${path}`,
    },
    storage: {
      local: {
        get: vi.fn(
          async (key: string): Promise<Record<string, unknown>> =>
            Object.hasOwn(localState, key) ? { [key]: structuredClone(localState[key]) } : {},
        ),
        set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
          Object.assign(localState, structuredClone(items));
        }),
        remove: vi.fn(async (key: string): Promise<void> => {
          delete localState[key];
        }),
      },
    },
    tabs: {
      query: vi.fn(async (): Promise<chrome.tabs.Tab[]> => {
        if (queryResults !== null && queryResults.length > 0) {
          return structuredClone(queryResults.shift() ?? []);
        }
        return structuredClone(
          tabs.filter((tab: chrome.tabs.Tab): boolean => tab.url === onboardingUrl),
        );
      }),
      update: vi.fn(async (tabId: number): Promise<chrome.tabs.Tab> => {
        if (tabId === options?.staleUpdateId) throw new Error(`No tab with id: ${tabId}`);
        const tab: chrome.tabs.Tab | undefined = tabs.find(
          (candidate: chrome.tabs.Tab): boolean => candidate.id === tabId,
        );
        if (tab === undefined) throw new Error(`No tab with id: ${tabId}`);
        return structuredClone(tab);
      }),
      create: vi.fn(async (properties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> => {
        const created: chrome.tabs.Tab = {
          id: 100 + tabs.length,
          windowId: 7,
          active: true,
          highlighted: true,
          pinned: false,
          incognito: false,
          selected: true,
          discarded: false,
          autoDiscardable: true,
          frozen: false,
          lastAccessed: Date.now(),
          url: properties.url,
          index: tabs.length,
          groupId: -1,
        };
        tabs.push(created);
        return structuredClone(created);
      }),
    },
    windows: {
      update: vi.fn().mockResolvedValue({}),
    },
  });
}

beforeEach((): void => {
  localState = {};
  setup = structuredClone(DEFAULT_SETUP);
  tabs = [];
  queryResults = null;
  installChromeFake();
});

describe('serialized onboarding draft storage', (): void => {
  it("rejects the second tab's stale full-draft save instead of losing the first update", async (): Promise<void> => {
    localState[LOCAL_ONBOARDING_DRAFT] = draft(1);
    const service = createOnboardingService({
      loadSetup: async (): Promise<SetupState> => structuredClone(setup),
    });
    const tabOne: OnboardingDraft = structuredClone(
      (await service.loadDraft()).draft as OnboardingDraft,
    );
    const tabTwo: OnboardingDraft = structuredClone(
      (await service.loadDraft()).draft as OnboardingDraft,
    );

    const first = await service.saveDraft({
      ...tabOne,
      lists: {
        ...tabOne.lists,
        categories: { ...tabOne.lists.categories, social: true },
      },
    });
    const stale = await service.saveDraft({ ...tabTwo, step: 2 });

    expect(first).toMatchObject({ ok: true, draft: { revision: 2 } });
    expect(stale).toMatchObject({
      ok: false,
      conflict: true,
      draft: { revision: 2, step: 1, lists: { categories: { social: true } } },
    });
    expect(localState[LOCAL_ONBOARDING_DRAFT]).toMatchObject({
      revision: 2,
      step: 1,
      lists: { categories: { social: true } },
    });
  });

  it('rejects a stale tab save after another tab completes setup', async (): Promise<void> => {
    localState[LOCAL_ONBOARDING_DRAFT] = draft(4);
    setup = { ...DEFAULT_SETUP, completed: true, storageMode: 'local' };
    const service = createOnboardingService({
      loadSetup: async (): Promise<SetupState> => structuredClone(setup),
    });

    await expect(service.saveDraft({ ...draft(4), step: 2 })).resolves.toMatchObject({
      ok: false,
      conflict: true,
    });
    expect(localState[LOCAL_ONBOARDING_DRAFT]).toMatchObject({ revision: 4, step: 1 });
  });
});

describe('serialized onboarding tab opening', (): void => {
  it('deduplicates concurrent open calls', async (): Promise<void> => {
    const service = createOnboardingService({
      loadSetup: async (): Promise<SetupState> => structuredClone(setup),
    });

    await Promise.all([service.open(), service.open()]);

    expect(chrome.tabs.create).toHaveBeenCalledOnce();
    expect(chrome.tabs.update).toHaveBeenCalledWith(100, { active: true });
  });

  it('focuses an existing onboarding tab and its window', async (): Promise<void> => {
    tabs = [{ id: 12, windowId: 9, url: onboardingUrl } as chrome.tabs.Tab];
    const service = createOnboardingService({
      loadSetup: async (): Promise<SetupState> => structuredClone(setup),
    });

    await service.open();

    expect(chrome.tabs.update).toHaveBeenCalledWith(12, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(9, { focused: true });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('recovers when a queried onboarding tab closes before focus', async (): Promise<void> => {
    queryResults = [[{ id: 31, windowId: 9, url: onboardingUrl } as chrome.tabs.Tab], []];
    installChromeFake({ staleUpdateId: 31 });
    const service = createOnboardingService({
      loadSetup: async (): Promise<SetupState> => structuredClone(setup),
    });

    await service.open();

    expect(chrome.tabs.query).toHaveBeenCalledTimes(2);
    expect(chrome.tabs.create).toHaveBeenCalledOnce();
  });
});
