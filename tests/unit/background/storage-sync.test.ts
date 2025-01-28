import { describe, expect, it, vi } from 'vitest';
import {
  handleSyncChanges,
  missingSyncDefaults,
  type SyncChangeEngine,
} from '../../../src/background/storage-sync';
import { SyncEchoes, SyncWriter } from '../../../src/background/sync-writer';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';
import {
  SYNC_BANK,
  SYNC_LISTS,
  SYNC_SETTINGS,
  SYNC_STREAK,
} from '../../../src/shared/storage-keys';
import type { BankState, ListsConfig, Settings, StreakState } from '../../../src/shared/types';

function makeEngine(overrides: Partial<SyncChangeEngine> = {}): SyncChangeEngine {
  const engine: SyncChangeEngine = {
    applySyncedSettings: vi.fn().mockResolvedValue({ ok: true }),
    applySyncedLists: vi.fn().mockResolvedValue({ ok: true }),
    applySyncedBank: vi.fn().mockResolvedValue({ ok: true }),
    applySyncedStreak: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn((): Settings => DEFAULT_SETTINGS),
    getLists: vi.fn((): ListsConfig => DEFAULT_LISTS),
    ...overrides,
  };
  return engine;
}

describe('handleSyncChanges', () => {
  it('initializes only missing base sync items', () => {
    const bank: BankState = { balanceMs: 0 };
    const streak: StreakState = {
      current: 0,
      freezeTokens: 0,
      lastCountedDate: null,
      lastFreezeGrantDate: null,
      activeDays: [],
      activeMonth: '2026-08',
    };

    expect(
      missingSyncDefaults(
        { [SYNC_SETTINGS]: DEFAULT_SETTINGS, [SYNC_BANK]: bank },
        { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS, bank, streak },
      ),
    ).toEqual({ [SYNC_LISTS]: DEFAULT_LISTS, [SYNC_STREAK]: streak });
  });

  it('consumes settings echoes before normalizing their stored shape', async () => {
    const echoedValue: unknown = { gate: { delayMs: DEFAULT_SETTINGS.gate.delayMs } };
    const applySyncedSettings = vi.fn().mockResolvedValue({ ok: true });
    const engine: SyncChangeEngine = makeEngine({ applySyncedSettings });
    const echoes: SyncEchoes = new SyncEchoes();
    echoes.remember(SYNC_SETTINGS, echoedValue);

    await handleSyncChanges(
      engine,
      { [SYNC_SETTINGS]: { newValue: echoedValue } },
      echoes,
      vi.fn().mockResolvedValue(undefined),
    );

    expect(applySyncedSettings).not.toHaveBeenCalled();
  });

  it('corrects rejected settings and consumes the corrective echo', async () => {
    const weaker: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 1_000 },
    };
    const applySyncedSettings = vi.fn().mockResolvedValue({ ok: false, error: 'hard session' });
    const engine: SyncChangeEngine = makeEngine({ applySyncedSettings });
    const echoes: SyncEchoes = new SyncEchoes();
    const set = vi
      .fn()
      .mockRejectedValueOnce(new Error('sync unavailable'))
      .mockResolvedValueOnce(undefined);
    const writer: SyncWriter = new SyncWriter(
      10_000,
      async (items: Record<string, unknown>): Promise<void> => {
        for (const [key, value] of Object.entries(items)) echoes.remember(key, value);
        await set(items);
      },
    );
    const queueSync = (key: string, value: unknown): void => writer.queue(key, value);

    await handleSyncChanges(engine, { [SYNC_SETTINGS]: { newValue: weaker } }, echoes, queueSync);
    await expect(writer.flushNow()).rejects.toThrow('sync unavailable');
    await writer.flushNow();
    await handleSyncChanges(
      engine,
      { [SYNC_SETTINGS]: { newValue: DEFAULT_SETTINGS } },
      echoes,
      queueSync,
    );

    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenNthCalledWith(1, { [SYNC_SETTINGS]: DEFAULT_SETTINGS });
    expect(set).toHaveBeenNthCalledWith(2, { [SYNC_SETTINGS]: DEFAULT_SETTINGS });
    expect(applySyncedSettings).toHaveBeenCalledTimes(1);
  });

  it('corrects rejected lists and consumes the corrective echo', async () => {
    const current: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'blocked.example' }],
    };
    const weaker: ListsConfig = { ...current, custom: [] };
    const applySyncedLists = vi.fn().mockResolvedValue({ ok: false, error: 'hard session' });
    const engine: SyncChangeEngine = makeEngine({
      applySyncedLists,
      getLists: vi.fn((): ListsConfig => current),
    });
    const echoes: SyncEchoes = new SyncEchoes();
    const set = vi.fn().mockResolvedValue(undefined);
    const writer: SyncWriter = new SyncWriter(
      10_000,
      async (items: Record<string, unknown>): Promise<void> => {
        for (const [key, value] of Object.entries(items)) echoes.remember(key, value);
        await set(items);
      },
    );
    const queueSync = (key: string, value: unknown): void => writer.queue(key, value);

    await handleSyncChanges(engine, { [SYNC_LISTS]: { newValue: weaker } }, echoes, queueSync);
    await writer.flushNow();
    await handleSyncChanges(engine, { [SYNC_LISTS]: { newValue: current } }, echoes, queueSync);

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ [SYNC_LISTS]: current });
    expect(applySyncedLists).toHaveBeenCalledTimes(1);
  });

  it('forwards pending-at-event state with a live lists change', async () => {
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'live.example' }],
    };
    const applySyncedLists = vi.fn().mockResolvedValue({ ok: true });
    const engine: SyncChangeEngine = makeEngine({ applySyncedLists });

    await handleSyncChanges(
      engine,
      { [SYNC_LISTS]: { newValue: lists } },
      new SyncEchoes(),
      vi.fn(),
      true,
    );

    expect(applySyncedLists).toHaveBeenCalledWith(lists, true);
  });

  it('applies a remote streak and ignores its local echo', async () => {
    const streak: StreakState = {
      current: 4,
      freezeTokens: 1,
      lastCountedDate: '2026-08-28',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [25, 26, 27, 28],
      activeMonth: '2026-08',
    };
    const applySyncedStreak = vi.fn().mockResolvedValue(undefined);
    const engine: SyncChangeEngine = makeEngine({ applySyncedStreak });
    const echoes: SyncEchoes = new SyncEchoes();
    const write = vi.fn().mockResolvedValue(undefined);

    await handleSyncChanges(engine, { [SYNC_STREAK]: { newValue: streak } }, echoes, write);
    echoes.remember(SYNC_STREAK, streak);
    await handleSyncChanges(engine, { [SYNC_STREAK]: { newValue: streak } }, echoes, write);

    expect(applySyncedStreak).toHaveBeenCalledTimes(1);
    expect(applySyncedStreak).toHaveBeenCalledWith(streak);
    expect(write).not.toHaveBeenCalled();
  });

  it('applies valid bank changes without a corrective write', async () => {
    const bank: BankState = { balanceMs: 42_000 };
    const applySyncedBank = vi.fn().mockResolvedValue({ ok: true });
    const engine: SyncChangeEngine = makeEngine({ applySyncedBank });
    const write = vi.fn().mockResolvedValue(undefined);

    await handleSyncChanges(engine, { [SYNC_BANK]: { newValue: bank } }, new SyncEchoes(), write);

    expect(applySyncedBank).toHaveBeenCalledWith(bank);
    expect(write).not.toHaveBeenCalled();
  });

  it('ignores a malformed bank while applying valid settings and lists from the batch', async () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, retentionDays: 30 };
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'blocked.example' }],
    };
    const applySyncedSettings = vi.fn().mockResolvedValue({ ok: true });
    const applySyncedLists = vi.fn().mockResolvedValue({ ok: true });
    const applySyncedBank = vi.fn(async (bank: BankState): Promise<{ ok: true }> => {
      void bank.balanceMs;
      return { ok: true };
    });
    const engine: SyncChangeEngine = makeEngine({
      applySyncedSettings,
      applySyncedLists,
      applySyncedBank,
    });

    await expect(
      handleSyncChanges(
        engine,
        {
          [SYNC_BANK]: { newValue: null },
          [SYNC_SETTINGS]: { newValue: settings },
          [SYNC_LISTS]: { newValue: lists },
        },
        new SyncEchoes(),
        vi.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toBeUndefined();

    expect(applySyncedBank).not.toHaveBeenCalled();
    expect(applySyncedSettings).toHaveBeenCalledWith(settings);
    expect(applySyncedLists).toHaveBeenCalledWith(lists);
  });

  it('ignores a malformed streak without throwing', async () => {
    const applySyncedStreak = vi.fn().mockResolvedValue(undefined);
    const engine: SyncChangeEngine = makeEngine({ applySyncedStreak });

    await expect(
      handleSyncChanges(
        engine,
        { [SYNC_STREAK]: { newValue: { current: 4 } } },
        new SyncEchoes(),
        vi.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toBeUndefined();

    expect(applySyncedStreak).not.toHaveBeenCalled();
  });

  it('ignores malformed live settings and lists instead of resetting them', async () => {
    const currentSettings: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 15_000 },
    };
    const currentLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'keep.example' }],
    };
    const applySyncedSettings = vi.fn().mockResolvedValue({ ok: true });
    const applySyncedLists = vi.fn().mockResolvedValue({ ok: true });
    const engine: SyncChangeEngine = makeEngine({
      applySyncedSettings,
      applySyncedLists,
      getSettings: vi.fn((): Settings => currentSettings),
      getLists: vi.fn((): ListsConfig => currentLists),
    });

    await handleSyncChanges(
      engine,
      {
        [SYNC_SETTINGS]: { newValue: null },
        [SYNC_LISTS]: { newValue: null },
      },
      new SyncEchoes(),
      vi.fn().mockResolvedValue(undefined),
    );
    await handleSyncChanges(
      engine,
      {
        [SYNC_SETTINGS]: { newValue: { gate: null } },
        [SYNC_LISTS]: { newValue: { custom: null } },
      },
      new SyncEchoes(),
      vi.fn().mockResolvedValue(undefined),
    );

    expect(applySyncedSettings).not.toHaveBeenCalled();
    expect(applySyncedLists).not.toHaveBeenCalled();
  });

  it('merges valid partial live settings and lists over current state', async () => {
    const currentSettings: Settings = { ...DEFAULT_SETTINGS, defaultMode: 'whitelist' };
    const currentLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'keep.example' }],
    };
    const applySyncedSettings = vi.fn().mockResolvedValue({ ok: true });
    const applySyncedLists = vi.fn().mockResolvedValue({ ok: true });
    const engine: SyncChangeEngine = makeEngine({
      applySyncedSettings,
      applySyncedLists,
      getSettings: vi.fn((): Settings => currentSettings),
      getLists: vi.fn((): ListsConfig => currentLists),
    });

    await handleSyncChanges(
      engine,
      {
        [SYNC_SETTINGS]: { newValue: { retentionDays: 30 } },
        [SYNC_LISTS]: { newValue: { categories: { social: true } } },
      },
      new SyncEchoes(),
      vi.fn().mockResolvedValue(undefined),
    );

    expect(applySyncedSettings).toHaveBeenCalledWith({
      ...currentSettings,
      retentionDays: 30,
    });
    expect(applySyncedLists).toHaveBeenCalledWith({
      ...currentLists,
      categories: { ...currentLists.categories, social: true },
    });
  });

  it('preserves the current schedule when any live schedule entry is malformed', async () => {
    const currentEntry: Settings['schedule'][number] = {
      id: 'keep',
      days: [1, 2, 3, 4, 5],
      start: '09:00',
      end: '10:00',
      mode: 'blacklist',
      strictness: 'hard',
      cycling: null,
      intention: 'Keep',
      enabled: true,
    };
    const replacement: Settings['schedule'][number] = {
      ...currentEntry,
      id: 'replacement',
      intention: 'Replace',
    };
    const current: Settings = { ...DEFAULT_SETTINGS, schedule: [currentEntry] };
    const applySyncedSettings = vi.fn().mockResolvedValue({ ok: true });
    const engine: SyncChangeEngine = makeEngine({
      applySyncedSettings,
      getSettings: vi.fn((): Settings => current),
    });

    await handleSyncChanges(
      engine,
      {
        [SYNC_SETTINGS]: {
          newValue: {
            retentionDays: 30,
            schedule: [replacement, { ...replacement, start: 'invalid' }],
          },
        },
      },
      new SyncEchoes(),
      vi.fn().mockResolvedValue(undefined),
    );

    expect(applySyncedSettings).toHaveBeenCalledWith({
      ...current,
      retentionDays: 30,
    });
  });

  it('clears the current schedule for an explicit empty live schedule', async () => {
    const current: Settings = {
      ...DEFAULT_SETTINGS,
      schedule: [
        {
          id: 'keep',
          days: [1, 2, 3, 4, 5],
          start: '09:00',
          end: '10:00',
          mode: 'blacklist',
          strictness: 'hard',
          cycling: null,
          intention: 'Keep',
          enabled: true,
        },
      ],
    };
    const applySyncedSettings = vi.fn().mockResolvedValue({ ok: true });
    const engine: SyncChangeEngine = makeEngine({
      applySyncedSettings,
      getSettings: vi.fn((): Settings => current),
    });

    await handleSyncChanges(
      engine,
      { [SYNC_SETTINGS]: { newValue: { schedule: [] } } },
      new SyncEchoes(),
      vi.fn().mockResolvedValue(undefined),
    );

    expect(applySyncedSettings).toHaveBeenCalledWith({ ...current, schedule: [] });
  });

  it('preserves a current rules field when any live rule is malformed', async () => {
    const current: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'keep.example' }],
    };
    const applySyncedLists = vi.fn().mockResolvedValue({ ok: true });
    const engine: SyncChangeEngine = makeEngine({
      applySyncedLists,
      getLists: vi.fn((): ListsConfig => current),
    });

    await handleSyncChanges(
      engine,
      {
        [SYNC_LISTS]: {
          newValue: {
            custom: [{ kind: 'host', pattern: 'replace.example' }, null],
            categories: { social: true },
          },
        },
      },
      new SyncEchoes(),
      vi.fn().mockResolvedValue(undefined),
    );

    expect(applySyncedLists).toHaveBeenCalledWith({
      ...current,
      categories: { ...current.categories, social: true },
    });
  });

  it('clears current rules fields for explicit empty live arrays', async () => {
    const current: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'custom.example' }],
      whitelist: [{ kind: 'host', pattern: 'whitelist.example' }],
    };
    const applySyncedLists = vi.fn().mockResolvedValue({ ok: true });
    const engine: SyncChangeEngine = makeEngine({
      applySyncedLists,
      getLists: vi.fn((): ListsConfig => current),
    });

    await handleSyncChanges(
      engine,
      { [SYNC_LISTS]: { newValue: { custom: [], whitelist: [] } } },
      new SyncEchoes(),
      vi.fn().mockResolvedValue(undefined),
    );

    expect(applySyncedLists).toHaveBeenCalledWith({
      ...current,
      custom: [],
      whitelist: [],
    });
  });

  it('merges partial live exclusions while preserving malformed and absent categories', async () => {
    const current: ListsConfig = {
      ...DEFAULT_LISTS,
      exclusions: {
        social: ['keep-social.example'],
        video: ['keep-video.example'],
        news: ['keep-news.example'],
        mail: ['keep-mail.example'],
        gaming: ['keep-gaming.example'],
      },
    };
    const applySyncedLists = vi.fn().mockResolvedValue({ ok: true });
    const engine: SyncChangeEngine = makeEngine({
      applySyncedLists,
      getLists: vi.fn((): ListsConfig => current),
    });

    await handleSyncChanges(
      engine,
      {
        [SYNC_LISTS]: {
          newValue: {
            exclusions: {
              social: [],
              video: ['replace-video.example', null],
              news: ['replace-news.example'],
              gaming: 'invalid',
            },
          },
        },
      },
      new SyncEchoes(),
      vi.fn().mockResolvedValue(undefined),
    );

    expect(applySyncedLists).toHaveBeenCalledWith({
      ...current,
      exclusions: {
        ...current.exclusions,
        social: [],
        news: ['replace-news.example'],
      },
    });
  });

  it('attempts later keys before reporting a settings apply failure', async () => {
    const failure: Error = new Error('settings apply failed');
    const applySyncedLists = vi.fn().mockResolvedValue({ ok: true });
    const applySyncedBank = vi.fn().mockResolvedValue({ ok: true });
    const applySyncedStreak = vi.fn().mockResolvedValue(undefined);
    const engine: SyncChangeEngine = makeEngine({
      applySyncedSettings: vi.fn().mockRejectedValue(failure),
      applySyncedLists,
      applySyncedBank,
      applySyncedStreak,
    });
    const streak: StreakState = {
      current: 1,
      freezeTokens: 0,
      lastCountedDate: '2026-08-28',
      lastFreezeGrantDate: null,
      activeDays: [28],
      activeMonth: '2026-08',
    };

    const reported: unknown = await handleSyncChanges(
      engine,
      {
        [SYNC_SETTINGS]: { newValue: { retentionDays: 30 } },
        [SYNC_LISTS]: {
          newValue: { custom: [{ kind: 'host', pattern: 'blocked.example' }] },
        },
        [SYNC_BANK]: { newValue: { balanceMs: 500 } },
        [SYNC_STREAK]: { newValue: streak },
      },
      new SyncEchoes(),
      vi.fn().mockResolvedValue(undefined),
    ).catch((error: unknown): unknown => error);

    expect(reported).toBeInstanceOf(AggregateError);
    expect((reported as AggregateError).errors).toEqual([failure]);

    expect(applySyncedLists).toHaveBeenCalled();
    expect(applySyncedBank).toHaveBeenCalled();
    expect(applySyncedStreak).toHaveBeenCalled();
  });

  it('attempts later keys before reporting a corrective write failure', async () => {
    const failure: Error = new Error('corrective write failed');
    const applySyncedLists = vi.fn().mockResolvedValue({ ok: true });
    const applySyncedBank = vi.fn().mockResolvedValue({ ok: true });
    const applySyncedStreak = vi.fn().mockResolvedValue(undefined);
    const engine: SyncChangeEngine = makeEngine({
      applySyncedSettings: vi.fn().mockResolvedValue({ ok: false, error: 'rejected' }),
      applySyncedLists,
      applySyncedBank,
      applySyncedStreak,
    });
    const streak: StreakState = {
      current: 1,
      freezeTokens: 0,
      lastCountedDate: '2026-08-28',
      lastFreezeGrantDate: null,
      activeDays: [28],
      activeMonth: '2026-08',
    };

    const reported: unknown = await handleSyncChanges(
      engine,
      {
        [SYNC_SETTINGS]: { newValue: { retentionDays: 30 } },
        [SYNC_LISTS]: {
          newValue: { custom: [{ kind: 'host', pattern: 'blocked.example' }] },
        },
        [SYNC_BANK]: { newValue: { balanceMs: 500 } },
        [SYNC_STREAK]: { newValue: streak },
      },
      new SyncEchoes(),
      vi.fn().mockRejectedValue(failure),
    ).catch((error: unknown): unknown => error);

    expect(reported).toBeInstanceOf(AggregateError);
    expect((reported as AggregateError).errors).toEqual([failure]);

    expect(applySyncedLists).toHaveBeenCalled();
    expect(applySyncedBank).toHaveBeenCalled();
    expect(applySyncedStreak).toHaveBeenCalled();
  });
});
