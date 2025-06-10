import { describe, expect, it, vi } from 'vitest';
import { encodeListsForSync, LIST_SYNC_SHARD_KEYS } from '../../../src/background/list-sync-codec';
import type { PolicyValueByKey } from '../../../src/background/policy-storage';
import {
  handleSyncChanges,
  missingSyncDefaults,
  type SyncChangeEngine,
  type SyncPolicyTransaction,
} from '../../../src/background/storage-sync';
import { SyncEchoes, SyncWriter } from '../../../src/background/sync-writer';
import { CATEGORY_IDS, DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';
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
  it('accepts mixed-version authoritative settings and mirrors only the canonical shape', async (): Promise<void> => {
    const legacy: Record<string, unknown> = {
      ...structuredClone(DEFAULT_SETTINGS),
      retentionDays: 30,
      allowForceEnd: false,
    };
    const canonical: Settings = { ...DEFAULT_SETTINGS, retentionDays: 30 };
    const transactSyncedPolicy = vi.fn(
      async (
        changes: Partial<PolicyValueByKey>,
        _reconcilePendingLists: boolean,
        mirror: (accepted: Partial<PolicyValueByKey>) => Promise<void>,
      ): Promise<{ ok: true }> => {
        await mirror(changes);
        return { ok: true };
      },
    );
    const transaction: SyncPolicyTransaction = {
      inboundSyncAllowed: vi.fn().mockResolvedValue(true),
      loadSnapshot: vi.fn(),
      mirrorAcceptedRemotePolicy: vi.fn().mockResolvedValue(undefined),
    };

    await handleSyncChanges(
      makeEngine({ transactSyncedPolicy }),
      { [SYNC_SETTINGS]: { newValue: legacy } },
      new SyncEchoes(),
      vi.fn(),
      false,
      undefined,
      transaction,
    );

    expect(transactSyncedPolicy).toHaveBeenCalledWith(
      { settings: canonical },
      false,
      expect.any(Function),
    );
    expect(transaction.mirrorAcceptedRemotePolicy).toHaveBeenCalledWith(
      { settings: canonical },
      [],
    );
  });

  it('uses the engine policy mutex across preview, mirror, and commit', async () => {
    const incoming: Settings = { ...DEFAULT_SETTINGS, retentionDays: 30 };
    const transaction: SyncPolicyTransaction = {
      inboundSyncAllowed: vi.fn().mockResolvedValue(true),
      loadSnapshot: vi.fn(),
      mirrorAcceptedRemotePolicy: vi.fn().mockResolvedValue(undefined),
    };
    const transactSyncedPolicy = vi.fn(
      async (
        changes: Partial<PolicyValueByKey>,
        _reconcilePendingLists: boolean,
        mirror: (accepted: Partial<PolicyValueByKey>) => Promise<void>,
      ): Promise<{ ok: true }> => {
        await mirror(changes);
        return { ok: true };
      },
    );
    const engine: SyncChangeEngine = makeEngine({ transactSyncedPolicy });

    await handleSyncChanges(
      engine,
      { [SYNC_SETTINGS]: { newValue: incoming } },
      new SyncEchoes(),
      vi.fn(),
      false,
      undefined,
      transaction,
      undefined,
      [SYNC_SETTINGS],
    );

    expect(transactSyncedPolicy).toHaveBeenCalledWith(
      { settings: incoming },
      false,
      expect.any(Function),
    );
    expect(transaction.mirrorAcceptedRemotePolicy).toHaveBeenCalledWith({ settings: incoming }, [
      SYNC_SETTINGS,
    ]);
  });

  it('rejects split preview and commit methods for a durable inbound transaction', async (): Promise<void> => {
    const transaction: SyncPolicyTransaction = {
      inboundSyncAllowed: vi.fn().mockResolvedValue(true),
      loadSnapshot: vi.fn(),
      mirrorAcceptedRemotePolicy: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      handleSyncChanges(
        makeEngine(),
        { [SYNC_SETTINGS]: { newValue: { ...DEFAULT_SETTINGS, retentionDays: 30 } } },
        new SyncEchoes(),
        vi.fn(),
        false,
        undefined,
        transaction,
      ),
    ).rejects.toThrow('transactional sync engine method');

    expect(transaction.mirrorAcceptedRemotePolicy).not.toHaveBeenCalled();
  });

  it('previews, mirrors, and commits accepted policy as one inbound transaction', async () => {
    const trace: string[] = [];
    const incoming: Settings = { ...DEFAULT_SETTINGS, retentionDays: 30 };
    const transactSyncedPolicy = vi.fn(
      async (
        changes: Partial<PolicyValueByKey>,
        _reconcilePendingLists: boolean,
        mirror: (accepted: Partial<PolicyValueByKey>) => Promise<void>,
      ): Promise<{ ok: true }> => {
        trace.push('preview');
        await mirror(changes);
        trace.push('commit');
        return { ok: true };
      },
    );
    const engine: SyncChangeEngine = makeEngine({ transactSyncedPolicy });
    const transaction: SyncPolicyTransaction = {
      inboundSyncAllowed: vi.fn().mockResolvedValue(true),
      loadSnapshot: vi.fn().mockResolvedValue({
        settings: DEFAULT_SETTINGS,
        lists: DEFAULT_LISTS,
        bank: { balanceMs: 0 },
        streak: null,
      }),
      mirrorAcceptedRemotePolicy: vi.fn(async (): Promise<void> => {
        trace.push('mirror');
      }),
    };

    await handleSyncChanges(
      engine,
      { [SYNC_SETTINGS]: { newValue: incoming } },
      new SyncEchoes(),
      vi.fn(),
      false,
      undefined,
      transaction,
    );

    expect(trace).toEqual(['preview', 'mirror', 'commit']);
    expect(transactSyncedPolicy).toHaveBeenCalledWith(
      { settings: incoming },
      false,
      expect.any(Function),
    );
    expect(transaction.mirrorAcceptedRemotePolicy).toHaveBeenCalledWith({ settings: incoming }, []);
  });

  it('leaves the engine unchanged when the durable mirror fails', async () => {
    const failure: Error = new Error('local mirror unavailable');
    const commitSyncedPolicy = vi.fn();
    const transactSyncedPolicy = vi.fn(
      async (
        changes: Partial<PolicyValueByKey>,
        _reconcilePendingLists: boolean,
        mirror: (accepted: Partial<PolicyValueByKey>) => Promise<void>,
      ): Promise<{ ok: true }> => {
        await mirror(changes);
        commitSyncedPolicy();
        return { ok: true };
      },
    );
    const engine: SyncChangeEngine = makeEngine({ transactSyncedPolicy });
    const transaction: SyncPolicyTransaction = {
      inboundSyncAllowed: vi.fn().mockResolvedValue(true),
      loadSnapshot: vi.fn(),
      mirrorAcceptedRemotePolicy: vi.fn().mockRejectedValue(failure),
    };

    await expect(
      handleSyncChanges(
        engine,
        { [SYNC_BANK]: { newValue: { balanceMs: 42_000 } } },
        new SyncEchoes(),
        vi.fn(),
        false,
        undefined,
        transaction,
      ),
    ).rejects.toThrow('local mirror unavailable');
    expect(commitSyncedPolicy).not.toHaveBeenCalled();
  });

  it('corrects a rejected transaction from verified local authority', async () => {
    const queueSync = vi.fn().mockResolvedValue(undefined);
    const queueVerifiedRemoteCorrections = vi.fn().mockResolvedValue(undefined);
    const engine: SyncChangeEngine = makeEngine({
      transactSyncedPolicy: vi.fn().mockResolvedValue({ ok: false, error: 'hard session' }),
    });
    const transaction: SyncPolicyTransaction = {
      inboundSyncAllowed: vi.fn().mockResolvedValue(true),
      loadSnapshot: vi.fn(),
      queueVerifiedRemoteCorrections,
      mirrorAcceptedRemotePolicy: vi.fn(),
    };

    await handleSyncChanges(
      engine,
      { [SYNC_SETTINGS]: { newValue: { ...DEFAULT_SETTINGS, retentionDays: 30 } } },
      new SyncEchoes(),
      queueSync,
      false,
      undefined,
      transaction,
    );

    expect(queueVerifiedRemoteCorrections).toHaveBeenCalledWith(['settings']);
    expect(queueSync).not.toHaveBeenCalled();
    expect(transaction.mirrorAcceptedRemotePolicy).not.toHaveBeenCalled();
  });

  it.each([
    [SYNC_SETTINGS, null, 'settings'],
    [SYNC_LISTS, null, 'lists'],
    [SYNC_BANK, { balanceMs: -1 }, 'bank'],
    [SYNC_STREAK, { current: 4 }, 'streak'],
  ] as const)(
    'corrects malformed inbound %s from verified local authority',
    async (remoteKey: string, malformed: unknown, policyKey: keyof PolicyValueByKey): Promise<void> => {
      const queueSync = vi.fn().mockResolvedValue(undefined);
      const transactSyncedPolicy = vi.fn();
      const queueVerifiedRemoteCorrections = vi.fn().mockResolvedValue(undefined);
      const transaction: SyncPolicyTransaction = {
        inboundSyncAllowed: vi.fn().mockResolvedValue(true),
        loadSnapshot: vi.fn().mockResolvedValue({
          settings: DEFAULT_SETTINGS,
          lists: DEFAULT_LISTS,
          bank: { balanceMs: 42_000 },
          streak: null,
        }),
        queueVerifiedRemoteCorrections,
        mirrorAcceptedRemotePolicy: vi.fn(),
      };
      const listSnapshot: Record<string, unknown> | undefined =
        remoteKey === SYNC_LISTS ? { [SYNC_LISTS]: malformed } : undefined;

      await handleSyncChanges(
        makeEngine({ transactSyncedPolicy }),
        { [remoteKey]: { newValue: malformed } },
        new SyncEchoes(),
        queueSync,
        false,
        listSnapshot,
        transaction,
      );

      expect(queueVerifiedRemoteCorrections).toHaveBeenCalledWith([policyKey]);
      expect(queueSync).not.toHaveBeenCalled();
      expect(transaction.loadSnapshot).not.toHaveBeenCalled();
      expect(transactSyncedPolicy).not.toHaveBeenCalled();
      expect(transaction.mirrorAcceptedRemotePolicy).not.toHaveBeenCalled();
    },
  );

  it('corrects incomplete inbound list shards through the serialized adapter operation', async (): Promise<void> => {
    const exclusions: ListsConfig['exclusions'] = {};
    for (const categoryId of CATEGORY_IDS) {
      exclusions[categoryId] = Array.from(
        { length: 60 },
        (_value: unknown, index: number): string => `${categoryId}-${index}.example`,
      );
    }
    const encoded = await encodeListsForSync({ ...DEFAULT_LISTS, exclusions });
    const incomplete: Record<string, unknown> = { ...encoded.sets };
    const missingShard: string = LIST_SYNC_SHARD_KEYS[0] as string;
    delete incomplete[missingShard];
    const queueVerifiedRemoteCorrections = vi.fn().mockResolvedValue(undefined);
    const transaction: SyncPolicyTransaction = {
      inboundSyncAllowed: vi.fn().mockResolvedValue(true),
      loadSnapshot: vi.fn(),
      queueVerifiedRemoteCorrections,
      mirrorAcceptedRemotePolicy: vi.fn(),
    };

    await handleSyncChanges(
      makeEngine({ transactSyncedPolicy: vi.fn() }),
      { [SYNC_LISTS]: { newValue: incomplete[SYNC_LISTS] } },
      new SyncEchoes(),
      vi.fn(),
      false,
      incomplete,
      transaction,
    );

    expect(queueVerifiedRemoteCorrections).toHaveBeenCalledWith(['lists']);
    expect(transaction.loadSnapshot).not.toHaveBeenCalled();
  });

  it('suppresses inbound correction while deletion is pending', async (): Promise<void> => {
    const queueSync = vi.fn();
    const transaction: SyncPolicyTransaction = {
      inboundSyncAllowed: vi.fn().mockResolvedValue(false),
      loadSnapshot: vi.fn(),
      mirrorAcceptedRemotePolicy: vi.fn(),
    };

    await handleSyncChanges(
      makeEngine({ transactSyncedPolicy: vi.fn() }),
      { [SYNC_SETTINGS]: { newValue: null } },
      new SyncEchoes(),
      queueSync,
      false,
      undefined,
      transaction,
    );

    expect(transaction.loadSnapshot).not.toHaveBeenCalled();
    expect(queueSync).not.toHaveBeenCalled();
  });

  it('rejects inbound handling before loading list shards outside sync mode', async () => {
    const loadListSnapshot = vi.fn().mockResolvedValue({});
    const engine: SyncChangeEngine = makeEngine();
    const transaction: SyncPolicyTransaction = {
      inboundSyncAllowed: vi.fn().mockResolvedValue(false),
      loadSnapshot: vi.fn(),
      mirrorAcceptedRemotePolicy: vi.fn(),
    };

    await handleSyncChanges(
      engine,
      { [SYNC_LISTS]: { newValue: DEFAULT_LISTS } },
      new SyncEchoes(),
      vi.fn(),
      false,
      undefined,
      transaction,
      loadListSnapshot,
    );

    expect(loadListSnapshot).not.toHaveBeenCalled();
  });

  it('republishes verified local policy after an external Sync removal', async () => {
    const queueSync = vi.fn().mockResolvedValue(undefined);
    const queueVerifiedRemoteCorrections = vi.fn().mockResolvedValue(undefined);
    const transaction: SyncPolicyTransaction = {
      inboundSyncAllowed: vi.fn().mockResolvedValue(true),
      loadSnapshot: vi.fn(),
      queueVerifiedRemoteCorrections,
      mirrorAcceptedRemotePolicy: vi.fn(),
    };

    await handleSyncChanges(
      makeEngine({ transactSyncedPolicy: vi.fn() }),
      { [SYNC_SETTINGS]: { oldValue: { remote: true } } },
      new SyncEchoes(),
      queueSync,
      false,
      undefined,
      transaction,
    );

    expect(queueVerifiedRemoteCorrections).toHaveBeenCalledWith(['settings']);
    expect(queueSync).not.toHaveBeenCalled();
  });

  it('republishes the complete local lists after an external shard removal', async () => {
    const queueSync = vi.fn().mockResolvedValue(undefined);
    const queueVerifiedRemoteCorrections = vi.fn().mockResolvedValue(undefined);
    const transaction: SyncPolicyTransaction = {
      inboundSyncAllowed: vi.fn().mockResolvedValue(true),
      loadSnapshot: vi.fn(),
      queueVerifiedRemoteCorrections,
      mirrorAcceptedRemotePolicy: vi.fn(),
    };

    await handleSyncChanges(
      makeEngine({ transactSyncedPolicy: vi.fn() }),
      { [LIST_SYNC_SHARD_KEYS[0] as string]: { newValue: undefined } },
      new SyncEchoes(),
      queueSync,
      false,
      undefined,
      transaction,
    );

    expect(queueVerifiedRemoteCorrections).toHaveBeenCalledWith(['lists']);
    expect(queueSync).not.toHaveBeenCalled();
  });

  it('consumes an expected local Sync removal without republishing it', async () => {
    const echoes: SyncEchoes = new SyncEchoes();
    echoes.rememberRemoval(SYNC_STREAK);
    const queueSync = vi.fn();
    const transaction: SyncPolicyTransaction = {
      inboundSyncAllowed: vi.fn().mockResolvedValue(true),
      loadSnapshot: vi.fn(),
      mirrorAcceptedRemotePolicy: vi.fn(),
    };

    await handleSyncChanges(
      makeEngine({ transactSyncedPolicy: vi.fn() }),
      { [SYNC_STREAK]: { newValue: undefined } },
      echoes,
      queueSync,
      false,
      undefined,
      transaction,
    );

    expect(queueSync).not.toHaveBeenCalled();
    expect(transaction.loadSnapshot).not.toHaveBeenCalled();
  });

  it('waits for a complete single-revision sharded lists snapshot', async () => {
    const exclusions: ListsConfig['exclusions'] = {};
    for (const categoryId of CATEGORY_IDS) {
      exclusions[categoryId] = Array.from(
        { length: 60 },
        (_value: unknown, index: number): string => `${categoryId}-${index}.example`,
      );
    }
    const remote: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true },
      exclusions,
    };
    const encoded = await encodeListsForSync(remote);
    const applySyncedLists = vi.fn().mockResolvedValue({ ok: true });
    const engine: SyncChangeEngine = makeEngine({ applySyncedLists });
    const incomplete: Record<string, unknown> = { ...encoded.sets };
    delete incomplete[LIST_SYNC_SHARD_KEYS[0] as string];

    await handleSyncChanges(
      engine,
      { [SYNC_LISTS]: { newValue: encoded.sets[SYNC_LISTS] } },
      new SyncEchoes(),
      vi.fn(),
      false,
      incomplete,
    );
    expect(applySyncedLists).not.toHaveBeenCalled();

    await handleSyncChanges(
      engine,
      {
        [LIST_SYNC_SHARD_KEYS[0] as string]: {
          newValue: encoded.sets[LIST_SYNC_SHARD_KEYS[0] as string],
        },
      },
      new SyncEchoes(),
      vi.fn(),
      false,
      encoded.sets,
    );
    expect(applySyncedLists).toHaveBeenCalledOnce();
    expect(applySyncedLists).toHaveBeenCalledWith(remote, false);
  });

  it('does not partially apply a recognizable invalid split base live', async () => {
    const current: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'keep-current.example' }],
    };
    const invalidBase: Record<string, unknown> = {
      format: 'category-shards-v1',
      revision: '0'.repeat(64),
      custom: [{ kind: 'host', pattern: 'must-not-apply.example' }],
      whitelist: [],
      unexpected: true,
    };
    const applySyncedLists = vi.fn().mockResolvedValue({ ok: true });
    const engine: SyncChangeEngine = makeEngine({
      applySyncedLists,
      getLists: vi.fn((): ListsConfig => current),
    });

    await handleSyncChanges(
      engine,
      { [SYNC_LISTS]: { newValue: invalidBase } },
      new SyncEchoes(),
      vi.fn(),
      false,
      { [SYNC_LISTS]: invalidBase },
    );

    expect(applySyncedLists).not.toHaveBeenCalled();
  });

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
