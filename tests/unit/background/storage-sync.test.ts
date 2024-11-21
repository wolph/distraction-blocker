import { describe, expect, it, vi } from 'vitest';
import { handleSyncChanges, type SyncChangeEngine } from '../../../src/background/storage-sync';
import { SyncEchoes } from '../../../src/background/sync-writer';
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
    const write = vi.fn().mockResolvedValue(undefined);

    await handleSyncChanges(engine, { [SYNC_SETTINGS]: { newValue: weaker } }, echoes, write);
    await handleSyncChanges(
      engine,
      { [SYNC_SETTINGS]: { newValue: DEFAULT_SETTINGS } },
      echoes,
      write,
    );

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({ [SYNC_SETTINGS]: DEFAULT_SETTINGS });
    expect(applySyncedSettings).toHaveBeenCalledTimes(1);
  });

  it('corrects rejected lists and consumes the corrective echo', async () => {
    const weaker: ListsConfig = { ...DEFAULT_LISTS, custom: [] };
    const applySyncedLists = vi.fn().mockResolvedValue({ ok: false, error: 'hard session' });
    const engine: SyncChangeEngine = makeEngine({ applySyncedLists });
    const echoes: SyncEchoes = new SyncEchoes();
    const write = vi.fn().mockResolvedValue(undefined);

    await handleSyncChanges(engine, { [SYNC_LISTS]: { newValue: weaker } }, echoes, write);
    await handleSyncChanges(engine, { [SYNC_LISTS]: { newValue: DEFAULT_LISTS } }, echoes, write);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({ [SYNC_LISTS]: DEFAULT_LISTS });
    expect(applySyncedLists).toHaveBeenCalledTimes(1);
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
});
