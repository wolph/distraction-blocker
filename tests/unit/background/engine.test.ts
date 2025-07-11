import { describe, expect, it, type Mock, vi } from 'vitest';
import type { BlockingSweepLease, EnginePorts } from '../../../src/background/engine';
import { Engine } from '../../../src/background/engine';
import { encodeListsForSync, LIST_SYNC_SHARD_KEYS } from '../../../src/background/list-sync-codec';
import { clockRebaseArchiveKey } from '../../../src/background/rollover';
import {
  appendEvents,
  emptyRuntime,
  mergeRuntime,
  migrateRuntimeRules,
  type RuntimeState,
  readEvents,
} from '../../../src/background/stores';
import { syncItemBytes } from '../../../src/background/sync-quota';
import { type SyncJournal, SyncWriter } from '../../../src/background/sync-writer';
import { ALL_CATEGORIES } from '../../../src/core/categories';
import { buildMatcherCache, compileSessionMatcher } from '../../../src/core/matcher';
import { beginPause, endPauseEarly, startSession } from '../../../src/core/session';
import { emptyDaily } from '../../../src/core/stats';
import {
  CATEGORY_IDS,
  cancelPhrase,
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  GATE_EXPIRY_MS,
  rulesFromLists,
  TOP_SITES_DAILY,
} from '../../../src/shared/constants';
import type { Ack } from '../../../src/shared/messages';
import {
  LOCAL_EVENTS,
  SYNC_BANK,
  SYNC_LISTS,
  SYNC_SETTINGS,
  SYNC_STREAK,
  syncAggKey,
} from '../../../src/shared/storage-keys';
import { localDateStr } from '../../../src/shared/time';
import type {
  DailyAgg,
  EventRecord,
  GateKind,
  ListsConfig,
  ScheduleEntry,
  SessionConfig,
  SessionRuleSnapshot,
  SessionSnapshot,
  Settings,
  StreakState,
  Verdict,
} from '../../../src/shared/types';

interface Harness {
  engine: Engine;
  ports: {
    [K in keyof EnginePorts]: ReturnType<typeof vi.fn>;
  } & {
    hasPendingSync: ReturnType<typeof vi.fn>;
    saveMatcherCache: ReturnType<typeof vi.fn>;
  };
  setNow(ms: number): void;
  loggedEvents(): EventRecord[];
}

interface GatePhraseCase {
  gate: GateKind;
  host: string | null;
  expectedPhrase: string;
}

const T0: number = new Date(2026, 7, 29, 8, 59).getTime();
const DAY_MS: number = 86_400_000;

function appendUnique(into: EventRecord[], events: EventRecord[]): void {
  const seen: Set<string> = new Set(
    into.map((event: EventRecord): string => JSON.stringify(event)),
  );
  for (const event of events) {
    const key: string = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    into.push(event);
  }
}

function oversizedHostRules(prefix: string): ListsConfig['custom'] {
  return Array.from({ length: 600 }, (_value: unknown, index: number) => ({
    kind: 'host' as const,
    pattern: `${prefix}-${index}.example`,
  }));
}

function highCardinalityDaily(date: string, count: number): DailyAgg {
  return {
    date,
    focusMs: 0,
    sessionsStarted: 0,
    sessionsCompleted: 0,
    attempts: Object.fromEntries(
      Array.from({ length: count }, (_value: unknown, index: number): [string, number] => [
        `site-${String(index).padStart(4, '0')}.example`,
        count - index,
      ]),
    ),
    attemptsOther: 0,
    pausesTaken: 0,
    pauseMsSpent: 0,
    pauseMsEarned: 0,
    unlocksTaken: 0,
    unlockMsSpent: 0,
    resisted: 0,
  };
}

function splittableLists(custom: ListsConfig['custom'] = []): ListsConfig {
  const exclusions: ListsConfig['exclusions'] = {};
  for (const categoryId of CATEGORY_IDS) {
    exclusions[categoryId] = Array.from(
      { length: 60 },
      (_value: unknown, index: number): string => `${categoryId}-${index}.example`,
    );
  }
  return {
    ...DEFAULT_LISTS,
    custom,
    categories: { ...DEFAULT_LISTS.categories, social: true },
    exclusions,
  };
}

function clearMutationPorts(ports: Harness['ports']): void {
  ports.now.mockClear();
  ports.saveRuntime.mockClear();
  ports.queueSync.mockClear();
  ports.removeSync.mockClear();
  ports.appendEvents.mockClear();
  ports.broadcast.mockClear();
  ports.applyBlocking.mockClear();
  ports.updateIcon.mockClear();
  ports.scheduleWake.mockClear();
  ports.saveMatcherCache.mockClear();
}

function lastSavedRuntime(harness: Harness): RuntimeState {
  const saved: unknown = harness.ports.saveRuntime.mock.calls.at(-1)?.[0];
  if (saved === undefined) throw new Error('expected a saved runtime');
  return saved as RuntimeState;
}

function hasCommitCheckpoint(runtime: RuntimeState): boolean {
  return (runtime as RuntimeState & { commitCheckpoint?: unknown }).commitCheckpoint != null;
}

function makeEngine(opts?: {
  bankMs?: number;
  settings?: Partial<Settings>;
  runtime?: RuntimeState;
  streak?: StreakState | null;
  queueSync?: EnginePorts['queueSync'];
  supersedeSync?: EnginePorts['supersedeSync'];
  persistSyncJournal?: EnginePorts['persistSyncJournal'];
  saveMatcherCache?: EnginePorts['saveMatcherCache'];
  savePolicy?: EnginePorts['savePolicy'];
  saveAggregate?: EnginePorts['saveAggregate'];
  removeAggregate?: EnginePorts['removeAggregate'];
  applyBlocking?: EnginePorts['applyBlocking'];
  sessionCompiler?: typeof compileSessionMatcher;
  hasPendingSync?: (key: string) => boolean;
  websiteBlockingReady?: () => boolean;
  lists?: ListsConfig;
}): Harness {
  let nowMs: number = T0;
  const ports: Harness['ports'] = {
    now: vi.fn((): number => nowMs),
    newId: vi.fn((): string => 'archive-id'),
    rehydrateAfterDataClear: vi.fn().mockResolvedValue('dev-rehydrated'),
    saveRuntime: vi.fn().mockResolvedValue(undefined),
    ...(opts?.savePolicy === undefined ? {} : { savePolicy: vi.fn(opts.savePolicy) }),
    ...(opts?.saveAggregate === undefined ? {} : { saveAggregate: vi.fn(opts.saveAggregate) }),
    ...(opts?.removeAggregate === undefined
      ? {}
      : { removeAggregate: vi.fn(opts.removeAggregate) }),
    queueSync: opts?.queueSync === undefined ? vi.fn() : vi.fn(opts.queueSync),
    supersedeSync: opts?.supersedeSync === undefined ? vi.fn() : vi.fn(opts.supersedeSync),
    removeSync: vi.fn(),
    persistSyncJournal:
      opts?.persistSyncJournal === undefined
        ? vi.fn().mockResolvedValue(undefined)
        : vi.fn(opts.persistSyncJournal),
    appendEvents: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn(),
    applyBlocking:
      opts?.applyBlocking === undefined
        ? vi.fn().mockResolvedValue(undefined)
        : vi.fn(opts.applyBlocking),
    playSound: vi.fn(),
    notify: vi.fn(),
    updateIcon: vi.fn(),
    scheduleWake: vi.fn(),
    prune: vi.fn().mockResolvedValue(undefined),
    reportError: vi.fn(),
    websiteBlockingReady:
      opts?.websiteBlockingReady === undefined
        ? vi.fn((): boolean => true)
        : vi.fn(opts.websiteBlockingReady),
    hasPendingSync:
      opts?.hasPendingSync === undefined ? vi.fn((): boolean => false) : vi.fn(opts.hasPendingSync),
    saveMatcherCache:
      opts?.saveMatcherCache === undefined
        ? vi.fn().mockResolvedValue(undefined)
        : vi.fn(opts.saveMatcherCache),
  };
  const settings: Settings = { ...DEFAULT_SETTINGS, ...opts?.settings };
  const lists: ListsConfig =
    opts?.lists ??
    ({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'facebook.com' }],
    } satisfies ListsConfig);
  const engine: Engine = new Engine(
    ports as unknown as EnginePorts,
    settings,
    lists,
    { balanceMs: opts?.bankMs ?? 0 },
    opts?.streak ?? null,
    opts?.runtime ?? emptyRuntime(T0),
    'dev-test',
    opts?.sessionCompiler,
  );
  return {
    engine,
    ports,
    setNow: (ms: number): void => {
      nowMs = ms;
    },
    loggedEvents: (): EventRecord[] =>
      ports.appendEvents.mock.calls.flatMap((c: unknown[]): EventRecord[] => c[0] as EventRecord[]),
  };
}

const ENGINE_LISTS: ListsConfig = {
  ...DEFAULT_LISTS,
  custom: [{ kind: 'host', pattern: 'facebook.com' }],
};

const manualConfig: SessionConfig = {
  mode: 'blacklist',
  strictness: 'friction',
  durationMin: 25,
  cycling: null,
  intention: 'write the report',
  source: 'manual',
  scheduleEntryId: null,
  rules: rulesFromLists(ENGINE_LISTS),
};

it('migrates the exact predecessor rule snapshot and enforces its active session rules', (): void => {
  const currentRules: SessionRuleSnapshot = {
    ...rulesFromLists(ENGINE_LISTS),
    sessionBlacklist: [{ kind: 'host', pattern: 'session-only.example' }],
    sessionAllowlist: [{ kind: 'host', pattern: 'session-allow.example' }],
  };
  const predecessorRules: Record<string, unknown> = structuredClone(
    currentRules,
  ) as unknown as Record<string, unknown>;
  delete predecessorRules.baselineCategories;
  const storedSession = startSession(structuredClone(manualConfig), T0, 'predecessor-session');
  (storedSession.config as unknown as { rules: unknown }).rules = predecessorRules;

  const runtime: RuntimeState = migrateRuntimeRules(
    mergeRuntime({ session: storedSession }, T0),
    ENGINE_LISTS,
  );
  const harness: Harness = makeEngine({ runtime, lists: ENGINE_LISTS });

  expect(runtime.session?.config.rules).toEqual({
    ...currentRules,
    baselineCategories: currentRules.categories,
  });
  expect(runtime.session?.config.rules.sessionBlacklist).toEqual([
    { kind: 'host', pattern: 'session-only.example' },
  ]);
  expect(runtime.session?.config.rules.sessionAllowlist).toEqual([
    { kind: 'host', pattern: 'session-allow.example' },
  ]);
  expect(harness.engine.verdictFor('https://session-only.example/work')).toEqual({
    blocked: true,
    reason: 'custom',
    categoryId: null,
    matchedPattern: 'session-only.example',
  });
});

const scheduledEntry: ScheduleEntry = {
  id: 'weekday-focus',
  days: [0, 1, 2, 3, 4, 5, 6],
  start: '09:00',
  end: '10:00',
  mode: 'blacklist',
  strictness: 'hard',
  cycling: null,
  intention: 'scheduled work',
  enabled: true,
};

function oversizedSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    schedule: [{ ...scheduledEntry, intention: 'x'.repeat(8_192) }],
  };
}

describe('Engine', () => {
  it('rejects a manual start before creating runtime state when website blocking is unavailable', async (): Promise<void> => {
    const h: Harness = makeEngine({ websiteBlockingReady: (): boolean => false });

    await expect(h.engine.startSession(manualConfig)).resolves.toEqual({
      ok: false,
      error:
        'Website blocking is not enabled. Finish setup or grant website access, then try again.',
    });

    expect(h.engine.snapshot().phase).toBe('idle');
    expect(h.ports.newId).not.toHaveBeenCalled();
    expect(h.ports.appendEvents).not.toHaveBeenCalled();
    expect(h.ports.applyBlocking).not.toHaveBeenCalled();
  });

  it('keeps an unavailable scheduled start eligible and notifies once per occurrence', (): void => {
    let ready: boolean = false;
    const h: Harness = makeEngine({
      settings: { schedule: [scheduledEntry] },
      websiteBlockingReady: (): boolean => ready,
    });
    h.setNow(new Date(2026, 7, 29, 9, 1).getTime());

    expect(h.engine.snapshot()).toMatchObject({ phase: 'idle', scheduleActive: false });
    expect(h.engine.snapshot()).toMatchObject({ phase: 'idle', scheduleActive: false });
    expect(h.ports.newId).not.toHaveBeenCalled();
    expect(h.ports.playSound).not.toHaveBeenCalled();
    expect(h.ports.notify).toHaveBeenCalledOnce();
    expect(h.ports.notify).toHaveBeenCalledWith(
      'Focus schedule could not start',
      'Website blocking is not enabled. Finish setup or grant website access, then try again.',
    );

    ready = true;
    expect(h.engine.snapshot()).toMatchObject({
      phase: 'focus',
      scheduleActive: true,
      config: { source: 'schedule', scheduleEntryId: scheduledEntry.id },
    });
    expect(h.ports.newId).toHaveBeenCalledOnce();
  });

  it('deduplicates an unavailable schedule notice after a worker restart', async (): Promise<void> => {
    const insideWindow: number = new Date(2026, 7, 29, 9, 1).getTime();
    const first: Harness = makeEngine({
      settings: { schedule: [scheduledEntry] },
      websiteBlockingReady: (): boolean => false,
    });
    first.setNow(insideWindow);
    await first.engine.snapshotPersisted();
    const persisted: RuntimeState = structuredClone(
      first.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );

    const restarted: Harness = makeEngine({
      runtime: persisted,
      settings: { schedule: [scheduledEntry] },
      websiteBlockingReady: (): boolean => false,
    });
    restarted.setNow(insideWindow);
    expect(restarted.engine.snapshot()).toMatchObject({ phase: 'idle', scheduleActive: false });
    expect(restarted.ports.notify).not.toHaveBeenCalled();
  });

  it('ends an active Hard session and clears blocking when website access is lost', async (): Promise<void> => {
    const h: Harness = makeEngine();
    await h.engine.startSession({ ...manualConfig, strictness: 'hard' });
    clearMutationPorts(h.ports);

    await h.engine.endSessionForWebsiteBlockingLoss();

    expect(h.engine.snapshot()).toMatchObject({ phase: 'idle', gate: null, activeUnlocks: [] });
    expect(h.loggedEvents()).toContainEqual(expect.objectContaining({ t: 'sessionCanceled' }));
    expect(h.ports.saveRuntime).toHaveBeenCalled();
    expect(h.ports.applyBlocking).toHaveBeenCalledOnce();
  });

  it('compiles one matcher when a manual session starts and reuses it for verdicts', async (): Promise<void> => {
    const sessionCompiler: Mock<typeof compileSessionMatcher> = vi.fn(compileSessionMatcher);
    const h: Harness = makeEngine({ sessionCompiler });

    await h.engine.startSession(manualConfig);
    h.engine.verdictFor('https://facebook.com/feed');
    h.engine.verdictFor('https://facebook.com/messages');

    expect(sessionCompiler).toHaveBeenCalledTimes(1);
    expect(sessionCompiler).toHaveBeenCalledWith(
      manualConfig.rules,
      ALL_CATEGORIES,
      manualConfig.mode,
    );
  });

  it('compiles one matcher from persisted rules at worker restart and reuses it', async (): Promise<void> => {
    const first: Harness = makeEngine();
    await first.engine.startSession(manualConfig);
    const persisted: RuntimeState = structuredClone(
      first.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    const sessionCompiler: Mock<typeof compileSessionMatcher> = vi.fn(compileSessionMatcher);

    const restarted: Harness = makeEngine({ runtime: persisted, sessionCompiler });
    restarted.engine.verdictFor('https://facebook.com/feed');
    restarted.engine.verdictFor('https://facebook.com/messages');

    expect(sessionCompiler).toHaveBeenCalledTimes(1);
    expect(sessionCompiler).toHaveBeenCalledWith(
      persisted.session?.config.rules,
      ALL_CATEGORIES,
      persisted.session?.config.mode,
    );
  });

  it('replaces the compiled matcher when an ended session is followed by a new session', async (): Promise<void> => {
    const sessionCompiler: Mock<typeof compileSessionMatcher> = vi.fn(compileSessionMatcher);
    const h: Harness = makeEngine({ sessionCompiler });
    await h.engine.startSession(manualConfig);
    h.setNow(T0 + 25 * 60_000);

    expect(h.engine.verdictFor('https://facebook.com/feed').reason).toBe('no-session');

    const nextConfig: SessionConfig = {
      ...manualConfig,
      rules: {
        ...manualConfig.rules,
        sessionBlacklist: [{ kind: 'host', pattern: 'next-session.example' }],
      },
    };
    await h.engine.startSession(nextConfig);

    expect(sessionCompiler).toHaveBeenCalledTimes(2);
    expect(h.engine.verdictFor('https://next-session.example/page').blocked).toBe(true);
  });

  it('does not expose mutable session config or rules through snapshots', async (): Promise<void> => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    const expectedRules: SessionRuleSnapshot = structuredClone(manualConfig.rules);
    const outbound: SessionSnapshot = h.engine.snapshot();
    if (outbound.config === null) throw new Error('expected an active config');

    outbound.config.rules.permanentBlacklist[0] = {
      kind: 'host',
      pattern: 'mutated.example',
    };
    outbound.config.rules.sessionBlacklist.push({ kind: 'host', pattern: 'injected.example' });
    outbound.config.rules.categories.social = true;
    outbound.config.rules.exclusions.social = ['mutated.example'];

    expect(h.engine.verdictFor('https://facebook.com/feed').blocked).toBe(true);
    expect(h.engine.verdictFor('https://mutated.example/page').blocked).toBe(false);
    expect(h.engine.verdictFor('https://injected.example/page').blocked).toBe(false);
    expect(h.engine.snapshot().config?.rules).toEqual(expectedRules);
    await h.engine.snapshotPersisted();
    const saved: RuntimeState | undefined = h.ports.saveRuntime.mock.calls.at(-1)?.[0] as
      | RuntimeState
      | undefined;
    expect(saved?.session?.config.rules).toEqual(expectedRules);
  });

  it('uses the session snapshot for both session modes', async () => {
    const h: Harness = makeEngine();

    await h.engine.startSession(manualConfig);
    expect(h.engine.verdictFor('https://facebook.com/feed').blocked).toBe(true);

    const whitelist: Harness = makeEngine();
    await whitelist.engine.startSession({
      ...manualConfig,
      mode: 'whitelist',
      rules: {
        ...manualConfig.rules,
        sessionAllowlist: [{ kind: 'host', pattern: 'github.com' }],
      },
    });
    expect(whitelist.engine.verdictFor('https://github.com/openai').blocked).toBe(false);
  });

  it('accepts and enforces a session category override without mutating persistent lists', async (): Promise<void> => {
    const h: Harness = makeEngine();
    const before: ListsConfig = h.engine.getLists();
    const rules: SessionRuleSnapshot = {
      ...manualConfig.rules,
      categories: { ...manualConfig.rules.categories, social: true },
    };

    await expect(h.engine.startSession({ ...manualConfig, rules })).resolves.toEqual({ ok: true });

    expect(h.engine.snapshot().config?.rules.categories.social).toBe(true);
    expect(h.engine.verdictFor('https://instagram.com/explore')).toEqual({
      blocked: true,
      reason: 'category',
      categoryId: 'social',
      matchedPattern: 'instagram.com',
    });
    expect(h.engine.getLists()).toEqual(before);
  });

  it.each([
    ['stale revision', { ...manualConfig.rules, baselineRevision: 'lists-v1:stale' }],
    [
      'forged permanent provenance',
      {
        ...manualConfig.rules,
        permanentBlacklist: [{ kind: 'host' as const, pattern: 'forged.example' }],
      },
    ],
    [
      'forged category baseline',
      {
        ...manualConfig.rules,
        baselineCategories: { ...manualConfig.rules.baselineCategories, social: true },
      },
    ],
    [
      'forged exclusion baseline',
      {
        ...manualConfig.rules,
        exclusions: { social: ['facebook.com'] },
      },
    ],
    [
      'forged permanent allowlist',
      {
        ...manualConfig.rules,
        permanentAllowlist: [{ kind: 'regex' as const, pattern: 'trusted\\.example' }],
      },
    ],
  ])('rejects a %s before starting', async (_case: string, rules): Promise<void> => {
    const h: Harness = makeEngine();

    await expect(h.engine.startSession({ ...manualConfig, rules })).resolves.toEqual({
      ok: false,
      error: 'Your default blocking lists changed. Review this session and start again.',
    });
    expect(h.engine.snapshot().phase).toBe('idle');
  });

  it('normalizes and persists session-added hosts at the worker boundary', async (): Promise<void> => {
    const h: Harness = makeEngine();
    const config: SessionConfig = {
      ...manualConfig,
      mode: 'whitelist',
      rules: {
        ...manualConfig.rules,
        sessionAllowlist: [{ kind: 'host', pattern: '  HTTPS://Docs.Python.org/3/library/  ' }],
      },
    };

    await expect(h.engine.startSession(config)).resolves.toEqual({ ok: true });

    expect(h.engine.snapshot().config?.rules.sessionAllowlist).toEqual([
      { kind: 'host', pattern: 'docs.python.org' },
    ]);
    expect(h.engine.verdictFor('https://docs.python.org/3/').blocked).toBe(false);
  });

  it('keeps the active policy immutable across list changes and worker restart', async (): Promise<void> => {
    const first: Harness = makeEngine();
    await first.engine.startSession(manualConfig);
    const replacementLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'replacement.example' }],
    };

    await expect(first.engine.updateLists(replacementLists)).resolves.toEqual({ ok: true });
    expect(first.engine.verdictFor('https://facebook.com/feed').blocked).toBe(true);
    expect(first.engine.verdictFor('https://replacement.example/page').blocked).toBe(false);

    const persisted: RuntimeState = structuredClone(
      first.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    const restarted: Harness = makeEngine({ runtime: persisted, lists: replacementLists });
    expect(restarted.engine.verdictFor('https://facebook.com/feed').blocked).toBe(true);
    expect(restarted.engine.verdictFor('https://replacement.example/page').blocked).toBe(false);
  });

  it('keeps the active policy immutable across a settings change', async (): Promise<void> => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);

    await expect(
      h.engine.updateSettings({ ...DEFAULT_SETTINGS, defaultMode: 'whitelist' }),
    ).resolves.toEqual({ ok: true });

    expect(h.engine.verdictFor('https://facebook.com/feed').blocked).toBe(true);
  });

  it('forwards background errors to the configured port', () => {
    const h: Harness = makeEngine();
    const error = new Error('transient tab read failure');

    h.engine.reportError(error);

    expect(h.ports.reportError).toHaveBeenCalledWith(error);
  });

  it('atomically settles mute ownership after a concurrent URL rebind', async () => {
    const h: Harness = makeEngine();
    const engine = h.engine as Engine & {
      settleMuteClaim(tabId: number, finalUrl: string | null): Promise<void>;
    };

    await h.engine.claimMute(7, 'https://blocked.example/source', false);
    await h.engine.markStopped(7, 'https://blocked.example/source', 'replacement-document');
    await h.engine.transferMuteClaim(
      7,
      'https://blocked.example/source',
      'https://blocked.example/intermediate',
    );

    expect(typeof engine.settleMuteClaim).toBe('function');
    await engine.settleMuteClaim(7, 'https://blocked.example/final');
    expect(h.engine.tabFacts(7, 'https://blocked.example/final').wasMutedByUs).toBe(true);
    await engine.settleMuteClaim(7, null);
    expect(h.engine.tabFacts(7, 'https://blocked.example/final').wasMutedByUs).toBe(false);
    expect(
      h.engine.tabFacts(7, 'https://blocked.example/final', 'replacement-document').wasStopped,
    ).toBe(true);
  });

  it('startSession broadcasts, applies blocking, schedules a wake', async () => {
    const h: Harness = makeEngine();
    const ack = await h.engine.startSession(manualConfig);
    expect(ack).toEqual({ ok: true });
    expect(h.ports.applyBlocking).toHaveBeenCalled();
    expect(h.ports.scheduleWake).toHaveBeenCalledWith(T0 + 25 * 60_000);
    const snap = h.engine.snapshot();
    expect(snap.phase).toBe('focus');
    expect(h.ports.broadcast).toHaveBeenCalled();
    expect(h.loggedEvents().some((e: EventRecord): boolean => e.t === 'sessionStarted')).toBe(true);
  });

  it('persists the injected session identity and reuses it after restart', async () => {
    const first: Harness = makeEngine();
    await first.engine.startSession(manualConfig);

    const persisted: RuntimeState = first.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState;
    const started: EventRecord | undefined = first
      .loggedEvents()
      .find((event: EventRecord): boolean => event.t === 'sessionStarted');
    expect(persisted.session?.sessionId).toBe('archive-id');
    expect(started).toMatchObject({ t: 'sessionStarted', sessionId: 'archive-id' });

    const restarted: Harness = makeEngine({ runtime: persisted });
    await restarted.engine.recordAttempt('https://facebook.com/feed', 7, 'navigation');

    expect(restarted.ports.newId).not.toHaveBeenCalled();
    expect(restarted.loggedEvents()).toContainEqual(
      expect.objectContaining({ t: 'attempt', sessionId: 'archive-id' }),
    );
  });

  it('assigns and persists an identity to a legacy active session', async () => {
    const first: Harness = makeEngine();
    await first.engine.startSession(manualConfig);
    const legacy: RuntimeState = structuredClone(
      first.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    if (legacy.session !== null) delete legacy.session.sessionId;

    const migrated: Harness = makeEngine({ runtime: legacy });
    await migrated.engine.snapshotPersisted();

    expect(migrated.ports.saveRuntime.mock.calls.at(-1)?.[0]).toMatchObject({
      session: { sessionId: 'archive-id' },
    });
    expect(migrated.loggedEvents()).toContainEqual(
      expect.objectContaining({
        t: 'sessionIdentityAssigned',
        sessionId: 'archive-id',
        startedAt: legacy.session?.startedAt,
      }),
    );
  });

  it('preserves a migrated session identity during direct tab persistence', async () => {
    const first: Harness = makeEngine();
    await first.engine.startSession(manualConfig);
    const legacy: RuntimeState = structuredClone(
      first.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    if (legacy.session !== null) delete legacy.session.sessionId;
    const migrated: Harness = makeEngine({ runtime: legacy });

    await migrated.engine.markStopped(7, 'https://blocked.example/page', 'document-id');

    expect(migrated.ports.saveRuntime.mock.calls.at(-1)?.[0]).toMatchObject({
      session: { sessionId: 'archive-id' },
      commitCheckpoint: {
        events: [
          expect.objectContaining({
            t: 'sessionIdentityAssigned',
            sessionId: 'archive-id',
            startedAt: legacy.session?.startedAt,
          }),
        ],
      },
    });
  });

  it('does not resolve a mutation response before runtime and event persistence', async () => {
    const h: Harness = makeEngine();
    let releaseEvents: () => void = (): void => {
      throw new Error('event persistence did not start');
    };
    h.ports.appendEvents.mockImplementation(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releaseEvents = resolve;
        }),
    );

    const starting: Promise<unknown> = h.engine.startSession(manualConfig);
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalled());
    let resolved = false;
    starting.then((): void => {
      resolved = true;
    });
    await Promise.resolve();

    expect(resolved).toBe(false);
    expect(h.ports.saveRuntime).toHaveBeenCalledTimes(1);
    releaseEvents();
    await starting;
    expect(h.ports.saveRuntime).toHaveBeenCalledTimes(2);
  });

  it('retries runtime persistence after a failed save', async () => {
    const h: Harness = makeEngine();
    h.ports.saveRuntime.mockRejectedValueOnce(new Error('local storage unavailable'));
    const changed: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 30_000 },
    };

    await expect(h.engine.updateSettings(changed)).rejects.toThrow('local storage unavailable');
    await h.engine.snapshotPersisted();
    expect(h.ports.saveRuntime).toHaveBeenCalledTimes(3);
  });

  it('self-heals a stored bank above the loaded cap and persists the clamp', async () => {
    const h: Harness = makeEngine({
      bankMs: 120_000,
      settings: { pause: { ...DEFAULT_SETTINGS.pause, capMs: 60_000 } },
    });

    await expect(h.engine.snapshotPersisted()).resolves.toMatchObject({ bankMs: 60_000 });
    expect(h.ports.queueSync).toHaveBeenCalledWith(SYNC_BANK, { balanceMs: 60_000 });
    expect(h.ports.persistSyncJournal).toHaveBeenCalled();
  });

  it('clamps and journals a lower local cap before acknowledging', async () => {
    let durableBankMs: number = 120_000;
    let durableSettings: Settings = DEFAULT_SETTINGS;
    let pendingBankMs: number = durableBankMs;
    let pendingSettings: Settings = durableSettings;
    let releaseJournal: () => void = (): void => {
      throw new Error('sync journal persistence did not start');
    };
    let signalJournalStarted: () => void = (): void => {
      throw new Error('sync journal persistence did not start');
    };
    const journalStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalJournalStarted = resolve;
    });
    const journalBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseJournal = resolve;
    });
    const h: Harness = makeEngine({
      bankMs: durableBankMs,
      queueSync: (key: string, value: unknown): void => {
        if (key === SYNC_BANK) pendingBankMs = (value as { balanceMs: number }).balanceMs;
        if (key === SYNC_SETTINGS) pendingSettings = value as Settings;
      },
      persistSyncJournal: async (): Promise<void> => {
        signalJournalStarted();
        await journalBlocked;
        durableBankMs = pendingBankMs;
        durableSettings = pendingSettings;
      },
    });
    const lowered: Settings = {
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, capMs: 60_000 },
    };

    const updating: Promise<Ack> = h.engine.updateSettings(lowered);
    await journalStarted;
    const beforePersistence: 'pending' | 'resolved' = await Promise.race([
      updating.then((): 'resolved' => 'resolved'),
      Promise.resolve('pending' as const),
    ]);

    expect(beforePersistence).toBe('pending');
    expect(pendingBankMs).toBe(120_000);
    expect(durableBankMs).toBe(120_000);
    expect(durableSettings.pause.capMs).toBe(DEFAULT_SETTINGS.pause.capMs);

    releaseJournal();
    await expect(updating).resolves.toEqual({ ok: true });

    expect(h.engine.snapshot().bankMs).toBe(60_000);
    expect(durableBankMs).toBe(60_000);
    expect(durableSettings.pause.capMs).toBe(60_000);
    expect(h.ports.persistSyncJournal).toHaveBeenCalled();

    const restarted: Harness = makeEngine({
      bankMs: durableBankMs,
      settings: durableSettings,
    });
    expect(restarted.engine.snapshot().bankMs).toBe(60_000);
  });

  it('clamps and persists the bank when live-synced settings lower the cap', async () => {
    const h: Harness = makeEngine({ bankMs: 120_000 });
    const lowered: Settings = {
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, capMs: 60_000 },
    };

    await expect(h.engine.applySyncedSettings(lowered)).resolves.toEqual({ ok: true });

    expect(h.engine.snapshot().bankMs).toBe(60_000);
    expect(h.ports.queueSync).toHaveBeenCalledWith(SYNC_BANK, { balanceMs: 60_000 });
    expect(h.ports.queueSync).not.toHaveBeenCalledWith(SYNC_SETTINGS, expect.anything());
    expect(h.ports.persistSyncJournal).toHaveBeenCalled();
  });

  it('mirrors inbound policy without early mutation and commits it without publication', async () => {
    const savePolicy = vi.fn().mockResolvedValue(undefined);
    const h: Harness = makeEngine({ bankMs: 120_000, savePolicy });
    const incoming: Settings = {
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, capMs: 60_000 },
    };

    const mirror = vi.fn(async (): Promise<void> => {
      expect(h.engine.getSettings()).toEqual(DEFAULT_SETTINGS);
      expect(h.engine.snapshot().bankMs).toBe(120_000);
    });

    await expect(
      h.engine.transactSyncedPolicy({ settings: incoming }, false, mirror),
    ).resolves.toEqual({ ok: true });

    expect(mirror).toHaveBeenCalledWith({ settings: incoming, bank: { balanceMs: 60_000 } });
    expect(h.engine.getSettings()).toEqual(incoming);
    expect(h.engine.snapshot().bankMs).toBe(60_000);
    expect(savePolicy).not.toHaveBeenCalled();
    expect(h.ports.queueSync).not.toHaveBeenCalled();
  });

  it('serializes an inbound mirror and commit behind an admitted local policy write', async () => {
    let releaseLocalSave: () => void = (): void => undefined;
    const localSaveBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseLocalSave = resolve;
    });
    let localSaveStarted: () => void = (): void => undefined;
    const localSaveAdmission: Promise<void> = new Promise((resolve: () => void): void => {
      localSaveStarted = resolve;
    });
    const h: Harness = makeEngine({
      savePolicy: async (): Promise<void> => {
        localSaveStarted();
        await localSaveBlocked;
      },
    });
    const local: Settings = { ...DEFAULT_SETTINGS, retentionDays: 30 };
    const remote: Settings = { ...DEFAULT_SETTINGS, retentionDays: 14 };
    const trace: string[] = [];

    const localUpdate: Promise<Ack> = h.engine.updateSettings(local);
    await localSaveAdmission;
    const inbound: Promise<Ack> = h.engine.transactSyncedPolicy(
      { settings: remote },
      false,
      async (): Promise<void> => {
        trace.push('mirror');
      },
    );
    await Promise.resolve();
    expect(trace).toEqual([]);

    releaseLocalSave();
    await expect(localUpdate).resolves.toEqual({ ok: true });
    await expect(inbound).resolves.toEqual({ ok: true });

    expect(trace).toEqual(['mirror']);
    expect(h.engine.getSettings()).toEqual(remote);
  });

  it('holds a scheduled Hard start behind inbound mirror I/O across its clock boundary', async (): Promise<void> => {
    let releaseMirror: () => void = (): void => undefined;
    let signalMirrorStarted: () => void = (): void => undefined;
    const mirrorBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseMirror = resolve;
    });
    const mirrorStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalMirrorStarted = resolve;
    });
    const h: Harness = makeEngine({ settings: { schedule: [scheduledEntry] } });
    const incoming: Settings = {
      ...h.engine.getSettings(),
      gate: { ...h.engine.getSettings().gate, delayMs: 1_000 },
    };

    const inbound: Promise<Ack> = h.engine.transactSyncedPolicy(
      { settings: incoming },
      false,
      async (): Promise<void> => {
        signalMirrorStarted();
        await mirrorBlocked;
      },
    );
    await mirrorStarted;
    h.setNow(T0 + 2 * 60_000);

    expect(h.engine.snapshot().phase).toBe('idle');
    expect(h.engine.getSettings().gate.delayMs).not.toBe(1_000);

    releaseMirror();
    await expect(inbound).resolves.toEqual({ ok: true });
    expect(h.engine.getSettings()).toEqual(incoming);
    expect(h.engine.snapshot().phase).toBe('focus');
  });

  it('catches up a scheduled Hard start before previewing an already-due inbound weakening', async (): Promise<void> => {
    const h: Harness = makeEngine({ settings: { schedule: [scheduledEntry] } });
    const incoming: Settings = {
      ...h.engine.getSettings(),
      gate: { ...h.engine.getSettings().gate, delayMs: 1_000 },
    };
    const mirror = vi.fn().mockResolvedValue(undefined);
    h.setNow(T0 + 2 * 60_000);

    await expect(
      h.engine.transactSyncedPolicy({ settings: incoming }, false, mirror),
    ).resolves.toEqual({
      ok: false,
      error: 'a hard session is running: shortening the deliberation delay weakens the gate',
    });

    expect(mirror).not.toHaveBeenCalled();
    expect(h.engine.getSettings().gate.delayMs).not.toBe(1_000);
    expect(h.engine.snapshot().phase).toBe('focus');
  });

  it('persists the derived list cache before mirroring inbound list authority', async () => {
    const cacheFailure: Error = new Error('matcher cache unavailable');
    const h: Harness = makeEngine({
      saveMatcherCache: vi.fn().mockRejectedValue(cacheFailure),
    });
    const prior: ListsConfig = h.engine.getLists();
    const incoming: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'accepted.example' }],
    };
    const mirror = vi.fn().mockResolvedValue(undefined);

    await expect(h.engine.transactSyncedPolicy({ lists: incoming }, false, mirror)).rejects.toThrow(
      'matcher cache unavailable',
    );

    expect(mirror).not.toHaveBeenCalled();
    expect(h.engine.getLists()).toEqual(prior);
  });

  it('reapplies blocking only when synced settings change the theme', async () => {
    const h: Harness = makeEngine();
    h.ports.applyBlocking.mockClear();

    await expect(
      h.engine.applySyncedSettings({ ...DEFAULT_SETTINGS, theme: 'dark' }),
    ).resolves.toEqual({ ok: true });
    expect(h.ports.applyBlocking).toHaveBeenCalledTimes(1);

    h.ports.applyBlocking.mockClear();
    await expect(
      h.engine.applySyncedSettings({
        ...DEFAULT_SETTINGS,
        theme: 'dark',
        retentionDays: 30,
      }),
    ).resolves.toEqual({ ok: true });
    expect(h.ports.applyBlocking).not.toHaveBeenCalled();
  });

  it('does not rewrite the bank when a settings update raises the cap', async () => {
    const h: Harness = makeEngine({
      bankMs: 60_000,
      settings: {
        pause: { ...DEFAULT_SETTINGS.pause, capMs: 60_000 },
      },
    });
    const raised: Settings = {
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, capMs: 120_000 },
    };

    await h.engine.updateSettings(raised);

    expect(h.engine.snapshot().bankMs).toBe(60_000);
    expect(h.ports.queueSync).not.toHaveBeenCalledWith(SYNC_BANK, expect.anything());
  });

  it('rejects a lower-cap acknowledgement until the clamped bank journal persists', async () => {
    const h: Harness = makeEngine({ bankMs: 120_000 });
    h.ports.persistSyncJournal.mockRejectedValueOnce(new Error('sync journal unavailable'));
    const lowered: Settings = {
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, capMs: 60_000 },
    };

    await expect(h.engine.applySyncedSettings(lowered)).rejects.toThrow('sync journal unavailable');

    expect(h.ports.saveRuntime.mock.calls[0]?.[0]).toMatchObject({
      commitCheckpoint: { bank: { balanceMs: 60_000 }, syncBank: true },
    });
    expect(h.ports.queueSync).toHaveBeenCalledWith(SYNC_BANK, { balanceMs: 60_000 });

    await expect(h.engine.snapshotPersisted()).resolves.toMatchObject({ bankMs: 60_000 });
    expect(h.ports.persistSyncJournal).toHaveBeenCalledTimes(3);
  });

  it('leaves settings, bank, and queues unchanged when a hard-session edit is rejected', async () => {
    const h: Harness = makeEngine({ bankMs: 120_000 });
    await h.engine.startSession({ ...manualConfig, strictness: 'hard' });
    h.ports.queueSync.mockClear();
    h.ports.persistSyncJournal.mockClear();
    const rejected: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 1_000 },
      pause: { ...DEFAULT_SETTINGS.pause, capMs: 60_000 },
    };

    await expect(h.engine.updateSettings(rejected)).resolves.toMatchObject({ ok: false });

    expect(h.engine.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(h.engine.snapshot().bankMs).toBe(120_000);
    expect(h.ports.queueSync).not.toHaveBeenCalledWith(SYNC_SETTINGS, expect.anything());
    expect(h.ports.queueSync).not.toHaveBeenCalledWith(SYNC_BANK, expect.anything());
  });

  it('rejects oversized local settings before mutating settings or clamping the bank', async () => {
    const h: Harness = makeEngine({ bankMs: 120_000 });
    const oversized: Settings = {
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, capMs: 60_000 },
      schedule: [
        {
          ...scheduledEntry,
          intention: 'x'.repeat(8_192),
        },
      ],
    };

    await expect(h.engine.updateSettings(oversized)).resolves.toEqual({
      ok: false,
      error:
        'Settings exceed the 8 KB Chrome Sync limit. Remove schedule entries or shorten intentions, then try again.',
    });

    expect(h.engine.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(h.engine.snapshot().bankMs).toBe(120_000);
    expect(h.ports.queueSync).not.toHaveBeenCalled();
  });

  it('accepts local settings at the exact Chrome Sync item boundary', async () => {
    const h: Harness = makeEngine();
    const base: Settings = {
      ...DEFAULT_SETTINGS,
      schedule: [{ ...scheduledEntry, intention: '' }],
    };
    const fillerBytes: number = 8_192 - syncItemBytes(SYNC_SETTINGS, base);
    const boundary: Settings = {
      ...base,
      schedule: [{ ...scheduledEntry, intention: 'x'.repeat(fillerBytes) }],
    };

    expect(syncItemBytes(SYNC_SETTINGS, boundary)).toBe(8_192);
    await expect(h.engine.updateSettings(boundary)).resolves.toEqual({ ok: true });
    expect(h.engine.getSettings()).toEqual(boundary);
    expect(h.ports.queueSync).toHaveBeenCalledWith(SYNC_SETTINGS, boundary);
  });

  it('rejects oversized local lists without replacing the compiled matcher', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    const before = h.engine.verdictFor('https://facebook.com/feed');
    h.ports.queueSync.mockClear();
    const oversized: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: oversizedHostRules('custom'),
    };

    await expect(h.engine.updateLists(oversized)).resolves.toEqual({
      ok: false,
      error:
        'Lists exceed the 8 KB Chrome Sync limit. Remove custom or whitelist rules, then try again.',
    });

    expect(h.engine.getLists()).toEqual({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'facebook.com' }],
    });
    expect(h.engine.verdictFor('https://facebook.com/feed')).toEqual(before);
    expect(h.ports.queueSync).not.toHaveBeenCalledWith(SYNC_LISTS, expect.anything());
    expect(h.ports.saveMatcherCache).not.toHaveBeenCalled();
  });

  it('rejects Chromium-escaped list overflow before cache or state mutation', async () => {
    const h: Harness = makeEngine();
    const before: ListsConfig = h.engine.getLists();
    const escapedBase: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'regex', pattern: '<\u2028\u2029'.repeat(500) }],
    };
    clearMutationPorts(h.ports);

    await expect(h.engine.updateLists(escapedBase)).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );

    expect(h.ports.saveMatcherCache).not.toHaveBeenCalled();
    expect(h.ports.queueSync).not.toHaveBeenCalled();
    expect(h.ports.removeSync).not.toHaveBeenCalled();
    expect(h.engine.getLists()).toEqual(before);
  });

  it('queues a complete sharded encoding and durably replays it after restart', async () => {
    let durableJournal: SyncJournal = { sets: {}, removes: [] };
    const writer: SyncWriter = new SyncWriter(
      60_000,
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue(undefined),
      {
        initial: durableJournal,
        persist: async (journal: SyncJournal): Promise<void> => {
          durableJournal = structuredClone(journal);
        },
      },
    );
    const h: Harness = makeEngine({
      hasPendingSync: (key: string): boolean => writer.hasPending(key),
      queueSync: (key: string, value: unknown): void => writer.queue(key, value),
      persistSyncJournal: (): Promise<void> => writer.whenJournalDurable(),
    });
    const lists: ListsConfig = splittableLists([{ kind: 'host', pattern: 'sharded.example' }]);

    await expect(h.engine.updateLists(lists)).resolves.toEqual({ ok: true });

    const expected = await encodeListsForSync(lists);
    expect(durableJournal).toEqual({ sets: expected.sets, removes: [] });
    const replayWrites: Array<Record<string, unknown>> = [];
    const restarted: SyncWriter = new SyncWriter(
      60_000,
      async (items: Record<string, unknown>): Promise<void> => {
        replayWrites.push(structuredClone(items));
      },
      vi.fn().mockResolvedValue(undefined),
      { initial: durableJournal, persist: vi.fn().mockResolvedValue(undefined) },
    );
    await restarted.flushNow();
    expect(replayWrites).toEqual([expected.sets]);
  });

  it('removes stale category shards when lists return to the unsplit representation', async () => {
    const h: Harness = makeEngine();
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'unsplit.example' }],
    };

    await expect(h.engine.updateLists(lists)).resolves.toEqual({ ok: true });

    for (const key of LIST_SYNC_SHARD_KEYS) {
      expect(h.ports.removeSync).toHaveBeenCalledWith(key);
    }
  });

  it('keeps the hard-session guard authoritative before queuing sharded lists', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession({ ...manualConfig, strictness: 'hard' });
    clearMutationPorts(h.ports);

    await expect(h.engine.updateLists(splittableLists())).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );

    expect(h.ports.queueSync).not.toHaveBeenCalledWith(SYNC_LISTS, expect.anything());
    for (const key of LIST_SYNC_SHARD_KEYS) {
      expect(h.ports.queueSync).not.toHaveBeenCalledWith(key, expect.anything());
    }
    expect(h.ports.removeSync).not.toHaveBeenCalled();
  });

  it('rejects oversized live lists before catch-up or matcher-cache persistence', async () => {
    const h: Harness = makeEngine();
    clearMutationPorts(h.ports);
    const oversized: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: oversizedHostRules('live'),
    };

    await expect(h.engine.applySyncedLists(oversized)).resolves.toEqual({
      ok: false,
      error:
        'Lists exceed the 8 KB Chrome Sync limit. Remove custom or whitelist rules, then try again.',
    });

    expect(h.ports.now).not.toHaveBeenCalled();
    expect(h.ports.saveMatcherCache).not.toHaveBeenCalled();
    expect(h.engine.getLists()).toEqual({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'facebook.com' }],
    });
  });

  it('persists both matcher modes without changing the active session policy', async () => {
    const order: string[] = [];
    const h: Harness = makeEngine({
      saveMatcherCache: async (): Promise<void> => {
        order.push('cache');
      },
      queueSync: (key: string): void => {
        if (key === SYNC_LISTS) order.push('sync');
      },
    });
    await h.engine.startSession(manualConfig);
    clearMutationPorts(h.ports);
    const updated: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'replacement.example' }],
    };

    await expect(h.engine.updateLists(updated)).resolves.toEqual({ ok: true });

    expect(order).toEqual(['cache', 'sync']);
    expect(h.ports.saveMatcherCache).toHaveBeenCalledWith(
      buildMatcherCache(updated, ALL_CATEGORIES).stored,
      updated,
    );
    expect(h.engine.getLists()).toEqual(updated);
    expect(h.engine.verdictFor('https://replacement.example/page').blocked).toBe(false);
    expect(h.engine.verdictFor('https://facebook.com/feed').blocked).toBe(true);
  });

  it('persists accepted live lists without echoing them or changing the active policy', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    clearMutationPorts(h.ports);
    const updated: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'live.example' }],
    };

    await expect(h.engine.applySyncedLists(updated)).resolves.toEqual({ ok: true });

    expect(h.ports.saveMatcherCache).toHaveBeenCalledWith(
      buildMatcherCache(updated, ALL_CATEGORIES).stored,
      updated,
    );
    expect(h.ports.queueSync).not.toHaveBeenCalledWith(SYNC_LISTS, expect.anything());
    expect(h.engine.verdictFor('https://live.example/page').blocked).toBe(false);
    expect(h.engine.verdictFor('https://facebook.com/feed').blocked).toBe(true);
  });

  it('keeps active lists, matchers, and Sync queues when cache persistence fails', async () => {
    const h: Harness = makeEngine({
      saveMatcherCache: (): Promise<void> => Promise.reject(new Error('local cache unavailable')),
    });
    await h.engine.startSession(manualConfig);
    const beforeLists: ListsConfig = h.engine.getLists();
    const beforeVerdict: Verdict = h.engine.verdictFor('https://facebook.com/feed');
    clearMutationPorts(h.ports);
    const updated: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'replacement.example' }],
    };

    await expect(h.engine.updateLists(updated)).rejects.toThrow('local cache unavailable');

    expect(h.engine.getLists()).toEqual(beforeLists);
    expect(h.engine.verdictFor('https://facebook.com/feed')).toEqual(beforeVerdict);
    expect(h.engine.verdictFor('https://replacement.example/page').blocked).toBe(false);
    expect(h.ports.queueSync).not.toHaveBeenCalledWith(SYNC_LISTS, expect.anything());
  });

  it('rejects a queued hard-session start after list persistence makes its baseline stale', async () => {
    let releaseCache: () => void = (): void => {};
    let signalCacheStarted: () => void = (): void => {};
    const cacheBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseCache = resolve;
    });
    const cacheStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalCacheStarted = resolve;
    });
    const h: Harness = makeEngine({
      saveMatcherCache: (): Promise<void> => {
        signalCacheStarted();
        return cacheBlocked;
      },
    });
    const weaker: ListsConfig = { ...DEFAULT_LISTS, custom: [] };

    const updating: Promise<Ack> = h.engine.updateLists(weaker);
    await cacheStarted;
    let sessionStarted: boolean = false;
    const starting: Promise<Ack> = h.engine
      .startSession({ ...manualConfig, strictness: 'hard' })
      .then((ack: Ack): Ack => {
        sessionStarted = true;
        return ack;
      });
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 0);
    });

    expect(sessionStarted).toBe(false);
    releaseCache();
    await expect(updating).resolves.toEqual({ ok: true });
    await expect(starting).resolves.toEqual({
      ok: false,
      error: 'Your default blocking lists changed. Review this session and start again.',
    });
    expect(h.engine.verdictFor('https://facebook.com/feed').blocked).toBe(false);
  });

  it('defers a scheduled hard-session start until matcher-cache persistence finishes', async () => {
    let releaseCache: () => void = (): void => {};
    let signalCacheStarted: () => void = (): void => {};
    const cacheBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseCache = resolve;
    });
    const cacheStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalCacheStarted = resolve;
    });
    const h: Harness = makeEngine({
      settings: { schedule: [scheduledEntry] },
      saveMatcherCache: (): Promise<void> => {
        signalCacheStarted();
        return cacheBlocked;
      },
    });
    const weaker: ListsConfig = { ...DEFAULT_LISTS, custom: [] };

    const updating: Promise<Ack> = h.engine.updateLists(weaker);
    await cacheStarted;
    h.setNow(T0 + 2 * 60_000);

    expect(h.engine.snapshot().phase).toBe('idle');
    releaseCache();
    await expect(updating).resolves.toEqual({ ok: true });
    expect(h.ports.playSound).toHaveBeenCalledWith('scheduleStart');
    expect(h.engine.snapshot().phase).toBe('focus');
    expect(h.engine.verdictFor('https://facebook.com/feed').blocked).toBe(false);
  });

  it('quiesces manual and scheduled session starts for the complete all-data clear barrier', async (): Promise<void> => {
    let releaseRemote: () => void = (): void => undefined;
    let signalRemoteStarted: () => void = (): void => undefined;
    const remoteBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseRemote = resolve;
    });
    const remoteStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalRemoteStarted = resolve;
    });
    const h: Harness = makeEngine({ settings: { schedule: [scheduledEntry] } });

    const clearing: Promise<void> = h.engine.runWithDataClearBarrier(async (): Promise<void> => {
      signalRemoteStarted();
      await remoteBlocked;
    });
    await remoteStarted;
    h.setNow(T0 + 2 * 60_000);

    await expect(h.engine.tick()).rejects.toThrow('data clear');
    await expect(h.engine.startSession(manualConfig)).rejects.toThrow('data clear');
    await expect(
      h.engine.recordAttempt('https://facebook.com/feed', 1, 'navigation'),
    ).rejects.toThrow('data clear');
    await expect(
      h.engine.markStopped(1, 'https://facebook.com/feed', 'document-id'),
    ).rejects.toThrow('data clear');
    await expect(h.engine.updateLists(DEFAULT_LISTS)).rejects.toThrow('data clear');
    expect(h.engine.snapshot().phase).toBe('idle');
    expect(h.ports.saveRuntime).not.toHaveBeenCalled();
    expect(h.ports.appendEvents).not.toHaveBeenCalled();
    expect(h.ports.saveMatcherCache).not.toHaveBeenCalled();

    releaseRemote();
    await clearing;

    await expect(h.engine.tick()).resolves.toBeUndefined();
    await expect(h.engine.snapshotPersisted()).resolves.toMatchObject({ phase: 'idle' });
    await expect(h.engine.updateLists(DEFAULT_LISTS)).resolves.toEqual({ ok: true });
    expect(h.engine.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(h.engine.getLists()).toEqual(DEFAULT_LISTS);
    expect(h.engine.snapshot()).toMatchObject({ phase: 'idle', bankMs: 0 });
    expect(h.engine.statsOverlay().pendingEvents).toEqual([]);
    expect(h.ports.rehydrateAfterDataClear).toHaveBeenCalledOnce();
  });

  it('persists and replays deferred navigation bookkeeping after worker restart', async (): Promise<void> => {
    const url: string = 'https://facebook.com/feed';
    const first: Harness = makeEngine();
    await first.engine.startSession(manualConfig);
    await first.engine.retainDataClearQuiescence();

    await expect(
      first.engine.blockStateDuringTransition(
        url,
        7,
        true,
        'navigation',
        'attempt',
        'document-one',
      ),
    ).resolves.toMatchObject({ verdict: { blocked: true }, snapshot: { phase: 'focus' } });
    const stored: RuntimeState = structuredClone(lastSavedRuntime(first));
    expect(Object.values(stored.deferredBlockClaims)).toContainEqual(
      expect.objectContaining({
        attemptAt: T0,
        documentId: 'document-one',
        sessionId: stored.session?.sessionId,
        stage: 'attempt',
      }),
    );

    const restarted: Harness = makeEngine({
      runtime: migrateRuntimeRules(mergeRuntime(stored, T0 + 31_000), ENGINE_LISTS),
    });
    restarted.setNow(T0 + 31_000);
    await restarted.engine.tick();

    expect(restarted.engine.snapshot().attemptsToday).toBe(1);
    expect(restarted.engine.tabFacts(7, url, 'document-one').wasStopped).toBe(true);
    expect(restarted.loggedEvents()).toContainEqual(
      expect.objectContaining({
        t: 'attempt',
        at: T0,
        sessionId: stored.session?.sessionId,
      }),
    );
    expect(lastSavedRuntime(restarted).deferredBlockClaims).toEqual({});
  });

  it('replays only the unfinished stopped stage after the debounce window', async (): Promise<void> => {
    const url: string = 'https://facebook.com/feed';
    const first: Harness = makeEngine();
    await first.engine.startSession(manualConfig);
    await first.engine.recordAttempt(url, 7, 'navigation');
    await first.engine.retainDataClearQuiescence();
    await first.engine.blockStateDuringTransition(
      url,
      7,
      true,
      'navigation',
      'stopped',
      'document-two',
    );
    const stored: RuntimeState = structuredClone(lastSavedRuntime(first));

    const restarted: Harness = makeEngine({
      runtime: migrateRuntimeRules(mergeRuntime(stored, T0 + 31_000), ENGINE_LISTS),
    });
    restarted.setNow(T0 + 31_000);
    await restarted.engine.tick();

    expect(restarted.engine.snapshot().attemptsToday).toBe(1);
    expect(restarted.engine.tabFacts(7, url, 'document-two').wasStopped).toBe(true);
    expect(
      restarted.loggedEvents().filter((event: EventRecord): boolean => event.t === 'attempt'),
    ).toEqual([]);
  });

  it('does not persist an unfinished stopped stage without a document identity', async (): Promise<void> => {
    const first: Harness = makeEngine();
    await first.engine.startSession(manualConfig);
    await first.engine.retainDataClearQuiescence();
    first.ports.saveRuntime.mockClear();

    await expect(
      first.engine.blockStateDuringTransition(
        'https://facebook.com/feed',
        7,
        true,
        'navigation',
        'stopped',
        '',
      ),
    ).resolves.toMatchObject({ verdict: { blocked: true } });

    expect(first.ports.saveRuntime).not.toHaveBeenCalled();
  });

  it('retries a failed deferred attempt replay without double counting it', async (): Promise<void> => {
    const url: string = 'https://facebook.com/feed';
    const first: Harness = makeEngine();
    await first.engine.startSession(manualConfig);
    await first.engine.retainDataClearQuiescence();
    await first.engine.blockStateDuringTransition(
      url,
      7,
      true,
      'navigation',
      'attempt',
      'document-three',
    );
    const stored: RuntimeState = structuredClone(lastSavedRuntime(first));
    const restarted: Harness = makeEngine({
      runtime: migrateRuntimeRules(mergeRuntime(stored, T0 + 1_000), ENGINE_LISTS),
    });
    const replayError: Error = new Error('event storage unavailable');
    restarted.ports.appendEvents.mockRejectedValueOnce(replayError);
    restarted.setNow(T0 + 1_000);

    await restarted.engine.tick();
    await restarted.engine.tick();

    expect(restarted.ports.reportError).toHaveBeenCalledWith(replayError);
    expect(restarted.engine.snapshot().attemptsToday).toBe(1);
    expect(restarted.engine.tabFacts(7, url, 'document-three').wasStopped).toBe(true);
    expect(lastSavedRuntime(restarted).deferredBlockClaims).toEqual({});
  });

  it('keeps an old deferred attempt attributed to its originating session', async (): Promise<void> => {
    const url: string = 'https://facebook.com/feed';
    const first: Harness = makeEngine();
    await first.engine.startSession(manualConfig);
    await first.engine.retainDataClearQuiescence();
    await first.engine.blockStateDuringTransition(
      url,
      7,
      true,
      'navigation',
      'attempt',
      'old-document',
    );
    const stored: RuntimeState = structuredClone(lastSavedRuntime(first));
    if (stored.session === null) throw new Error('expected an active session');
    const originatingSessionId: string | undefined = Object.values(stored.deferredBlockClaims)[0]
      ?.sessionId;
    stored.session = { ...stored.session, sessionId: 'later-session' };

    const restarted: Harness = makeEngine({
      runtime: migrateRuntimeRules(mergeRuntime(stored, T0 + 1_000), ENGINE_LISTS),
    });
    restarted.setNow(T0 + 1_000);
    await restarted.engine.tick();

    expect(restarted.engine.snapshot().attemptsToday).toBe(1);
    expect(restarted.engine.tabFacts(7, url, 'old-document').wasStopped).toBe(true);
    expect(restarted.loggedEvents()).toContainEqual(
      expect.objectContaining({
        t: 'attempt',
        sessionId: originatingSessionId,
      }),
    );
    expect(restarted.loggedEvents()).not.toContainEqual(
      expect.objectContaining({ t: 'attempt', sessionId: 'later-session' }),
    );
    expect(lastSavedRuntime(restarted).deferredBlockClaims).toEqual({});
  });

  it('clears local in-memory aggregates after durable local-history deletion', async (): Promise<void> => {
    const runtime: RuntimeState = {
      ...emptyRuntime(T0),
      todayAgg: { ...emptyDaily('2026-08-29'), focusMs: 60_000 },
    };
    const h: Harness = makeEngine({ runtime });
    const clearStorage = vi.fn().mockResolvedValue(true);

    await h.engine.runWithLocalHistoryClear(clearStorage, (): Promise<void> => Promise.resolve());

    expect(clearStorage).toHaveBeenCalledOnce();
    expect(h.engine.statsOverlay()).toMatchObject({
      deviceId: 'dev-test',
      todayAgg: { focusMs: 0 },
      pendingEvents: [],
    });
    expect(h.ports.saveRuntime).toHaveBeenLastCalledWith(
      expect.objectContaining({ todayAgg: null, commitCheckpoint: null }),
    );
  });

  it('keeps history sanitized and the transaction pending when runtime persistence fails', async (): Promise<void> => {
    const runtime: RuntimeState = {
      ...emptyRuntime(T0),
      session: startSession(manualConfig, T0, 'active-session'),
      todayAgg: { ...emptyDaily('2026-08-29'), focusMs: 60_000 },
    };
    const streak: StreakState = {
      current: 3,
      freezeTokens: 1,
      lastCountedDate: '2026-08-28',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [27, 28],
      activeMonth: '2026-08',
    };
    const saveAggregate = vi.fn().mockResolvedValue(undefined);
    const h: Harness = makeEngine({ bankMs: 42_000, runtime, saveAggregate, streak });
    const finishStorage = vi.fn().mockResolvedValue(undefined);
    let historyRemoved: boolean = false;
    h.ports.saveRuntime.mockImplementation(async (saved: RuntimeState): Promise<void> => {
      if (historyRemoved && saved.todayAgg === null) {
        throw new Error('sanitized runtime unavailable');
      }
    });

    await expect(
      h.engine.runWithLocalHistoryClear(async (): Promise<boolean> => {
        historyRemoved = true;
        return true;
      }, finishStorage),
    ).rejects.toThrow('sanitized runtime unavailable');

    expect(finishStorage).not.toHaveBeenCalled();
    expect(h.engine.snapshot()).toMatchObject({ phase: 'focus', bankMs: 42_000 });
    expect(h.engine.statsOverlay()).toMatchObject({
      todayAgg: { focusMs: 0 },
      streak,
      pendingEvents: [],
    });

    h.ports.saveRuntime.mockResolvedValue(undefined);
    saveAggregate.mockClear();
    await h.engine.snapshotPersisted();

    expect(lastSavedRuntime(h)).toMatchObject({ todayAgg: null, commitCheckpoint: null });
    expect(saveAggregate).not.toHaveBeenCalled();

    await h.engine.runWithLocalHistoryClear(
      (): Promise<boolean> => Promise.resolve(true),
      finishStorage,
    );
    expect(finishStorage).toHaveBeenCalledOnce();
  });

  it('ends an active session inside the all-data barrier and rehydrates a usable device', async (): Promise<void> => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    h.ports.saveRuntime.mockClear();
    const observedActive: boolean[] = [];

    await h.engine.runWithDataClearBarrier(async (): Promise<void> => {
      observedActive.push(h.engine.hasActiveSession());
    });

    expect(observedActive).toEqual([false]);
    expect(h.ports.applyBlocking).toHaveBeenCalled();
    expect(h.ports.rehydrateAfterDataClear).toHaveBeenCalledOnce();
    expect(h.engine.statsOverlay().deviceId).toBe('dev-rehydrated');
    await expect(h.engine.snapshotPersisted()).resolves.toMatchObject({ phase: 'idle' });
  });

  it('keeps mute ownership visible until the all-data cleanup sweep restores audio', async (): Promise<void> => {
    const url: string = 'https://facebook.com/feed';
    let restoredMutedTab: boolean = false;
    let h: Harness;
    h = makeEngine({
      applyBlocking: async (): Promise<void> => {
        const facts: ReturnType<Engine['tabFacts']> = h.engine.tabFacts(7, url);
        restoredMutedTab = facts.wasMutedByUs && !facts.priorMuted;
      },
    });
    await h.engine.claimMute(7, url, false);

    await h.engine.runWithDataClearBarrier((): Promise<void> => Promise.resolve());

    expect(restoredMutedTab).toBe(true);
    expect(h.engine.tabFacts(7, url).wasMutedByUs).toBe(false);
  });

  it('keeps stopped-document ownership visible until the all-data cleanup sweep reloads it', async (): Promise<void> => {
    const url: string = 'https://facebook.com/feed';
    const documentId: string = 'stopped-document';
    let restoredStoppedTab: boolean = false;
    let h: Harness;
    h = makeEngine({
      applyBlocking: async (): Promise<void> => {
        restoredStoppedTab = h.engine.tabFacts(7, url, documentId).wasStopped;
      },
    });
    await h.engine.markStopped(7, url, documentId);

    await h.engine.runWithDataClearBarrier((): Promise<void> => Promise.resolve());

    expect(restoredStoppedTab).toBe(true);
    expect(h.engine.tabFacts(7, url, documentId).wasStopped).toBe(false);
  });

  it('retains quiescence for a boot-restored all-data retry and reopens after success', async (): Promise<void> => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    await h.engine.retainDataClearQuiescence();

    await expect(h.engine.startSession(manualConfig)).rejects.toThrow('data clear');
    await h.engine.runWithDataClearBarrier((): Promise<void> => Promise.resolve());

    expect(h.engine.hasActiveSession()).toBe(false);
    expect(h.ports.rehydrateAfterDataClear).toHaveBeenCalledOnce();
    await expect(h.engine.snapshotPersisted()).resolves.toMatchObject({ phase: 'idle' });
  });

  it('lets an admitted mutation finish its applyBlocking persistence before closing the barrier', async (): Promise<void> => {
    let releaseBlocking: () => void = (): void => undefined;
    let signalBlockingStarted: () => void = (): void => undefined;
    let attemptRecordedDuringDrain: boolean = false;
    let h: Harness;
    const blockingPaused: Promise<void> = new Promise((resolve: () => void): void => {
      releaseBlocking = resolve;
    });
    const blockingStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalBlockingStarted = resolve;
    });
    h = makeEngine({
      applyBlocking: async (lease: BlockingSweepLease): Promise<void> => {
        signalBlockingStarted();
        await blockingPaused;
        await h.engine.recordAttempt('https://facebook.com/feed', 7, 'existing', lease);
        attemptRecordedDuringDrain = h.engine.snapshot().attemptsToday === 1;
      },
    });

    const starting: Promise<Ack> = h.engine.startSession(manualConfig);
    await blockingStarted;
    const clearing: Promise<void> = h.engine.runWithDataClearBarrier(
      (): Promise<void> => Promise.resolve(),
    );
    releaseBlocking();

    await expect(starting).resolves.toEqual({ ok: true });
    await clearing;
    expect(attemptRecordedDuringDrain).toBe(true);
  });

  it('keeps an admitted blocking sweep mutation leased while the barrier drains', async (): Promise<void> => {
    let releaseSweep: () => void = (): void => undefined;
    let signalSweepStarted: () => void = (): void => undefined;
    const sweepBlocked: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseSweep = resolve;
    });
    const sweepStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalSweepStarted = resolve;
    });
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    h.ports.applyBlocking.mockImplementation(async (lease: BlockingSweepLease): Promise<void> => {
      signalSweepStarted();
      await sweepBlocked;
      await h.engine.recordAttempt('https://facebook.com/feed', 7, 'existing', lease);
    });

    const sweeping: Promise<void> = h.engine.applyBlockingNow();
    await sweepStarted;
    let barrierEntered: boolean = false;
    const transitioning: Promise<void> = h.engine.runWithAggregateStorageBarrier(
      async (): Promise<void> => {
        barrierEntered = true;
      },
    );
    await Promise.resolve();
    expect(barrierEntered).toBe(false);
    releaseSweep();

    await expect(sweeping).resolves.toBeUndefined();
    await transitioning;
    expect(barrierEntered).toBe(true);
    expect(h.engine.snapshot().attemptsToday).toBe(1);
  });

  it('rejects a forged blocking sweep lease after its admitted sweep finishes', async (): Promise<void> => {
    let capturedLease: BlockingSweepLease | null = null;
    const h: Harness = makeEngine({
      applyBlocking: async (lease: BlockingSweepLease): Promise<void> => {
        capturedLease = lease;
      },
    });
    await h.engine.startSession(manualConfig);
    if (capturedLease === null) throw new Error('expected an admitted blocking sweep lease');
    await h.engine.retainDataClearQuiescence();

    await expect(
      h.engine.recordAttempt('https://facebook.com/feed', 7, 'existing', capturedLease),
    ).rejects.toThrow('storage transition');
  });

  it('releases a tracked runtime mutation lease when its operation rejects', async (): Promise<void> => {
    const h: Harness = makeEngine();
    const error: Error = new Error('tab operation failed');

    await expect(
      h.engine.runWithRuntimeMutationLease(async (): Promise<void> => {
        throw error;
      }),
    ).rejects.toBe(error);

    await expect(
      h.engine.runWithAggregateStorageBarrier((): Promise<void> => Promise.resolve()),
    ).resolves.toBeUndefined();
  });

  it('lets a draining tab removal tombstone win over an admitted stale tab write', async (): Promise<void> => {
    const h: Harness = makeEngine();
    let releaseStaleWrite: () => void = (): void => undefined;
    let signalStaleWrite: () => void = (): void => undefined;
    const staleWriteBlocked: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseStaleWrite = resolve;
    });
    const staleWriteStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalStaleWrite = resolve;
    });
    h.ports.saveRuntime.mockImplementationOnce(async (): Promise<void> => {
      signalStaleWrite();
      await staleWriteBlocked;
    });
    const claiming: Promise<boolean> = h.engine.claimMute(7, 'https://facebook.com/feed', false);
    await staleWriteStarted;
    const transitioning: Promise<void> = h.engine.runWithAggregateStorageBarrier(
      (): Promise<void> => Promise.resolve(),
    );

    const dropping: Promise<void> = h.engine.dropTab(7);
    releaseStaleWrite();
    await Promise.all([claiming, dropping, transitioning]);

    expect(h.engine.tabFacts(7, 'https://facebook.com/feed')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
    expect(lastSavedRuntime(h).tabStates).toEqual({});
  });

  it('queues a tab removal while an aggregate barrier is quiesced', async (): Promise<void> => {
    const h: Harness = makeEngine();
    await h.engine.claimMute(7, 'https://facebook.com/feed', false);
    let releaseBarrier: () => void = (): void => undefined;
    let signalBarrierEntered: () => void = (): void => undefined;
    const barrierBlocked: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseBarrier = resolve;
    });
    const barrierEntered: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalBarrierEntered = resolve;
    });
    const transitioning: Promise<void> = h.engine.runWithAggregateStorageBarrier(
      async (): Promise<void> => {
        signalBarrierEntered();
        await barrierBlocked;
      },
    );
    await barrierEntered;

    await expect(h.engine.dropTab(7)).resolves.toBeUndefined();
    expect(h.engine.tabFacts(7, 'https://facebook.com/feed').wasMutedByUs).toBe(false);
    releaseBarrier();
    await transitioning;

    expect(lastSavedRuntime(h).tabStates).toEqual({});
  });

  it('applies a durable tab removal tombstone before deferred claims after restart', async (): Promise<void> => {
    const first: Harness = makeEngine();
    await first.engine.startSession(manualConfig);
    const runtime: RuntimeState = structuredClone(lastSavedRuntime(first));
    const sessionId: string | undefined = runtime.session?.sessionId;
    if (sessionId === undefined) throw new Error('expected an active session identity');
    runtime.tabStates[7] = {
      muteUrl: 'https://facebook.com/feed',
      priorMuted: false,
      stoppedDocumentId: null,
    };
    runtime.deferredBlockClaims.claim = {
      attemptAt: T0,
      documentId: 'stale-document',
      kind: 'navigation',
      sessionId,
      stage: 'stopped',
      tabId: 7,
      url: 'https://facebook.com/feed',
    };
    Reflect.set(runtime, 'removedTabTombstones', { 7: true });

    const restarted: Harness = makeEngine({
      runtime: migrateRuntimeRules(mergeRuntime(runtime, T0 + 1_000), ENGINE_LISTS),
    });
    restarted.setNow(T0 + 1_000);
    await restarted.engine.tick();

    expect(restarted.engine.tabFacts(7, 'https://facebook.com/feed', 'stale-document')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
    expect(lastSavedRuntime(restarted).deferredBlockClaims).toEqual({});
    expect(Reflect.get(lastSavedRuntime(restarted), 'removedTabTombstones')).toEqual({});
  });

  it('keeps mutation admission quiesced after a durable all-data clear journal fails', async (): Promise<void> => {
    const h: Harness = makeEngine();
    await expect(
      h.engine.runWithDataClearBarrier(
        (): Promise<void> => Promise.reject(new Error('remote deletion unavailable')),
        (): boolean => true,
      ),
    ).rejects.toThrow('remote deletion unavailable');
    await expect(h.engine.startSession(manualConfig)).rejects.toThrow('data clear');
    await expect(
      h.engine.runWithDataClearBarrier(
        (): Promise<void> => Promise.resolve(),
        (): boolean => true,
      ),
    ).resolves.toBeUndefined();
  });

  it('serializes local and live list caches and reconciles a pending local Sync value', async () => {
    let releaseFirstCache: () => void = (): void => {};
    let signalFirstCacheStarted: () => void = (): void => {};
    const firstCacheBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseFirstCache = resolve;
    });
    const firstCacheStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalFirstCacheStarted = resolve;
    });
    let cacheWrites: number = 0;
    const h: Harness = makeEngine({
      hasPendingSync: (key: string): boolean => key === SYNC_LISTS,
      saveMatcherCache: (): Promise<void> => {
        cacheWrites += 1;
        if (cacheWrites !== 1) return Promise.resolve();
        signalFirstCacheStarted();
        return firstCacheBlocked;
      },
    });
    const localLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'local.example' }],
    };
    const liveLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'live.example' }],
    };

    const localUpdate: Promise<Ack> = h.engine.updateLists(localLists);
    await firstCacheStarted;
    const liveUpdate: Promise<Ack> = h.engine.applySyncedLists(liveLists);
    await Promise.resolve();

    expect(h.ports.saveMatcherCache).toHaveBeenCalledTimes(1);
    releaseFirstCache();
    await expect(localUpdate).resolves.toEqual({ ok: true });
    await expect(liveUpdate).resolves.toEqual({ ok: true });
    expect(h.ports.saveMatcherCache).toHaveBeenCalledTimes(2);
    expect(h.ports.queueSync).toHaveBeenCalledWith(SYNC_LISTS, localLists);
    expect(h.ports.queueSync).toHaveBeenCalledWith(SYNC_LISTS, liveLists);
    expect(h.ports.supersedeSync).not.toHaveBeenCalledWith(SYNC_LISTS, liveLists);
    expect(h.engine.getLists()).toEqual(liveLists);
    expect(h.engine.verdictFor('https://live.example/page').blocked).toBe(false);
  });

  it('reconciles local Sync queued after a live event arrives during cache persistence', async () => {
    let releaseFirstCache: () => void = (): void => {};
    let signalFirstCacheStarted: () => void = (): void => {};
    const firstCacheBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseFirstCache = resolve;
    });
    const firstCacheStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalFirstCacheStarted = resolve;
    });
    let cacheWrites: number = 0;
    const syncWrites: Array<Record<string, unknown>> = [];
    const writer: SyncWriter = new SyncWriter(
      60_000,
      async (items: Record<string, unknown>): Promise<void> => {
        syncWrites.push(structuredClone(items));
      },
    );
    const h: Harness = makeEngine({
      hasPendingSync: (key: string): boolean => writer.hasPending(key),
      queueSync: (key: string, value: unknown): void => writer.queue(key, value),
      saveMatcherCache: (): Promise<void> => {
        cacheWrites += 1;
        if (cacheWrites !== 1) return Promise.resolve();
        signalFirstCacheStarted();
        return firstCacheBlocked;
      },
    });
    const localLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'local.example' }],
    };
    const liveLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'live.example' }],
    };

    const localUpdate: Promise<Ack> = h.engine.updateLists(localLists);
    await firstCacheStarted;
    expect(writer.hasPending(SYNC_LISTS)).toBe(false);
    const liveUpdate: Promise<Ack> = h.engine.applySyncedLists(liveLists, false);

    releaseFirstCache();
    await expect(localUpdate).resolves.toEqual({ ok: true });
    await expect(liveUpdate).resolves.toEqual({ ok: true });
    await writer.flushNow();

    expect(syncWrites).toHaveLength(1);
    expect(syncWrites[0]).toEqual(expect.objectContaining({ [SYNC_LISTS]: liveLists }));
    expect(h.engine.getLists()).toEqual(liveLists);
  });

  it('prevents stale journal replay after failed cleanup and later live lists', async () => {
    let durableJournal: SyncJournal = { sets: {}, removes: [] };
    let rejectCleanup: boolean = true;
    const syncWrites: Array<Record<string, unknown>> = [];
    const writer: SyncWriter = new SyncWriter(
      60_000,
      async (items: Record<string, unknown>): Promise<void> => {
        syncWrites.push(structuredClone(items));
      },
      undefined,
      {
        initial: durableJournal,
        persist: async (journal: SyncJournal): Promise<void> => {
          if (Object.keys(journal.sets).length === 0 && rejectCleanup) {
            rejectCleanup = false;
            throw new Error('cleanup unavailable');
          }
          durableJournal = structuredClone(journal);
        },
      },
    );
    const h: Harness = makeEngine({
      hasPendingSync: (key: string): boolean => writer.hasPending(key),
      queueSync: (key: string, value: unknown): void => writer.queue(key, value),
      persistSyncJournal: (): Promise<void> => writer.whenJournalDurable(),
    });
    const localLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'local.example' }],
    };
    const liveLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'live.example' }],
    };

    await expect(h.engine.updateLists(localLists)).resolves.toEqual({ ok: true });
    await expect(writer.flushNow()).rejects.toThrow('cleanup unavailable');

    expect(syncWrites).toEqual([expect.objectContaining({ [SYNC_LISTS]: localLists })]);
    expect(writer.hasPending(SYNC_LISTS)).toBe(true);
    expect(durableJournal.sets[SYNC_LISTS]).toEqual(localLists);

    await expect(h.engine.applySyncedLists(liveLists)).resolves.toEqual({ ok: true });

    expect(durableJournal.sets[SYNC_LISTS]).toEqual(liveLists);
    const replayWrites: Array<Record<string, unknown>> = [];
    const restarted: SyncWriter = new SyncWriter(
      60_000,
      async (items: Record<string, unknown>): Promise<void> => {
        replayWrites.push(structuredClone(items));
      },
      undefined,
      {
        initial: durableJournal,
        persist: vi.fn().mockResolvedValue(undefined),
      },
    );
    await restarted.flushNow();
    expect(replayWrites).toEqual([expect.objectContaining({ [SYNC_LISTS]: liveLists })]);

    await writer.flushNow();
    expect(syncWrites).toEqual([
      expect.objectContaining({ [SYNC_LISTS]: localLists }),
      expect.objectContaining({ [SYNC_LISTS]: liveLists }),
    ]);
    expect(durableJournal).toEqual({ sets: {}, removes: [] });
  });

  it('keeps later live lists after a same-value event and pending local flush', async () => {
    const syncWrites: Array<Record<string, unknown>> = [];
    const writer: SyncWriter = new SyncWriter(
      60_000,
      async (items: Record<string, unknown>): Promise<void> => {
        syncWrites.push(structuredClone(items));
      },
    );
    const h: Harness = makeEngine({
      hasPendingSync: (key: string): boolean => writer.hasPending(key),
      queueSync: (key: string, value: unknown): void => writer.queue(key, value),
    });
    await h.engine.startSession(manualConfig);
    await writer.flushNow();
    syncWrites.length = 0;
    clearMutationPorts(h.ports);
    let releaseBlocking: () => void = (): void => {};
    let signalBlockingStarted: () => void = (): void => {};
    const blockingBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseBlocking = resolve;
    });
    const blockingStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalBlockingStarted = resolve;
    });
    h.ports.applyBlocking.mockImplementationOnce((): Promise<void> => {
      signalBlockingStarted();
      return blockingBlocked;
    });
    const localLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'local.example' }],
    };
    const liveLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'live.example' }],
    };

    const localUpdate: Promise<Ack> = h.engine.updateLists(localLists);
    await blockingStarted;
    const matchingLiveUpdate: Promise<Ack> = h.engine.applySyncedLists(localLists);
    const liveUpdate: Promise<Ack> = h.engine.applySyncedLists(liveLists);
    await writer.flushNow();
    expect(syncWrites).toHaveLength(1);
    expect(syncWrites[0]).toEqual(expect.objectContaining({ [SYNC_LISTS]: localLists }));
    expect(writer.hasPending(SYNC_LISTS)).toBe(false);

    releaseBlocking();
    await expect(localUpdate).resolves.toEqual({ ok: true });
    await expect(matchingLiveUpdate).resolves.toEqual({ ok: true });
    await expect(liveUpdate).resolves.toEqual({ ok: true });
    await writer.flushNow();

    expect(syncWrites).toHaveLength(2);
    expect(syncWrites[1]).toEqual(expect.objectContaining({ [SYNC_LISTS]: liveLists }));
    expect(h.engine.getLists()).toEqual(liveLists);
  });

  it('serializes list encoding and mutations in invocation order', async () => {
    const syncWrites: Array<Record<string, unknown>> = [];
    const writer: SyncWriter = new SyncWriter(
      60_000,
      async (items: Record<string, unknown>): Promise<void> => {
        syncWrites.push(structuredClone(items));
      },
    );
    const h: Harness = makeEngine({
      hasPendingSync: (key: string): boolean => writer.hasPending(key),
      queueSync: (key: string, value: unknown): void => writer.queue(key, value),
    });
    const localLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'local.example' }],
    };
    const liveLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'live.example' }],
    };
    let releaseFirstDigest: () => void = (): void => {};
    const firstDigestBlocked: Promise<ArrayBuffer> = new Promise(
      (resolve: (value: ArrayBuffer) => void): void => {
        releaseFirstDigest = (): void => resolve(new ArrayBuffer(32));
      },
    );
    let signalFirstDigestStarted: () => void = (): void => {};
    const firstDigestStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalFirstDigestStarted = resolve;
    });
    let digestCalls: number = 0;
    const digestSpy = vi
      .spyOn(crypto.subtle, 'digest')
      .mockImplementation((): Promise<ArrayBuffer> => {
        digestCalls += 1;
        if (digestCalls === 1) signalFirstDigestStarted();
        return digestCalls === 1 ? firstDigestBlocked : Promise.resolve(new ArrayBuffer(32));
      });
    const listUpdates: Array<Promise<Ack>> = [];

    try {
      const localUpdate: Promise<Ack> = h.engine.updateLists(localLists);
      const matchingLiveUpdate: Promise<Ack> = h.engine.applySyncedLists(localLists);
      const liveUpdate: Promise<Ack> = h.engine.applySyncedLists(liveLists);
      listUpdates.push(localUpdate, matchingLiveUpdate, liveUpdate);
      await firstDigestStarted;

      expect(digestCalls).toBe(1);
      releaseFirstDigest();

      await expect(Promise.all(listUpdates)).resolves.toEqual([
        { ok: true },
        { ok: true },
        { ok: true },
      ]);
    } finally {
      releaseFirstDigest();
      await Promise.allSettled(listUpdates);
      digestSpy.mockRestore();
    }

    await writer.flushNow();

    expect(
      h.ports.saveMatcherCache.mock.calls.map(
        (call: unknown[]): ListsConfig => call[1] as ListsConfig,
      ),
    ).toEqual([localLists, localLists, liveLists]);
    expect(syncWrites).toEqual([expect.objectContaining({ [SYNC_LISTS]: liveLists })]);
    expect(h.engine.getLists()).toEqual(liveLists);
  });

  it('does not rewrite the matcher cache when hard-session guards reject local or live lists', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession({ ...manualConfig, strictness: 'hard' });
    clearMutationPorts(h.ports);
    const weaker: ListsConfig = { ...DEFAULT_LISTS, custom: [] };

    await expect(h.engine.updateLists(weaker)).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
    await expect(h.engine.applySyncedLists(weaker)).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );

    expect(h.ports.saveMatcherCache).not.toHaveBeenCalled();
    expect(h.engine.getLists()).toEqual({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'facebook.com' }],
    });
    expect(h.engine.verdictFor('https://facebook.com/feed').blocked).toBe(true);
  });

  it('rejects oversized settings before time-advanced catch-up mutates state or queues writes', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    const before: SessionSnapshot = h.engine.snapshot();
    await h.engine.snapshotPersisted();
    clearMutationPorts(h.ports);
    h.setNow(T0 + 60_000);

    await expect(h.engine.updateSettings(oversizedSettings())).resolves.toEqual({
      ok: false,
      error:
        'Settings exceed the 8 KB Chrome Sync limit. Remove schedule entries or shorten intentions, then try again.',
    });

    expect(h.ports.now).not.toHaveBeenCalled();
    expect(h.ports.saveRuntime).not.toHaveBeenCalled();
    expect(h.ports.queueSync).not.toHaveBeenCalled();
    expect(h.ports.appendEvents).not.toHaveBeenCalled();
    expect(h.ports.applyBlocking).not.toHaveBeenCalled();
    h.setNow(T0);
    expect(h.engine.snapshot()).toEqual(before);
  });

  it('rejects oversized lists before a schedule boundary starts a session or compiles its matcher', async () => {
    const h: Harness = makeEngine({ settings: { schedule: [scheduledEntry] } });
    const before: SessionSnapshot = h.engine.snapshot();
    await h.engine.snapshotPersisted();
    clearMutationPorts(h.ports);
    h.setNow(T0 + 60_000);
    const oversized: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: oversizedHostRules('scheduled'),
    };

    await expect(h.engine.updateLists(oversized)).resolves.toEqual({
      ok: false,
      error:
        'Lists exceed the 8 KB Chrome Sync limit. Remove custom or whitelist rules, then try again.',
    });

    expect(h.ports.now).not.toHaveBeenCalled();
    expect(h.ports.saveRuntime).not.toHaveBeenCalled();
    expect(h.ports.queueSync).not.toHaveBeenCalled();
    expect(h.ports.appendEvents).not.toHaveBeenCalled();
    expect(h.ports.applyBlocking).not.toHaveBeenCalled();
    expect(h.engine.getLists()).toEqual({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'facebook.com' }],
    });
    h.setNow(T0);
    expect(h.engine.snapshot()).toEqual(before);
  });

  it('reports the quota error before hard-session settings weakening policy', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession({ ...manualConfig, strictness: 'hard' });
    await h.engine.snapshotPersisted();
    clearMutationPorts(h.ports);
    const oversized: Settings = oversizedSettings({
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 1_000 },
    });

    await expect(h.engine.updateSettings(oversized)).resolves.toEqual({
      ok: false,
      error:
        'Settings exceed the 8 KB Chrome Sync limit. Remove schedule entries or shorten intentions, then try again.',
    });

    expect(h.engine.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(h.ports.now).not.toHaveBeenCalled();
    expect(h.ports.saveRuntime).not.toHaveBeenCalled();
    expect(h.ports.queueSync).not.toHaveBeenCalled();
  });

  it('reports the quota error before hard-session list weakening policy', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession({ ...manualConfig, strictness: 'hard' });
    const before = h.engine.verdictFor('https://facebook.com/feed');
    await h.engine.snapshotPersisted();
    clearMutationPorts(h.ports);
    const oversized: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: oversizedHostRules('replacement'),
    };

    await expect(h.engine.updateLists(oversized)).resolves.toEqual({
      ok: false,
      error:
        'Lists exceed the 8 KB Chrome Sync limit. Remove custom or whitelist rules, then try again.',
    });

    expect(h.engine.getLists()).toEqual({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'facebook.com' }],
    });
    expect(h.ports.now).not.toHaveBeenCalled();
    expect(h.engine.verdictFor('https://facebook.com/feed')).toEqual(before);
    expect(h.ports.saveRuntime).not.toHaveBeenCalled();
    expect(h.ports.queueSync).not.toHaveBeenCalled();
  });

  it('persists attempts discovered by the blocking sweep without commit deadlock', async () => {
    const h: Harness = makeEngine();
    let attemptWasDurableBeforeSweepContinued = false;
    let signalSweepAttempt: () => void = (): void => {
      throw new Error('blocking sweep attempt signal was not initialized');
    };
    const sweepAttemptStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalSweepAttempt = resolve;
    });
    h.ports.applyBlocking.mockImplementation(async (lease: BlockingSweepLease): Promise<void> => {
      signalSweepAttempt();
      await h.engine.recordAttempt('https://facebook.com/feed', 7, 'existing', lease);
      attemptWasDurableBeforeSweepContinued = h
        .loggedEvents()
        .some((event: EventRecord): boolean => event.t === 'attempt');
    });
    const starting: Promise<Ack> = h.engine.startSession(manualConfig);
    await sweepAttemptStarted;

    await expect(starting).resolves.toEqual({ ok: true });
    expect(h.loggedEvents().some((event: EventRecord): boolean => event.t === 'attempt')).toBe(
      true,
    );
    expect(attemptWasDurableBeforeSweepContinued).toBe(true);
  });

  it('awaits catch-up persistence before answering an async snapshot request', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession({ ...manualConfig, durationMin: 0.1 });
    h.setNow(T0 + 7_000);
    let releaseEvents: () => void = (): void => {
      throw new Error('event persistence did not start');
    };
    h.ports.appendEvents.mockClear();
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releaseEvents = resolve;
        }),
    );

    const reading: Promise<SessionSnapshot> = h.engine.snapshotPersisted();
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalled());
    let resolved = false;
    void reading.then((): void => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    releaseEvents();
    expect((await reading).phase).toBe('idle');
  });

  it('rejects a second session while one runs', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    const ack = await h.engine.startSession(manualConfig);
    expect(ack.ok).toBe(false);
  });

  it('self-heals into an active scheduled session', () => {
    const h: Harness = makeEngine({ settings: { schedule: [scheduledEntry] } });
    h.setNow(T0 + 16 * 60_000);

    const snapshot: SessionSnapshot = h.engine.snapshot();

    expect(snapshot.config).toMatchObject({
      source: 'schedule',
      scheduleEntryId: scheduledEntry.id,
      strictness: 'hard',
      durationMin: 45,
    });
    expect(h.ports.playSound).toHaveBeenCalledWith('scheduleStart');
    expect(h.ports.notify).toHaveBeenCalledWith('Focus schedule started', 'Locked until 10:00.');
  });

  it('derives a fresh rules snapshot when a schedule starts', (): void => {
    const currentLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'scheduled-current.example' }],
    };
    const h: Harness = makeEngine({
      settings: { schedule: [scheduledEntry] },
      lists: currentLists,
    });
    h.setNow(new Date(2026, 7, 29, 9, 0).getTime());

    const snapshot: SessionSnapshot = h.engine.snapshot();

    expect(snapshot.config?.rules).toEqual(rulesFromLists(currentLists));
    expect(h.engine.verdictFor('https://scheduled-current.example/page').blocked).toBe(true);
  });

  it('uses the injected identity for a scheduled session and its start event', async () => {
    const h: Harness = makeEngine({ settings: { schedule: [scheduledEntry] } });
    h.setNow(new Date(2026, 7, 29, 9, 1).getTime());

    await h.engine.snapshotPersisted();

    expect(h.ports.saveRuntime.mock.calls.at(-1)?.[0]).toMatchObject({
      session: { sessionId: 'archive-id' },
    });
    expect(h.loggedEvents()).toContainEqual(
      expect.objectContaining({ t: 'sessionStarted', sessionId: 'archive-id' }),
    );
  });

  it('upgrades a running friction session when a hard schedule opens', async () => {
    const sessionCompiler: Mock<typeof compileSessionMatcher> = vi.fn(compileSessionMatcher);
    const h: Harness = makeEngine({
      settings: { schedule: [scheduledEntry] },
      sessionCompiler,
    });
    await h.engine.startSession(manualConfig);
    h.setNow(T0 + 16 * 60_000);

    const snapshot: SessionSnapshot = h.engine.snapshot();
    h.engine.verdictFor('https://facebook.com/feed');
    h.engine.verdictFor('https://facebook.com/messages');

    expect(snapshot.config?.strictness).toBe('hard');
    expect(sessionCompiler).toHaveBeenCalledTimes(1);
    expect(h.ports.playSound).not.toHaveBeenCalledWith('scheduleStart');
  });

  it.each([
    ['flexible', 'friction', 'friction'],
    ['flexible', 'hard', 'hard'],
    ['friction', 'hard', 'hard'],
    ['friction', 'flexible', 'friction'],
    ['hard', 'flexible', 'hard'],
    ['hard', 'friction', 'hard'],
  ] as const)(
    'keeps the stronger strictness when a %s session meets a %s schedule',
    async (running, scheduled, expected): Promise<void> => {
      const entry: ScheduleEntry = { ...scheduledEntry, strictness: scheduled };
      const h: Harness = makeEngine({ settings: { schedule: [entry] } });
      await h.engine.startSession({ ...manualConfig, strictness: running });
      h.setNow(new Date(2026, 7, 29, 9, 0).getTime());

      expect(h.engine.snapshot().config?.strictness).toBe(expected);
    },
  );

  it('invalidates a Friction cancel gate when a Hard schedule starts', async () => {
    const h: Harness = makeEngine({ settings: { schedule: [scheduledEntry] } });
    await h.engine.startSession(manualConfig);
    expect(await h.engine.requestSessionEnd()).toEqual({ ok: true });
    expect(h.engine.snapshot().gate?.kind).toBe('cancel');
    h.setNow(new Date(2026, 7, 29, 9, 0).getTime());

    const confirmation: Ack = await h.engine.confirmGate(null);

    expect(confirmation.ok).toBe(false);
    expect(h.engine.snapshot()).toMatchObject({
      phase: 'focus',
      config: { strictness: 'hard' },
      gate: null,
    });
  });

  it('rejects a persisted cancel gate when the current session is Hard', async () => {
    const first: Harness = makeEngine();
    await first.engine.startSession(manualConfig);
    await first.engine.requestSessionEnd();
    const runtime: RuntimeState = structuredClone(
      first.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    if (runtime.session === null) throw new Error('expected a persisted session');
    runtime.session.config.strictness = 'hard';
    const restarted: Harness = makeEngine({ runtime });
    restarted.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs);

    expect(await restarted.engine.confirmGate(null)).toEqual({
      ok: false,
      error: 'hard sessions cannot be canceled',
    });
    expect(restarted.engine.snapshot()).toMatchObject({ phase: 'focus', gate: null });
  });

  it.each(['flexible', 'friction'] as const)(
    'does not restart a canceled scheduled %s session in the same window',
    async (strictness): Promise<void> => {
      const entry: ScheduleEntry = { ...scheduledEntry, strictness };
      const h: Harness = makeEngine({ settings: { schedule: [entry] } });
      const insideWindow: number = new Date(2026, 7, 29, 9, 1).getTime();
      h.setNow(insideWindow);
      expect(h.engine.snapshot().config?.source).toBe('schedule');

      expect(await h.engine.requestSessionEnd()).toEqual({ ok: true });
      if (strictness === 'friction') {
        h.setNow(insideWindow + DEFAULT_SETTINGS.gate.delayMs);
        expect(await h.engine.confirmGate(null)).toEqual({ ok: true });
      }

      expect(h.engine.snapshot()).toMatchObject({ phase: 'idle', scheduleActive: true });
      expect(
        h.loggedEvents().filter((event: EventRecord): boolean => event.t === 'sessionStarted'),
      ).toHaveLength(1);

      h.setNow(new Date(2026, 7, 29, 10, 1).getTime());
      expect(h.engine.snapshot()).toMatchObject({ phase: 'idle', scheduleActive: false });
      h.setNow(new Date(2026, 7, 30, 9, 1).getTime());
      expect(h.engine.snapshot().config?.source).toBe('schedule');
    },
  );

  it('starts a later occurrence after jumping over the inactive gap', async (): Promise<void> => {
    const entry: ScheduleEntry = { ...scheduledEntry, strictness: 'flexible' };
    const h: Harness = makeEngine({ settings: { schedule: [entry] } });
    h.setNow(new Date(2026, 7, 29, 9, 1).getTime());
    expect(h.engine.snapshot().config?.source).toBe('schedule');
    expect(await h.engine.requestSessionEnd()).toEqual({ ok: true });
    expect(h.engine.snapshot()).toMatchObject({ phase: 'idle', scheduleActive: true });

    h.setNow(new Date(2026, 7, 30, 9, 1).getTime());
    const later: SessionSnapshot = await h.engine.snapshotPersisted();

    expect(later).toMatchObject({
      phase: 'focus',
      scheduleActive: true,
      config: { source: 'schedule', scheduleEntryId: entry.id },
    });
    expect(
      h.loggedEvents().filter((event: EventRecord): boolean => event.t === 'sessionStarted'),
    ).toHaveLength(2);
  });

  it('starts a later occurrence after restart with persisted suppression', async (): Promise<void> => {
    const entry: ScheduleEntry = { ...scheduledEntry, strictness: 'flexible' };
    const first: Harness = makeEngine({ settings: { schedule: [entry] } });
    first.setNow(new Date(2026, 7, 29, 9, 1).getTime());
    first.engine.snapshot();
    expect(await first.engine.requestSessionEnd()).toEqual({ ok: true });
    const suppressed: RuntimeState = structuredClone(
      first.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    expect(suppressed.scheduleActiveEntryId).not.toBe(entry.id);

    const restarted: Harness = makeEngine({ runtime: suppressed, settings: { schedule: [entry] } });
    restarted.setNow(new Date(2026, 7, 30, 9, 1).getTime());

    expect(restarted.engine.snapshot()).toMatchObject({
      phase: 'focus',
      scheduleActive: true,
      config: { source: 'schedule', scheduleEntryId: entry.id },
    });
  });

  it('persists scheduleActive for the current absolute occurrence', async (): Promise<void> => {
    const entry: ScheduleEntry = { ...scheduledEntry, strictness: 'flexible' };
    const h: Harness = makeEngine({ settings: { schedule: [entry] } });
    const now: number = new Date(2026, 7, 29, 9, 1).getTime();
    const occurrenceEnd: number = new Date(2026, 7, 29, 10, 0).getTime();
    h.setNow(now);

    const snapshot: SessionSnapshot = await h.engine.snapshotPersisted();
    const saved: RuntimeState = h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState;

    expect(snapshot.scheduleActive).toBe(true);
    expect(saved.scheduleActiveEntryId).toContain(entry.id);
    expect(saved.scheduleActiveEntryId).toContain(String(occurrenceEnd));
  });

  it('conservatively suppresses one occurrence for a legacy entry-ID marker', async (): Promise<void> => {
    const entry: ScheduleEntry = { ...scheduledEntry, strictness: 'flexible' };
    const runtime: RuntimeState = {
      ...emptyRuntime(T0),
      scheduleActiveEntryId: entry.id,
    };
    const h: Harness = makeEngine({ runtime, settings: { schedule: [entry] } });
    h.setNow(new Date(2026, 7, 29, 9, 1).getTime());

    expect(await h.engine.snapshotPersisted()).toMatchObject({
      phase: 'idle',
      scheduleActive: true,
    });

    h.setNow(new Date(2026, 7, 30, 9, 1).getTime());
    expect(h.engine.snapshot()).toMatchObject({
      phase: 'focus',
      scheduleActive: true,
      config: { source: 'schedule', scheduleEntryId: entry.id },
    });
  });

  it('rolls the local day and runs retention pruning at most weekly', async () => {
    const h: Harness = makeEngine();
    h.setNow(T0 + DAY_MS);

    await h.engine.tick();

    expect(h.ports.queueSync).toHaveBeenCalledWith(
      `agg:dev-test:${localDateStr(T0)}`,
      expect.objectContaining({ date: localDateStr(T0) }),
    );
    expect(h.ports.prune).toHaveBeenCalledOnce();
    expect(h.ports.prune).toHaveBeenCalledWith(DEFAULT_SETTINGS.retentionDays, T0 + DAY_MS);

    h.setNow(T0 + 2 * DAY_MS);
    await h.engine.tick();

    expect(h.ports.prune).toHaveBeenCalledOnce();
    const savedRuntime: RuntimeState = h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState;
    expect(savedRuntime.date).toBe(localDateStr(T0 + 2 * DAY_MS));
  });

  it('retains a finished aggregate checkpoint until local durability succeeds', async (): Promise<void> => {
    const saveAggregate = vi
      .fn<NonNullable<EnginePorts['saveAggregate']>>()
      .mockRejectedValueOnce(new Error('local aggregate unavailable'));
    const first: Harness = makeEngine({ saveAggregate });
    first.setNow(T0 + DAY_MS);

    await expect(first.engine.tick()).rejects.toThrow('local aggregate unavailable');

    const checkpointRuntime: RuntimeState = structuredClone(
      first.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    const finishedKey: string = `agg:dev-test:${localDateStr(T0)}`;
    expect(checkpointRuntime.commitCheckpoint?.aggregateSets).toMatchObject({
      [finishedKey]: expect.objectContaining({ date: localDateStr(T0) }),
    });

    const recoveredSave = vi
      .fn<NonNullable<EnginePorts['saveAggregate']>>()
      .mockResolvedValue(undefined);
    const restarted: Harness = makeEngine({
      runtime: checkpointRuntime,
      saveAggregate: recoveredSave,
    });
    restarted.setNow(T0 + DAY_MS);
    await restarted.engine.tick();

    expect(recoveredSave).toHaveBeenCalledWith(
      finishedKey,
      expect.objectContaining({ date: localDateStr(T0) }),
    );
    const recoveredRuntime: RuntimeState = restarted.ports.saveRuntime.mock.calls.at(-1)?.[0];
    expect(recoveredRuntime.commitCheckpoint).toBeNull();
  });

  it('caps rollover and recovered checkpoint aggregates before durability', async (): Promise<void> => {
    const date: string = localDateStr(T0);
    const runtime: RuntimeState = {
      ...emptyRuntime(T0),
      todayAgg: highCardinalityDaily(date, 30),
    };
    const firstSave = vi
      .fn<NonNullable<EnginePorts['saveAggregate']>>()
      .mockResolvedValue(undefined);
    const first: Harness = makeEngine({ runtime, saveAggregate: firstSave });
    first.setNow(T0 + DAY_MS);

    await first.engine.tick();

    const rollover = firstSave.mock.calls.find(
      ([key]: [string, DailyAgg]): boolean => key === syncAggKey('dev-test', date),
    )?.[1];
    expect(Object.keys(rollover?.attempts ?? {})).toHaveLength(TOP_SITES_DAILY);
    expect(rollover?.attemptsOther).toBe(55);

    const recoveredRuntime: RuntimeState = {
      ...emptyRuntime(T0 + DAY_MS),
      commitCheckpoint: {
        bank: { balanceMs: 0 },
        events: [],
        syncBank: false,
        aggregateSets: {
          [syncAggKey('dev-test', date)]: highCardinalityDaily(date, 30),
        },
      },
    };
    const recoveredSave = vi
      .fn<NonNullable<EnginePorts['saveAggregate']>>()
      .mockResolvedValue(undefined);
    const restarted: Harness = makeEngine({
      runtime: recoveredRuntime,
      saveAggregate: recoveredSave,
    });
    restarted.setNow(T0 + DAY_MS);

    await restarted.engine.tick();

    const recovered = recoveredSave.mock.calls.find(
      ([key]: [string, DailyAgg]): boolean => key === syncAggKey('dev-test', date),
    )?.[1];
    expect(Object.keys(recovered?.attempts ?? {})).toHaveLength(TOP_SITES_DAILY);
    expect(recovered?.attemptsOther).toBe(55);
  });

  it('drains aggregate commits before entering a storage-mode transition', async (): Promise<void> => {
    let releaseSave: () => void = (): void => {
      throw new Error('aggregate save did not start');
    };
    const saveStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseSave = resolve;
    });
    let unblockSave: () => void = (): void => {
      throw new Error('aggregate save release was not initialized');
    };
    let saveCalls: number = 0;
    const h: Harness = makeEngine({
      saveAggregate: async (): Promise<void> => {
        saveCalls += 1;
        if (saveCalls > 1) return;
        releaseSave();
        await new Promise<void>((resolve: () => void): void => {
          unblockSave = resolve;
        });
      },
    });
    h.setNow(T0 + DAY_MS);
    const ticking: Promise<void> = h.engine.tick();
    await saveStarted;
    let entered: boolean = false;

    const transitioning: Promise<void> = h.engine.runWithAggregateStorageBarrier(
      async (): Promise<void> => {
        entered = true;
        await expect(h.engine.startSession(manualConfig)).rejects.toThrow('storage transition');
      },
    );
    await Promise.resolve();
    expect(entered).toBe(false);

    unblockSave();
    await Promise.all([ticking, transitioning]);

    expect(entered).toBe(true);
    const savedRuntime: RuntimeState = h.ports.saveRuntime.mock.calls.at(-1)?.[0];
    expect(savedRuntime.commitCheckpoint).toBeNull();
  });

  it('cancels immediately and defers durability while an aggregate barrier is open', async (): Promise<void> => {
    let websiteBlockingReady: boolean = true;
    const h: Harness = makeEngine({
      websiteBlockingReady: (): boolean => websiteBlockingReady,
    });
    await h.engine.startSession({ ...manualConfig, strictness: 'hard' });
    clearMutationPorts(h.ports);
    const blockingPhases: SessionSnapshot['phase'][] = [];
    h.ports.applyBlocking.mockImplementation(async (): Promise<void> => {
      blockingPhases.push(h.engine.snapshot().phase);
    });
    let signalBarrierEntered: () => void = (): void => undefined;
    let releaseBarrier: () => void = (): void => undefined;
    let barrierObservedPhase: SessionSnapshot['phase'] | null = null;
    const barrierEntered: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalBarrierEntered = resolve;
    });
    const barrierGate: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseBarrier = resolve;
    });
    const transitioning: Promise<void> = h.engine.runWithAggregateStorageBarrier(
      async (): Promise<void> => {
        signalBarrierEntered();
        await barrierGate;
        barrierObservedPhase = h.engine.snapshot().phase;
      },
    );
    await barrierEntered;
    websiteBlockingReady = false;

    await expect(h.engine.endSessionForWebsiteBlockingLoss()).resolves.toBe(true);
    await expect(h.engine.endSessionForWebsiteBlockingLoss()).resolves.toBe(false);
    expect(h.engine.snapshot()).toMatchObject({ phase: 'idle', gate: null, activeUnlocks: [] });
    expect(h.ports.applyBlocking).toHaveBeenCalledOnce();
    expect(blockingPhases).toEqual(['idle']);
    expect(h.ports.saveRuntime).not.toHaveBeenCalled();
    releaseBarrier();
    await transitioning;

    expect(barrierObservedPhase).toBe('idle');
    expect(h.loggedEvents()).toContainEqual(expect.objectContaining({ t: 'sessionCanceled' }));
    expect(h.ports.applyBlocking).toHaveBeenCalledTimes(2);
    expect(blockingPhases).toEqual(['idle', 'idle']);
    const persistedRuntime: RuntimeState = h.ports.saveRuntime.mock.calls.at(-1)?.[0];
    expect(persistedRuntime.session).toBeNull();
    expect(persistedRuntime.commitCheckpoint).toBeNull();
    const restarted: Harness = makeEngine({
      runtime: structuredClone(persistedRuntime),
      websiteBlockingReady: (): boolean => false,
    });
    expect(restarted.engine.snapshot().phase).toBe('idle');
    await h.engine.tick();
    expect(blockingPhases).not.toContain('focus');
  });

  it('does not let a draining active-session snapshot resurrect a canceled session', async (): Promise<void> => {
    let websiteBlockingReady: boolean = true;
    const h: Harness = makeEngine({
      websiteBlockingReady: (): boolean => websiteBlockingReady,
    });
    await h.engine.startSession({ ...manualConfig, strictness: 'hard' });
    clearMutationPorts(h.ports);
    let signalRuntimeSave: () => void = (): void => undefined;
    let releaseRuntimeSave: () => void = (): void => undefined;
    const runtimeSaveStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalRuntimeSave = resolve;
    });
    const runtimeSaveGate: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseRuntimeSave = resolve;
    });
    const drainingSnapshots: RuntimeState[] = [];
    h.ports.saveRuntime.mockImplementationOnce(async (runtime: RuntimeState): Promise<void> => {
      drainingSnapshots.push(structuredClone(runtime));
      signalRuntimeSave();
      await runtimeSaveGate;
    });
    h.setNow(T0 + 60_000);
    const ticking: Promise<void> = h.engine.tick();
    await runtimeSaveStarted;
    let barrierObservedPhase: SessionSnapshot['phase'] | null = null;
    const transitioning: Promise<void> = h.engine.runWithAggregateStorageBarrier(
      async (): Promise<void> => {
        barrierObservedPhase = h.engine.snapshot().phase;
      },
    );
    websiteBlockingReady = false;

    await expect(h.engine.endSessionForWebsiteBlockingLoss()).resolves.toBe(true);
    expect(h.engine.snapshot().phase).toBe('idle');
    releaseRuntimeSave();
    await Promise.all([ticking, transitioning]);

    expect(drainingSnapshots[0]?.session).not.toBeNull();
    expect(barrierObservedPhase).toBe('idle');
    const persistedRuntime: RuntimeState = h.ports.saveRuntime.mock.calls.at(-1)?.[0];
    expect(persistedRuntime.session).toBeNull();
    expect(persistedRuntime.commitCheckpoint).toBeNull();
    const restarted: Harness = makeEngine({
      runtime: structuredClone(persistedRuntime),
      websiteBlockingReady: (): boolean => false,
    });
    expect(restarted.engine.snapshot().phase).toBe('idle');
  });

  it('retries a deferred surface clear after consecutive apply failures', async (): Promise<void> => {
    let websiteBlockingReady: boolean = true;
    const h: Harness = makeEngine({
      websiteBlockingReady: (): boolean => websiteBlockingReady,
    });
    await h.engine.startSession({ ...manualConfig, strictness: 'hard' });
    clearMutationPorts(h.ports);
    let signalBarrierEntered: () => void = (): void => undefined;
    let releaseBarrier: () => void = (): void => undefined;
    const barrierEntered: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalBarrierEntered = resolve;
    });
    const barrierGate: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseBarrier = resolve;
    });
    const transitioning: Promise<void> = h.engine.runWithAggregateStorageBarrier(
      async (): Promise<void> => {
        signalBarrierEntered();
        await barrierGate;
      },
    );
    await barrierEntered;
    websiteBlockingReady = false;

    await expect(h.engine.endSessionForWebsiteBlockingLoss()).resolves.toBe(true);
    const deferredApplyError: Error = new Error('deferred clear failed');
    h.ports.applyBlocking.mockRejectedValueOnce(deferredApplyError);
    releaseBarrier();
    await transitioning;

    expect(h.ports.reportError).toHaveBeenCalledWith(deferredApplyError);
    expect(h.ports.scheduleWake).toHaveBeenCalledWith(T0 + 1_000);
    const retryApplyError: Error = new Error('retry clear failed');
    h.ports.applyBlocking.mockRejectedValueOnce(retryApplyError);
    await expect(h.engine.tick()).rejects.toBe(retryApplyError);

    await h.engine.tick();
    expect(h.ports.applyBlocking).toHaveBeenCalledTimes(4);
    await h.engine.tick();
    expect(h.ports.applyBlocking).toHaveBeenCalledTimes(4);
    const persistedRuntime: RuntimeState = h.ports.saveRuntime.mock.calls.at(-1)?.[0];
    expect(persistedRuntime.session).toBeNull();
    expect(persistedRuntime.commitCheckpoint).toBeNull();
  });

  it('does not grant a freeze token during off-Monday rollover catch-up', async () => {
    const previousDate: string = localDateStr(T0 - DAY_MS);
    const streak: StreakState = {
      current: 2,
      freezeTokens: 0,
      lastCountedDate: previousDate,
      lastFreezeGrantDate: previousDate,
      activeDays: [],
      activeMonth: previousDate.slice(0, 7),
    };
    const h: Harness = makeEngine({
      settings: { streakFreezeIntervalDays: 1 },
      streak,
    });
    h.setNow(T0 + DAY_MS);

    await h.engine.tick();

    expect(h.engine.getStreak()).toMatchObject({
      current: 0,
      freezeTokens: 0,
      lastFreezeGrantDate: previousDate,
    });
  });

  it('grants and spends Monday exactly once after a Sunday-to-Tuesday wake', async () => {
    const sundayAtNoon: number = new Date(2026, 7, 30, 12, 0).getTime();
    const monday: string = '2026-08-31';
    const runtime: RuntimeState = emptyRuntime(sundayAtNoon);
    runtime.todayAgg = {
      date: '2026-08-30',
      focusMs: 30 * 60_000,
      sessionsStarted: 1,
      sessionsCompleted: 1,
      attempts: {},
      attemptsOther: 0,
      pausesTaken: 0,
      pauseMsSpent: 0,
      pauseMsEarned: 0,
      unlocksTaken: 0,
      unlockMsSpent: 0,
      resisted: 0,
    };
    const h: Harness = makeEngine({ runtime });
    h.setNow(new Date(2026, 8, 1, 12, 0).getTime());

    await h.engine.tick();

    expect(h.engine.getStreak()).toMatchObject({
      current: 1,
      freezeTokens: 0,
      lastCountedDate: monday,
      lastFreezeGrantDate: monday,
    });
    expect(
      h.ports.queueSync.mock.calls.filter(
        (call: unknown[]): boolean => call[0] === `agg:dev-test:${monday}`,
      ),
    ).toHaveLength(1);
  });

  it('applies custom Monday cadence and token cap during multi-week catch-up', async () => {
    const sundayAtNoon: number = new Date(2026, 7, 23, 12, 0).getTime();
    const runtime: RuntimeState = emptyRuntime(sundayAtNoon);
    runtime.todayAgg = {
      date: '2026-08-23',
      focusMs: 30 * 60_000,
      sessionsStarted: 1,
      sessionsCompleted: 1,
      attempts: {},
      attemptsOther: 0,
      pausesTaken: 0,
      pauseMsSpent: 0,
      pauseMsEarned: 0,
      unlocksTaken: 0,
      unlockMsSpent: 0,
      resisted: 0,
    };
    const streak: StreakState = {
      current: 5,
      freezeTokens: 2,
      lastCountedDate: '2026-08-22',
      lastFreezeGrantDate: '2026-08-10',
      activeDays: [18, 19, 20, 21, 22],
      activeMonth: '2026-08',
    };
    const h: Harness = makeEngine({
      runtime,
      streak,
      settings: { streakFreezeIntervalDays: 14 },
    });
    h.setNow(new Date(2026, 8, 15, 12, 0).getTime());

    await h.engine.tick();

    expect(h.engine.getStreak()).toMatchObject({
      current: 0,
      freezeTokens: 0,
      lastCountedDate: '2026-09-14',
      lastFreezeGrantDate: '2026-09-07',
    });
    expect(h.ports.queueSync).toHaveBeenCalledWith(
      SYNC_STREAK,
      expect.objectContaining({
        current: 0,
        freezeTokens: 0,
        lastFreezeGrantDate: '2026-09-07',
      }),
    );
    for (const monday of ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14']) {
      expect(
        h.ports.queueSync.mock.calls.filter(
          (call: unknown[]): boolean => call[0] === `agg:dev-test:${monday}`,
        ),
      ).toHaveLength(1);
    }
  });

  it('marks retention pruning only after storage operations succeed', async () => {
    const h: Harness = makeEngine();
    h.ports.prune.mockRejectedValueOnce(new Error('sync remove failed'));

    await h.engine.tick();
    const failedRuntime: RuntimeState = h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState;
    expect(failedRuntime.lastPruneDate).toBeNull();
    expect(h.ports.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'sync remove failed',
      }),
    );
    h.ports.prune.mockResolvedValueOnce(undefined);
    await h.engine.tick();

    const savedRuntime: RuntimeState = h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState;
    expect(savedRuntime.lastPruneDate).toBe(localDateStr(T0));
    expect(h.ports.prune).toHaveBeenCalledTimes(2);
  });

  it('accrues pause budget from focus time', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    h.setNow(T0 + 60_000);
    const snap = h.engine.snapshot();
    expect(snap.bankMs).toBeCloseTo(60_000 * DEFAULT_SETTINGS.pause.earnRatio, 3);
  });

  it('does not credit the same in-progress focus interval twice', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    h.setNow(T0 + 60_000);

    const first: SessionSnapshot = h.engine.snapshot();
    const second: SessionSnapshot = h.engine.snapshot();

    expect(second.bankMs).toBe(first.bankMs);
  });

  it('records only the exact newly credited budget without duplicate catch-up', async () => {
    const h: Harness = makeEngine({
      bankMs: 900,
      settings: {
        pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0.5, capMs: 1_000 },
      },
    });
    await h.engine.startSession(manualConfig);
    h.setNow(T0 + 1_000);

    h.engine.snapshot();
    await h.engine.snapshotPersisted();
    await h.engine.snapshotPersisted();

    const earned: EventRecord[] = h
      .loggedEvents()
      .filter((event: EventRecord): boolean => event.t === 'budgetEarned');
    expect(earned).toEqual([
      expect.objectContaining({ t: 'budgetEarned', ms: 100, sessionId: 'archive-id' }),
    ]);
    expect(h.engine.statsOverlay().todayAgg.pauseMsEarned).toBe(100);
  });

  it('recovers one accrual after runtime cleanup persistence fails and the worker restarts', async () => {
    const h: Harness = makeEngine({
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0.5 } },
    });
    await h.engine.startSession(manualConfig);
    let storedRuntime: RuntimeState = structuredClone(
      h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    let durableBankMs = 0;
    const durableEvents: EventRecord[] = [];
    h.ports.queueSync.mockImplementation((key: string, value: unknown): void => {
      if (key === SYNC_BANK) durableBankMs = (value as { balanceMs: number }).balanceMs;
    });
    h.ports.appendEvents.mockImplementation(async (events: EventRecord[]): Promise<void> => {
      appendUnique(durableEvents, events);
    });
    h.ports.saveRuntime.mockImplementation(async (runtime: RuntimeState): Promise<void> => {
      if (!hasCommitCheckpoint(runtime)) throw new Error('runtime cleanup failed');
      storedRuntime = structuredClone(runtime);
    });
    h.setNow(T0 + 1_000);

    await expect(h.engine.snapshotPersisted()).rejects.toThrow('runtime cleanup failed');

    const restarted: Harness = makeEngine({
      bankMs: durableBankMs,
      runtime: storedRuntime,
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0.5 } },
      queueSync: (key: string, value: unknown): void => {
        if (key === SYNC_BANK) durableBankMs = (value as { balanceMs: number }).balanceMs;
      },
    });
    restarted.ports.appendEvents.mockImplementation(
      async (events: EventRecord[]): Promise<void> => appendUnique(durableEvents, events),
    );
    restarted.setNow(T0 + 1_000);
    await restarted.engine.snapshotPersisted();

    expect(restarted.engine.snapshot().bankMs).toBe(500);
    expect(
      durableEvents.filter((event: EventRecord): boolean => event.t === 'budgetEarned'),
    ).toHaveLength(1);
  });

  it('keeps a second accrual revision while the first event append is blocked', async () => {
    const h: Harness = makeEngine({
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0.5 } },
    });
    await h.engine.startSession(manualConfig);
    h.ports.appendEvents.mockClear();
    h.ports.queueSync.mockClear();
    let releaseFirstAppend: () => void = (): void => {
      throw new Error('first append did not start');
    };
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releaseFirstAppend = resolve;
        }),
    );
    h.setNow(T0 + 1_000);
    const first: Promise<SessionSnapshot> = h.engine.snapshotPersisted();
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalledTimes(1));

    h.setNow(T0 + 2_000);
    const second: Promise<SessionSnapshot> = h.engine.snapshotPersisted();
    releaseFirstAppend();
    await Promise.all([first, second]);

    const bankWrites: Array<{ balanceMs: number }> = h.ports.queueSync.mock.calls
      .filter((call: unknown[]): boolean => call[0] === SYNC_BANK)
      .map((call: unknown[]): { balanceMs: number } => call[1] as { balanceMs: number });
    expect(bankWrites.at(-1)?.balanceMs).toBe(1_000);
    expect(
      h.loggedEvents().filter((event: EventRecord): boolean => event.t === 'budgetEarned'),
    ).toHaveLength(2);

    const storedRuntime: RuntimeState = structuredClone(
      h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    const restarted: Harness = makeEngine({
      bankMs: bankWrites.at(-1)?.balanceMs ?? 0,
      runtime: storedRuntime,
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0.5 } },
    });
    restarted.setNow(T0 + 2_000);
    await restarted.engine.snapshotPersisted();
    expect(restarted.engine.snapshot().bankMs).toBe(1_000);
  });

  it('keeps a synced bank revision while an accrual event append is blocked', async () => {
    const h: Harness = makeEngine({
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0.5 } },
    });
    await h.engine.startSession(manualConfig);
    h.ports.appendEvents.mockClear();
    h.ports.queueSync.mockClear();
    let releaseFirstAppend: () => void = (): void => {
      throw new Error('first append did not start');
    };
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releaseFirstAppend = resolve;
        }),
    );
    h.setNow(T0 + 1_000);
    const accrual: Promise<SessionSnapshot> = h.engine.snapshotPersisted();
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalledTimes(1));

    const synced: Promise<Ack> = h.engine.applySyncedBank({ balanceMs: 250 });
    releaseFirstAppend();
    await Promise.all([accrual, synced]);

    const bankWrites: Array<{ balanceMs: number }> = h.ports.queueSync.mock.calls
      .filter((call: unknown[]): boolean => call[0] === SYNC_BANK)
      .map((call: unknown[]): { balanceMs: number } => call[1] as { balanceMs: number });
    expect(bankWrites.at(-1)?.balanceMs).toBe(250);
    const storedRuntime: RuntimeState = structuredClone(
      h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    const restarted: Harness = makeEngine({
      bankMs: bankWrites.at(-1)?.balanceMs ?? 0,
      runtime: storedRuntime,
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0.5 } },
    });
    restarted.setNow(T0 + 1_000);
    expect(restarted.engine.snapshot().bankMs).toBe(250);
  });

  it('does not lose a cross-queue attempt when event-log writes finish out of order', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    h.ports.appendEvents.mockReset();
    h.ports.appendEvents.mockImplementation(appendEvents);
    h.ports.saveRuntime.mockClear();

    const localState: Record<string, unknown> = { [LOCAL_EVENTS]: [] };
    let releaseFirstSet: () => void = (): void => {
      throw new Error('first event-log write did not start');
    };
    let signalFirstSet: () => void = (): void => {
      throw new Error('first event-log signal was not initialized');
    };
    const firstSetStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalFirstSet = resolve;
    });
    let signalSecondSet: () => void = (): void => {
      throw new Error('second event-log signal was not initialized');
    };
    const secondSetCompleted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalSecondSet = resolve;
    });
    const getLocal = vi.fn(
      async (): Promise<Record<string, unknown>> => structuredClone(localState),
    );
    let setCalls: number = 0;
    const setLocal = vi.fn(async (items: Record<string, unknown>): Promise<void> => {
      setCalls += 1;
      if (setCalls === 1) {
        signalFirstSet();
        await new Promise<void>((resolve: () => void): void => {
          releaseFirstSet = resolve;
        });
        Object.assign(localState, structuredClone(items));
        return;
      }
      Object.assign(localState, structuredClone(items));
      signalSecondSet();
    });
    vi.stubGlobal('chrome', { storage: { local: { get: getLocal, set: setLocal } } });

    const sweepLease: BlockingSweepLease = {} as BlockingSweepLease;
    const activeLeases: Set<BlockingSweepLease> = Reflect.get(
      h.engine,
      'activeRuntimeMutationLeases',
    ) as Set<BlockingSweepLease>;
    activeLeases.add(sweepLease);
    const first: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/first',
      7,
      'existing',
      sweepLease,
    );
    await firstSetStarted;

    activeLeases.delete(sweepLease);
    const second: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/second',
      8,
      'navigation',
    );
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalledTimes(2));

    if (getLocal.mock.calls.length === 2) await secondSetCompleted;
    releaseFirstSet();
    await Promise.all([first, second]);

    const attempts: EventRecord[] = (await readEvents()).filter(
      (event: EventRecord): boolean => event.t === 'attempt',
    );
    expect(attempts.map((event: EventRecord): string => ('url' in event ? event.url : ''))).toEqual(
      ['https://facebook.com/first', 'https://facebook.com/second'],
    );
    const storedRuntime: RuntimeState = structuredClone(
      h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    expect(storedRuntime.commitCheckpoint).toBeNull();
    const restarted: Harness = makeEngine({ runtime: storedRuntime });
    expect(restarted.engine.snapshot().attemptsToday).toBe(2);
  });

  it('keeps cross-queue attempt revisions when the first event append is blocked', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    h.ports.appendEvents.mockClear();
    const durableEvents: EventRecord[] = [];
    let releaseFirstAppend: () => void = (): void => {
      throw new Error('first append did not start');
    };
    let signalSecondAppend: () => void = (): void => {
      throw new Error('second append signal was not initialized');
    };
    const secondAppendStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signalSecondAppend = resolve;
    });
    h.ports.appendEvents.mockImplementationOnce(async (events: EventRecord[]): Promise<void> => {
      await new Promise<void>((resolve: () => void): void => {
        releaseFirstAppend = resolve;
      });
      appendUnique(durableEvents, events);
    });
    h.ports.appendEvents.mockImplementation(async (events: EventRecord[]): Promise<void> => {
      signalSecondAppend();
      appendUnique(durableEvents, events);
    });

    const sweepLease: BlockingSweepLease = {} as BlockingSweepLease;
    const activeLeases: Set<BlockingSweepLease> = Reflect.get(
      h.engine,
      'activeRuntimeMutationLeases',
    ) as Set<BlockingSweepLease>;
    activeLeases.add(sweepLease);
    const first: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/first',
      7,
      'existing',
      sweepLease,
    );
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalledTimes(1));

    activeLeases.delete(sweepLease);
    const second: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/second',
      8,
      'navigation',
    );
    const firstQueueResult: 'first-completed' | 'second-started' = await Promise.race([
      first.then((): 'first-completed' => 'first-completed'),
      secondAppendStarted.then((): 'second-started' => 'second-started'),
    ]);
    expect(firstQueueResult).toBe('second-started');
    releaseFirstAppend();
    await Promise.all([first, second]);

    expect(
      durableEvents.filter((event: EventRecord): boolean => event.t === 'attempt'),
    ).toHaveLength(2);
    const storedRuntime: RuntimeState = structuredClone(
      h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    const restarted: Harness = makeEngine({ runtime: storedRuntime });
    expect(restarted.engine.snapshot().attemptsToday).toBe(2);
  });

  it('does not overwrite a durable tab mutation when checkpoint cleanup finishes', async () => {
    const h: Harness = makeEngine();
    let releaseEvents: () => void = (): void => {
      throw new Error('event persistence did not start');
    };
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releaseEvents = resolve;
        }),
    );

    const starting: Promise<Ack> = h.engine.startSession(manualConfig);
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalledTimes(1));
    await h.engine.markStopped(7, 'https://facebook.com/feed', 'durable-document');
    releaseEvents();
    await starting;

    const storedRuntime: RuntimeState = structuredClone(
      h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    const restarted: Harness = makeEngine({
      runtime: migrateRuntimeRules(mergeRuntime(storedRuntime, T0), ENGINE_LISTS),
    });
    expect(
      restarted.engine.tabFacts(7, 'https://facebook.com/feed', 'durable-document').wasStopped,
    ).toBe(true);
    await restarted.engine.snapshotPersisted();
    expect(restarted.ports.saveRuntime.mock.calls.at(-1)?.[0]).toMatchObject({
      tabStates: { 7: { stoppedDocumentId: 'durable-document' } },
      commitCheckpoint: null,
    });
  });

  it('does not persist an unowned accrual through a concurrent tab mutation', async () => {
    const h: Harness = makeEngine({
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0.5 } },
    });
    await h.engine.startSession(manualConfig);
    h.ports.appendEvents.mockClear();
    let releaseEvents: () => void = (): void => {
      throw new Error('event persistence did not start');
    };
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releaseEvents = resolve;
        }),
    );

    h.setNow(T0 + 1_000);
    const first: Promise<SessionSnapshot> = h.engine.snapshotPersisted();
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalledTimes(1));
    h.setNow(T0 + 2_000);
    const second: Promise<SessionSnapshot> = h.engine.snapshotPersisted();
    await h.engine.markStopped(7, 'https://facebook.com/feed', 'durable-document');

    const crashRuntime: RuntimeState = structuredClone(
      h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
    );
    const restarted: Harness = makeEngine({
      runtime: migrateRuntimeRules(mergeRuntime(crashRuntime, T0 + 2_000), ENGINE_LISTS),
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0.5 } },
    });
    restarted.setNow(T0 + 2_000);
    expect((await restarted.engine.snapshotPersisted()).bankMs).toBe(1_000);
    expect(
      restarted.engine.tabFacts(7, 'https://facebook.com/feed', 'durable-document').wasStopped,
    ).toBe(true);

    releaseEvents();
    await Promise.all([first, second]);
  });

  it('does not restore bank data from a checkpoint that does not own a bank write', async () => {
    const runtime: RuntimeState = emptyRuntime(T0);
    runtime.commitCheckpoint = {
      bank: { balanceMs: 100 },
      events: [],
      syncBank: false,
    };

    const h: Harness = makeEngine({ bankMs: 900, runtime });
    expect(h.engine.snapshot().bankMs).toBe(900);
    await h.engine.snapshotPersisted();
    expect(h.engine.snapshot().bankMs).toBe(900);
  });

  it('restores and advances a resumed phase whose original boundary has passed', async () => {
    const config: SessionConfig = {
      ...manualConfig,
      cycling: { focusMin: 5, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
    };
    const started = startSession(config, T0, 'resumed-session');
    const paused = beginPause(started, T0 + 4 * 60_000, 5 * 60_000);
    const resumed = endPauseEarly(paused, T0 + 6 * 60_000);
    expect(resumed.phaseStartedAt).toBeGreaterThan(resumed.phaseEndsAt);
    const runtime: RuntimeState = migrateRuntimeRules(
      mergeRuntime(
        {
          ...emptyRuntime(T0 + 6 * 60_000),
          session: resumed,
          accruedFocusMs: resumed.focusedMs,
        },
        T0 + 6 * 60_000,
      ),
      ENGINE_LISTS,
    );

    const h: Harness = makeEngine({ runtime });
    h.setNow(T0 + 6 * 60_000);
    expect((await h.engine.snapshotPersisted()).phase).toBe('break');
  });

  it('credits only focus time across a cycling phase boundary', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession({
      ...manualConfig,
      durationMin: 20,
      cycling: { focusMin: 5, shortBreakMin: 5, longBreakMin: 5, longEvery: 4 },
    });

    h.setNow(T0 + 4 * 60_000);
    expect(h.engine.snapshot().bankMs).toBeCloseTo(
      4 * 60_000 * DEFAULT_SETTINGS.pause.earnRatio,
      3,
    );
    h.setNow(T0 + 6 * 60_000);
    expect(h.engine.snapshot().bankMs).toBeCloseTo(
      5 * 60_000 * DEFAULT_SETTINGS.pause.earnRatio,
      3,
    );
    h.setNow(T0 + 11 * 60_000);
    expect(h.engine.snapshot().bankMs).toBeCloseTo(
      6 * 60_000 * DEFAULT_SETTINGS.pause.earnRatio,
      3,
    );
  });

  it('records in-progress focus when a friction session is canceled', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    await h.engine.openGate('cancel', null);
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs);

    const ack = await h.engine.confirmGate(null);

    expect(ack).toEqual({ ok: true });
    const canceled: EventRecord | undefined = h
      .loggedEvents()
      .find((event: EventRecord): boolean => event.t === 'sessionCanceled');
    expect(canceled).toMatchObject({
      t: 'sessionCanceled',
      focusedMs: DEFAULT_SETTINGS.gate.delayMs,
    });
  });

  it('splits focus and closes every missed day after a multi-day wake', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession({ ...manualConfig, durationMin: 3 * 24 * 60 });
    const firstMidnight: number = new Date(2026, 7, 30, 0, 0).getTime();
    h.setNow(new Date(2026, 7, 31, 1, 0).getTime());

    await h.engine.tick();

    expect(h.ports.queueSync).toHaveBeenCalledWith(
      `agg:dev-test:${localDateStr(T0)}`,
      expect.objectContaining({ focusMs: firstMidnight - T0 }),
    );
    expect(h.ports.queueSync).toHaveBeenCalledWith(
      `agg:dev-test:${localDateStr(firstMidnight)}`,
      expect.objectContaining({ focusMs: DAY_MS }),
    );
    expect(h.engine.getStreak()).toMatchObject({ current: 2 });
  });

  it('does not regress a newer synced streak while replaying stale runtime dates', async (): Promise<void> => {
    const staleRuntime: RuntimeState = emptyRuntime(new Date(2026, 7, 20, 12, 0).getTime());
    const syncedStreak: StreakState = {
      current: 12,
      freezeTokens: 2,
      lastCountedDate: '2026-08-27',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [23, 24, 25, 26, 27],
      activeMonth: '2026-08',
    };
    const h: Harness = makeEngine({ runtime: staleRuntime, streak: syncedStreak });
    h.setNow(new Date(2026, 7, 28, 12, 0).getTime());

    await h.engine.tick();

    expect(h.engine.getStreak()).toEqual(syncedStreak);
  });

  it('quarantines a future local aggregate and removes its daily key', async () => {
    const runtime: RuntimeState = emptyRuntime(T0);
    const futureDate: string = localDateStr(T0 + 3 * DAY_MS);
    const futureAgg: DailyAgg = {
      date: futureDate,
      focusMs: 60_000,
      sessionsStarted: 1,
      sessionsCompleted: 0,
      attempts: { 'x.com': 2 },
      attemptsOther: 0,
      pausesTaken: 0,
      pauseMsSpent: 0,
      pauseMsEarned: 0,
      unlocksTaken: 0,
      unlockMsSpent: 0,
      resisted: 0,
    };
    runtime.date = futureDate;
    runtime.todayAgg = futureAgg;
    const futureStreak: StreakState = {
      current: 2,
      freezeTokens: 1,
      lastCountedDate: futureDate,
      lastFreezeGrantDate: null,
      activeDays: [1, 2],
      activeMonth: futureDate.slice(0, 7),
    };
    const h: Harness = makeEngine({ runtime, streak: futureStreak });

    await h.engine.tick();
    const overlay = h.engine.statsOverlay();

    expect(overlay.todayAgg.date).toBe(localDateStr(T0));
    expect(overlay.todayAgg.focusMs).toBe(0);
    expect(h.ports.removeSync).toHaveBeenCalledWith(`agg:dev-test:${futureDate}`);
    expect(h.ports.queueSync).not.toHaveBeenCalledWith(
      `agg:dev-test:${futureDate}`,
      expect.anything(),
    );
    expect(h.ports.queueSync).toHaveBeenCalledWith(
      clockRebaseArchiveKey('dev-test', futureDate, T0, 'archive-id'),
      futureAgg,
    );
    expect(h.ports.queueSync).not.toHaveBeenCalledWith(
      `agg:dev-test:${localDateStr(T0)}`,
      expect.anything(),
    );
    expect(h.ports.queueSync).toHaveBeenCalledWith('streak', {
      ...futureStreak,
      current: 0,
      lastCountedDate: null,
      activeDays: [],
      activeMonth: localDateStr(T0).slice(0, 7),
    });
  });

  it('makes a backward-date archive durable before removing the future daily', async (): Promise<void> => {
    const runtime: RuntimeState = emptyRuntime(T0);
    const futureDate: string = localDateStr(T0 + 3 * DAY_MS);
    runtime.date = futureDate;
    runtime.todayAgg = {
      date: futureDate,
      focusMs: 60_000,
      sessionsStarted: 1,
      sessionsCompleted: 0,
      attempts: {},
      attemptsOther: 0,
      pausesTaken: 0,
      pauseMsSpent: 0,
      pauseMsEarned: 0,
      unlocksTaken: 0,
      unlockMsSpent: 0,
      resisted: 0,
    };
    const trace: string[] = [];
    const h: Harness = makeEngine({
      runtime,
      saveAggregate: async (key: string): Promise<void> => {
        trace.push(`set:${key}`);
      },
      removeAggregate: async (key: string): Promise<void> => {
        trace.push(`remove:${key}`);
      },
    });

    await h.engine.tick();

    expect(trace).toEqual([
      `set:${clockRebaseArchiveKey('dev-test', futureDate, T0, 'archive-id')}`,
      `remove:${syncAggKey('dev-test', futureDate)}`,
    ]);
  });

  it('caps a backward-date archive before checkpoint and storage persistence', async (): Promise<void> => {
    const futureDate: string = localDateStr(T0 + 3 * DAY_MS);
    const runtime: RuntimeState = {
      ...emptyRuntime(T0),
      date: futureDate,
      todayAgg: highCardinalityDaily(futureDate, 30),
    };
    const saveAggregate = vi
      .fn<NonNullable<EnginePorts['saveAggregate']>>()
      .mockRejectedValue(new Error('archive persistence interrupted'));
    const h: Harness = makeEngine({ runtime, saveAggregate });

    await expect(h.engine.tick()).rejects.toThrow('archive persistence interrupted');

    const archive = saveAggregate.mock.calls.find(([key]: [string, DailyAgg]): boolean =>
      key.startsWith('archive:clock-rebase:'),
    )?.[1];
    expect(Object.keys(archive?.attempts ?? {})).toHaveLength(TOP_SITES_DAILY);
    expect(archive?.attemptsOther).toBe(55);
    const checkpointRuntime = h.ports.saveRuntime.mock.calls.find(
      (call: unknown[]): boolean => (call[0] as RuntimeState).commitCheckpoint !== null,
    )?.[0] as RuntimeState;
    const checkpointArchive: DailyAgg | undefined = Object.values(
      checkpointRuntime.commitCheckpoint?.aggregateSets ?? {},
    ).find((candidate: DailyAgg): boolean => candidate.date === futureDate);
    expect(Object.keys(checkpointArchive?.attempts ?? {})).toHaveLength(TOP_SITES_DAILY);
    expect(checkpointArchive?.attemptsOther).toBe(55);
  });

  it('clears future streak markers during a same-month clock rebase', async () => {
    const runtime: RuntimeState = emptyRuntime(T0);
    const futureDate: string = localDateStr(T0 + DAY_MS);
    runtime.date = futureDate;
    const futureStreak: StreakState = {
      current: 3,
      freezeTokens: 1,
      lastCountedDate: futureDate,
      lastFreezeGrantDate: futureDate,
      activeDays: [28, 30],
      activeMonth: futureDate.slice(0, 7),
    };
    const h: Harness = makeEngine({ runtime, streak: futureStreak });

    await h.engine.tick();

    expect(h.engine.getStreak()).toEqual({
      ...futureStreak,
      current: 0,
      lastCountedDate: null,
      lastFreezeGrantDate: null,
      activeDays: [28],
    });
    expect(h.ports.queueSync).toHaveBeenCalledWith(SYNC_STREAK, h.engine.getStreak());
  });

  it('clears a pending gate when a session completes before a new session starts', async () => {
    const h: Harness = makeEngine({ bankMs: 300_000 });
    await h.engine.startSession({ ...manualConfig, durationMin: 0.1 });
    await h.engine.openGate('pause', null);
    h.setNow(T0 + 7_000);
    await h.engine.tick();

    await h.engine.startSession(manualConfig);

    expect(h.engine.snapshot().gate).toBeNull();
  });

  it('verdictFor blocks during focus, returns no-session when idle', async () => {
    const h: Harness = makeEngine();
    expect(h.engine.verdictFor('https://facebook.com/feed')).toEqual({
      blocked: false,
      reason: 'no-session',
      categoryId: null,
      matchedPattern: null,
    });
    await h.engine.startSession(manualConfig);
    expect(h.engine.verdictFor('https://facebook.com/feed').blocked).toBe(true);
    expect(h.engine.verdictFor('https://example.com/').blocked).toBe(false);
  });

  it('opens a pause gate with readyAt = now + delayMs', async () => {
    const h: Harness = makeEngine({ bankMs: 300_000 });
    await h.engine.startSession(manualConfig);
    const ack = await h.engine.openGate('pause', null);
    expect(ack).toEqual({ ok: true });
    const gate = h.engine.snapshot().gate;
    expect(gate?.readyAt).toBe(T0 + DEFAULT_SETTINGS.gate.delayMs);
    expect(gate?.requiredPhrase).toBeNull();
    expect(h.loggedEvents().some((e: EventRecord): boolean => e.t === 'gateOpened')).toBe(true);
  });

  it('ends a Flexible session immediately, persists cancellation, and clears blocking state', async () => {
    const sessionCompiler: Mock<typeof compileSessionMatcher> = vi.fn(compileSessionMatcher);
    const h: Harness = makeEngine({ bankMs: 600_000, sessionCompiler });
    await h.engine.startSession({ ...manualConfig, strictness: 'flexible' });
    expect(h.engine.verdictFor('https://facebook.com/feed').blocked).toBe(true);
    await h.engine.openGate('unlockSite', 'facebook.com');
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs);
    await h.engine.confirmGate(null);
    await h.engine.openGate('pause', null);
    expect(h.engine.snapshot()).toMatchObject({
      gate: { kind: 'pause' },
      activeUnlocks: [{ host: 'facebook.com' }],
    });
    h.ports.saveRuntime.mockClear();
    h.ports.applyBlocking.mockClear();

    expect(await h.engine.requestSessionEnd()).toEqual({ ok: true });

    expect(h.engine.snapshot()).toMatchObject({ phase: 'idle', gate: null, activeUnlocks: [] });
    expect(h.engine.verdictFor('https://facebook.com/feed').reason).toBe('no-session');
    expect(h.loggedEvents()).toContainEqual(
      expect.objectContaining({
        t: 'sessionCanceled',
        at: T0 + DEFAULT_SETTINGS.gate.delayMs,
        sessionId: 'archive-id',
      }),
    );
    expect(h.ports.saveRuntime).toHaveBeenCalled();
    expect(h.ports.applyBlocking).toHaveBeenCalledTimes(1);
    expect(sessionCompiler).toHaveBeenCalledTimes(1);

    expect(await h.engine.startSession({ ...manualConfig, strictness: 'flexible' })).toEqual({
      ok: true,
    });
    expect(sessionCompiler).toHaveBeenCalledTimes(2);
    expect(
      h.loggedEvents().filter((event: EventRecord): boolean => event.t === 'sessionCanceled'),
    ).toHaveLength(1);
  });

  it('returns the existing idle error after a Flexible session already ended', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession({ ...manualConfig, strictness: 'flexible' });
    expect(await h.engine.requestSessionEnd()).toEqual({ ok: true });
    const cancellationCount: number = h
      .loggedEvents()
      .filter((event: EventRecord): boolean => event.t === 'sessionCanceled').length;

    expect(await h.engine.requestSessionEnd()).toEqual({
      ok: false,
      error: 'no session is running',
    });
    expect(
      h.loggedEvents().filter((event: EventRecord): boolean => event.t === 'sessionCanceled'),
    ).toHaveLength(cancellationCount);
  });

  it('awaits durable cancellation persistence before acknowledging Flexible ending', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession({ ...manualConfig, strictness: 'flexible' });
    let releaseEvents: () => void = (): void => {
      throw new Error('event persistence did not start');
    };
    h.ports.appendEvents.mockClear();
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releaseEvents = resolve;
        }),
    );

    const ending: Promise<Ack> = h.engine.requestSessionEnd();
    await vi.waitFor((): void => expect(h.ports.appendEvents).toHaveBeenCalledTimes(1));
    let acknowledged = false;
    void ending.then((): void => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);

    releaseEvents();
    await expect(ending).resolves.toEqual({ ok: true });
    expect(h.ports.appendEvents.mock.calls[0]?.[0]).toContainEqual(
      expect.objectContaining({ t: 'sessionCanceled' }),
    );
  });

  it('lets natural expiry win before a repeated end request', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession({ ...manualConfig, durationMin: 0.1, strictness: 'flexible' });
    h.ports.applyBlocking.mockClear();
    h.setNow(T0 + 7_000);

    const expected: Ack = { ok: false, error: 'no session is running' };
    expect(await h.engine.requestSessionEnd()).toEqual(expected);
    expect(await h.engine.requestSessionEnd()).toEqual(expected);

    expect(
      h.loggedEvents().filter((event: EventRecord): boolean => event.t === 'sessionCompleted'),
    ).toHaveLength(1);
    expect(
      h.loggedEvents().filter((event: EventRecord): boolean => event.t === 'sessionCanceled'),
    ).toHaveLength(0);
    expect(h.ports.applyBlocking).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['flexible', 'idle', null, true],
    ['friction', 'focus', 'cancel', true],
    ['hard', 'focus', null, false],
  ] as const)(
    'keeps legacy cancel requests worker-owned for %s sessions',
    async (strictness, phase, gate, ok): Promise<void> => {
      const h: Harness = makeEngine();
      await h.engine.startSession({ ...manualConfig, strictness });

      expect((await h.engine.openGate('cancel', null)).ok).toBe(ok);
      expect(h.engine.snapshot()).toMatchObject({
        phase,
        gate: gate === null ? null : { kind: gate },
      });
    },
  );

  it('opens one stable cancel gate for repeated Friction end requests', async () => {
    const h: Harness = makeEngine({
      settings: {
        gate: { delayMs: 10_000, requireTypedPhrase: false },
      },
    });
    await h.engine.startSession(manualConfig);

    expect(await h.engine.requestSessionEnd()).toEqual({ ok: true });

    expect(h.engine.snapshot().gate).toMatchObject({
      kind: 'cancel',
      readyAt: T0 + 10_000,
      requiredPhrase: null,
    });
    const firstGate = structuredClone(h.engine.snapshot().gate);
    h.ports.applyBlocking.mockClear();
    h.setNow(T0 + 1_000);
    expect(await h.engine.requestSessionEnd()).toEqual({ ok: true });
    expect(h.engine.snapshot().gate).toEqual(firstGate);
    expect(
      h.loggedEvents().filter((event: EventRecord): boolean => event.t === 'gateOpened'),
    ).toHaveLength(1);
    expect(h.ports.applyBlocking).not.toHaveBeenCalled();
    expect(await h.engine.confirmGate(null)).toEqual({
      ok: false,
      error: 'the deliberation delay has not finished',
    });
    h.setNow(T0 + 10_000);
    expect(await h.engine.confirmGate(null)).toEqual({ ok: true });
    expect(h.engine.snapshot().gate).toBeNull();
  });

  it('keeps a zero-delay cancel gate stable while requiring the exact phrase', async (): Promise<void> => {
    const h: Harness = makeEngine({
      settings: { gate: { delayMs: 0, requireTypedPhrase: true } },
    });
    await h.engine.startSession(manualConfig);
    const requiredPhrase: string = cancelPhrase(manualConfig.intention);

    expect(await h.engine.requestSessionEnd()).toEqual({ ok: true });
    expect(h.engine.snapshot().gate).toMatchObject({
      kind: 'cancel',
      openedAt: T0,
      readyAt: T0,
      requiredPhrase,
    });
    expect(await h.engine.confirmGate(null)).toEqual({
      ok: false,
      error: 'that is not the exact phrase',
    });
    expect(await h.engine.confirmGate(requiredPhrase)).toEqual({ ok: true });
    expect(
      h.loggedEvents().filter((event: EventRecord): boolean => event.t === 'gateOpened'),
    ).toHaveLength(1);
    expect(
      h.loggedEvents().filter((event: EventRecord): boolean => event.t === 'sessionCanceled'),
    ).toHaveLength(1);
  });

  it('rejects ending a Hard session without opening or changing a gate', async () => {
    const h: Harness = makeEngine({ bankMs: 300_000 });
    await h.engine.startSession({ ...manualConfig, strictness: 'hard' });
    await h.engine.openGate('pause', null);
    const before: SessionSnapshot = h.engine.snapshot();
    h.ports.applyBlocking.mockClear();

    expect(await h.engine.requestSessionEnd()).toEqual({
      ok: false,
      error: 'hard sessions cannot be canceled',
    });
    expect(await h.engine.requestSessionEnd()).toEqual({
      ok: false,
      error: 'hard sessions cannot be canceled',
    });
    expect(h.engine.snapshot()).toMatchObject({ phase: before.phase, gate: before.gate });
    expect(h.ports.applyBlocking).not.toHaveBeenCalled();
  });

  it('persists a theme update and reapplies blocking to mounted overlays', async () => {
    const h: Harness = makeEngine();
    h.ports.applyBlocking.mockClear();

    await expect(h.engine.updateTheme('dark')).resolves.toEqual({ ok: true });

    expect(h.engine.getSettings().theme).toBe('dark');
    expect(h.engine.snapshot().theme).toBe('dark');
    expect(h.ports.queueSync).toHaveBeenCalledWith(
      SYNC_SETTINGS,
      expect.objectContaining({ theme: 'dark' }),
    );
    expect(h.ports.applyBlocking).toHaveBeenCalledTimes(1);

    h.ports.applyBlocking.mockClear();
    await expect(h.engine.updateTheme('dark')).resolves.toEqual({ ok: true });
    expect(h.ports.applyBlocking).not.toHaveBeenCalled();
  });

  it('reapplies blocking only when a full settings update changes the theme', async () => {
    const h: Harness = makeEngine();
    h.ports.applyBlocking.mockClear();

    await expect(h.engine.updateSettings({ ...DEFAULT_SETTINGS, theme: 'dark' })).resolves.toEqual({
      ok: true,
    });
    expect(h.ports.applyBlocking).toHaveBeenCalledTimes(1);

    h.ports.applyBlocking.mockClear();
    await expect(
      h.engine.updateSettings({ ...DEFAULT_SETTINGS, theme: 'dark', retentionDays: 30 }),
    ).resolves.toEqual({ ok: true });
    expect(h.ports.applyBlocking).not.toHaveBeenCalled();
  });

  it.each<GatePhraseCase>([
    { gate: 'pause', host: null, expectedPhrase: 'I am pausing blocking' },
    {
      gate: 'unlockSite',
      host: 'm.facebook.com',
      expectedPhrase: 'I am allowing this site: facebook.com',
    },
    {
      gate: 'cancel',
      host: null,
      expectedPhrase: 'I am ending this session before: write the report',
    },
  ])(
    'uses truthful action-specific copy for the $gate gate',
    async ({ gate, host, expectedPhrase }: GatePhraseCase): Promise<void> => {
      const h: Harness = makeEngine({
        bankMs: 600_000,
        settings: {
          gate: { delayMs: 10_000, requireTypedPhrase: true },
        },
      });
      await h.engine.startSession(manualConfig);
      await h.engine.openGate(gate, host);

      expect(h.engine.snapshot().gate?.requiredPhrase).toBe(expectedPhrase);
    },
  );

  it('rejects a pause gate the budget cannot afford', async () => {
    const h: Harness = makeEngine({
      bankMs: 0,
      settings: { pause: { ...DEFAULT_SETTINGS.pause } },
    });
    await h.engine.startSession(manualConfig);
    const ack = await h.engine.openGate('pause', null);
    expect(ack.ok).toBe(false);
  });

  it('rejects confirmGate before readyAt, accepts after, spends and pauses', async () => {
    const h: Harness = makeEngine({
      bankMs: 300_000,
      settings: {
        gate: { ...DEFAULT_SETTINGS.gate, requireTypedPhrase: true },
        pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0 },
      },
    });
    await h.engine.startSession(manualConfig);
    await h.engine.openGate('pause', null);
    const early = await h.engine.confirmGate(null);
    expect(early.ok).toBe(false);
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs);
    const ack = await h.engine.confirmGate('I am pausing blocking');
    expect(ack).toEqual({ ok: true });
    const snap = h.engine.snapshot();
    expect(snap.phase).toBe('paused');
    expect(snap.bankMs).toBe(300_000 - DEFAULT_SETTINGS.pause.pauseMs);
    expect(h.loggedEvents().some((e: EventRecord): boolean => e.t === 'pauseTaken')).toBe(true);
  });

  it('records exact pause and unlock spending against the active session', async () => {
    const h: Harness = makeEngine({
      bankMs: 600_000,
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0 } },
    });
    await h.engine.startSession(manualConfig);
    await h.engine.openGate('pause', null);
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs);
    await h.engine.confirmGate(null);
    await h.engine.resumeFromPause();
    await h.engine.openGate('unlockSite', 'facebook.com');
    h.setNow(T0 + 2 * DEFAULT_SETTINGS.gate.delayMs);
    await h.engine.confirmGate(null);

    expect(h.loggedEvents()).toContainEqual(
      expect.objectContaining({
        t: 'pauseTaken',
        ms: DEFAULT_SETTINGS.pause.pauseMs,
        sessionId: 'archive-id',
      }),
    );
    expect(h.loggedEvents()).toContainEqual(
      expect.objectContaining({
        t: 'unlockTaken',
        ms: DEFAULT_SETTINGS.pause.unlockMs,
        sessionId: 'archive-id',
      }),
    );
    expect(h.engine.statsOverlay().todayAgg).toMatchObject({
      pauseMsSpent: DEFAULT_SETTINGS.pause.pauseMs,
      unlockMsSpent: DEFAULT_SETTINGS.pause.unlockMs,
    });
  });

  it.each([
    ['pause', 'pauseTaken'],
    ['unlockSite', 'unlockTaken'],
  ] as const)(
    'recovers one %s spend after runtime cleanup persistence fails and the worker restarts',
    async (gate: 'pause' | 'unlockSite', eventType: 'pauseTaken' | 'unlockTaken') => {
      const initialBankMs: number = 600_000;
      const h: Harness = makeEngine({
        bankMs: initialBankMs,
        settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0 } },
      });
      await h.engine.startSession(manualConfig);
      await h.engine.openGate(gate, gate === 'unlockSite' ? 'facebook.com' : null);
      let storedRuntime: RuntimeState = structuredClone(
        h.ports.saveRuntime.mock.calls.at(-1)?.[0] as RuntimeState,
      );
      let durableBankMs: number = initialBankMs;
      const durableEvents: EventRecord[] = [];
      h.ports.queueSync.mockImplementation((key: string, value: unknown): void => {
        if (key === SYNC_BANK) durableBankMs = (value as { balanceMs: number }).balanceMs;
      });
      h.ports.appendEvents.mockImplementation(async (events: EventRecord[]): Promise<void> => {
        appendUnique(durableEvents, events);
      });
      h.ports.saveRuntime.mockImplementation(async (runtime: RuntimeState): Promise<void> => {
        if (!hasCommitCheckpoint(runtime)) throw new Error('runtime cleanup failed');
        storedRuntime = structuredClone(runtime);
      });
      h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs);

      await expect(h.engine.confirmGate(null)).rejects.toThrow('runtime cleanup failed');

      const restarted: Harness = makeEngine({
        bankMs: durableBankMs,
        runtime: storedRuntime,
        settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0 } },
        queueSync: (key: string, value: unknown): void => {
          if (key === SYNC_BANK) durableBankMs = (value as { balanceMs: number }).balanceMs;
        },
      });
      restarted.ports.appendEvents.mockImplementation(
        async (events: EventRecord[]): Promise<void> => appendUnique(durableEvents, events),
      );
      restarted.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs);
      if (storedRuntime.gate === null) await restarted.engine.snapshotPersisted();
      else await restarted.engine.confirmGate(null);

      expect(restarted.engine.snapshot().bankMs).toBe(
        initialBankMs - DEFAULT_SETTINGS.pause.pauseMs,
      );
      expect(
        durableEvents.filter((event: EventRecord): boolean => event.t === eventType),
      ).toHaveLength(1);
    },
  );

  it('abandonGate clears the gate and logs resisted', async () => {
    const h: Harness = makeEngine({ bankMs: 300_000 });
    await h.engine.startSession(manualConfig);
    await h.engine.openGate('pause', null);
    const ack = await h.engine.abandonGate();
    expect(ack).toEqual({ ok: true });
    expect(h.engine.snapshot().gate).toBeNull();
    expect(h.loggedEvents().some((e: EventRecord): boolean => e.t === 'gateResisted')).toBe(true);
    expect(h.engine.statsOverlay().todayAgg.resisted).toBe(1);
  });

  it('tick closes an expired gate as resisted', async () => {
    const h: Harness = makeEngine({ bankMs: 300_000 });
    await h.engine.startSession(manualConfig);
    await h.engine.openGate('pause', null);
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs + GATE_EXPIRY_MS + 1);
    await h.engine.tick();
    expect(h.engine.snapshot().gate).toBeNull();
    expect(h.loggedEvents().some((e: EventRecord): boolean => e.t === 'gateResisted')).toBe(true);
  });

  it('cancel gate demands the exact phrase and ends the session', async () => {
    const h: Harness = makeEngine({
      settings: { gate: { ...DEFAULT_SETTINGS.gate, requireTypedPhrase: true } },
    });
    await h.engine.startSession(manualConfig);
    const opened = await h.engine.openGate('cancel', null);
    expect(opened).toEqual({ ok: true });
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs);
    const wrong = await h.engine.confirmGate('let me out');
    expect(wrong.ok).toBe(false);
    const right = await h.engine.confirmGate('I am ending this session before: write the report');
    expect(right).toEqual({ ok: true });
    expect(h.engine.snapshot().phase).toBe('idle');
    expect(h.loggedEvents().some((e: EventRecord): boolean => e.t === 'sessionCanceled')).toBe(
      true,
    );
  });

  it('rejects the cancel gate during a hard session', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession({ ...manualConfig, strictness: 'hard' });
    const ack = await h.engine.openGate('cancel', null);
    expect(ack.ok).toBe(false);
  });

  it('unlockSite adds a SiteUnlock that verdictFor honors until expiry', async () => {
    const h: Harness = makeEngine({
      bankMs: 300_000,
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0 } },
    });
    await h.engine.startSession(manualConfig);
    expect(h.engine.verdictFor('https://facebook.com/feed').blocked).toBe(true);
    await h.engine.openGate('unlockSite', 'facebook.com');
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs);
    const ack = await h.engine.confirmGate(null);
    expect(ack).toEqual({ ok: true });
    expect(h.engine.verdictFor('https://facebook.com/feed').blocked).toBe(false);
    expect(h.engine.snapshot().activeUnlocks).toEqual([
      {
        host: 'facebook.com',
        until: T0 + DEFAULT_SETTINGS.gate.delayMs + DEFAULT_SETTINGS.pause.unlockMs,
      },
    ]);
    expect(h.ports.scheduleWake).toHaveBeenLastCalledWith(
      T0 + DEFAULT_SETTINGS.gate.delayMs + DEFAULT_SETTINGS.pause.unlockMs,
    );
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs + DEFAULT_SETTINGS.pause.unlockMs + 1);
    expect(h.engine.verdictFor('https://facebook.com/feed').blocked).toBe(true);
  });

  it('normalizes a site unlock to its registrable host', async () => {
    const h: Harness = makeEngine({
      bankMs: 300_000,
      settings: {
        gate: { ...DEFAULT_SETTINGS.gate, requireTypedPhrase: true },
        pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0 },
      },
    });
    await h.engine.startSession(manualConfig);
    await h.engine.openGate('unlockSite', 'm.facebook.com');
    expect(h.engine.snapshot().gate?.requiredPhrase).toBe('I am allowing this site: facebook.com');
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs);
    await h.engine.confirmGate('I am allowing this site: facebook.com');

    expect(h.engine.snapshot().activeUnlocks[0]?.host).toBe('facebook.com');
    expect(h.engine.verdictFor('https://www.facebook.com/feed').blocked).toBe(false);
  });

  it('completes the session on tick past sessionEndsAt with sound and notification', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    h.setNow(T0 + 25 * 60_000 + 1);
    await h.engine.tick();
    expect(h.engine.snapshot().phase).toBe('idle');
    expect(h.ports.playSound).toHaveBeenCalledWith('sessionComplete');
    expect(h.ports.notify).toHaveBeenCalled();
    expect(h.loggedEvents().some((e: EventRecord): boolean => e.t === 'sessionCompleted')).toBe(
      true,
    );
  });

  it('suppresses only the optional session-complete notification', async () => {
    const h: Harness = makeEngine({
      settings: { sessionCompleteNotification: false } as Partial<Settings>,
    });
    await h.engine.startSession(manualConfig);
    h.setNow(T0 + 25 * 60_000 + 1);

    await h.engine.tick();

    expect(h.ports.playSound).toHaveBeenCalledWith('sessionComplete');
    expect(h.ports.notify).not.toHaveBeenCalledWith(
      'Focus session complete',
      'The lock is off. Time for a real break.',
    );
  });

  it('keeps schedule-start notifications unconditional', () => {
    const h: Harness = makeEngine({
      settings: {
        schedule: [scheduledEntry],
        sessionCompleteNotification: false,
      } as Partial<Settings>,
    });
    h.setNow(T0 + 16 * 60_000);

    h.engine.snapshot();

    expect(h.ports.notify).toHaveBeenCalledWith('Focus schedule started', 'Locked until 10:00.');
  });

  it('resumeFromPause restores focus', async () => {
    const h: Harness = makeEngine({
      bankMs: 300_000,
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0 } },
    });
    await h.engine.startSession(manualConfig);
    await h.engine.openGate('pause', null);
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs);
    await h.engine.confirmGate(null);
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs + 60_000);
    const ack = await h.engine.resumeFromPause();
    expect(ack).toEqual({ ok: true });
    expect(h.engine.snapshot().phase).toBe('focus');
  });

  it('wakes at the session end when a pause would outlive it', async () => {
    const h: Harness = makeEngine({
      bankMs: 300_000,
      settings: { pause: { ...DEFAULT_SETTINGS.pause, earnRatio: 0 } },
    });
    const durationMin: number = 1;
    await h.engine.startSession({ ...manualConfig, durationMin });
    await h.engine.openGate('pause', null);
    h.setNow(T0 + DEFAULT_SETTINGS.gate.delayMs);

    await h.engine.confirmGate(null);

    expect(h.engine.snapshot().phase).toBe('paused');
    expect(h.ports.scheduleWake).toHaveBeenLastCalledWith(T0 + durationMin * 60_000);
  });

  it('recordAttempt debounces the same tab and url within 30 s', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    await h.engine.recordAttempt('https://facebook.com/feed', 7, 'navigation');
    await h.engine.recordAttempt('https://facebook.com/feed', 7, 'navigation');
    const attempts: EventRecord[] = h
      .loggedEvents()
      .filter((e: EventRecord): boolean => e.t === 'attempt');
    expect(attempts).toHaveLength(1);
    expect(h.engine.snapshot().attemptsToday).toBe(1);
  });

  it('keeps a debounced caller behind the matching in-flight attempt persistence', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    let releasePersistence: () => void = (): void => {
      throw new Error('attempt persistence did not start');
    };
    let signalPersistence: () => void = (): void => {
      throw new Error('attempt persistence signal was not initialized');
    };
    const persistenceStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalPersistence = resolve;
    });
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releasePersistence = resolve;
          signalPersistence();
        }),
    );

    const first: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/feed',
      7,
      'navigation',
    );
    await persistenceStarted;
    let secondResolved = false;
    const second: Promise<void> = h.engine
      .recordAttempt('https://facebook.com/feed', 7, 'existing')
      .then((): void => {
        secondResolved = true;
      });
    await Promise.resolve();

    expect(secondResolved).toBe(false);
    releasePersistence();
    await Promise.all([first, second]);
  });

  it('does not strand overlapping same-key persistence after the debounce window', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    let releasePersistence: () => void = (): void => {
      throw new Error('attempt persistence did not start');
    };
    let signalPersistence: () => void = (): void => {
      throw new Error('attempt persistence signal was not initialized');
    };
    const persistenceStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalPersistence = resolve;
    });
    h.ports.appendEvents.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((resolve: () => void): void => {
          releasePersistence = resolve;
          signalPersistence();
        }),
    );

    const first: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/feed',
      7,
      'navigation',
    );
    await persistenceStarted;
    h.setNow(T0 + 31_000);
    const second: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/feed',
      7,
      'existing',
    );
    releasePersistence();

    await Promise.all([first, second]);
  });

  it('reports a commit rejection once after attempt persistence becomes durable', async () => {
    const h: Harness = makeEngine();
    const applyError = new Error('blocking sweep failed after persistence');
    let rejectApply: (error: unknown) => void = (): void => {
      throw new Error('apply rejection was not initialized');
    };
    let signalApplyStarted: () => void = (): void => {
      throw new Error('apply start signal was not initialized');
    };
    const applyStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalApplyStarted = resolve;
    });
    h.ports.applyBlocking.mockImplementationOnce(
      (): Promise<void> =>
        new Promise((_resolve: () => void, reject: (error: unknown) => void): void => {
          rejectApply = reject;
          signalApplyStarted();
        }),
    );
    Reflect.set(h.engine, 'needsBlocking', true);

    const attempt: Promise<void> = h.engine.recordAttempt(
      'https://facebook.com/feed',
      7,
      'navigation',
    );
    await applyStarted;
    await expect(attempt).resolves.toBeUndefined();

    rejectApply(applyError);
    await vi.waitFor((): void => {
      expect(h.ports.reportError).toHaveBeenCalledWith(applyError);
    });
    expect(h.ports.reportError).toHaveBeenCalledTimes(1);
  });

  it('retries failed same-key attempt persistence inside the debounce window', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    h.ports.appendEvents.mockClear();
    h.ports.appendEvents.mockRejectedValueOnce(new Error('event storage unavailable'));

    await expect(
      h.engine.recordAttempt('https://facebook.com/feed', 7, 'navigation'),
    ).rejects.toThrow('event storage unavailable');
    await expect(
      h.engine.recordAttempt('https://facebook.com/feed', 7, 'existing'),
    ).resolves.toBeUndefined();

    expect(h.ports.appendEvents).toHaveBeenCalledTimes(2);
    const retriedEvents: EventRecord[] = h.ports.appendEvents.mock.calls[1]?.[0] ?? [];
    expect(
      retriedEvents.filter((event: EventRecord): boolean => event.t === 'attempt'),
    ).toHaveLength(1);
    expect(h.engine.snapshot().attemptsToday).toBe(1);
  });

  it('counts a new same-key attempt after failed persistence debounce expires', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    h.ports.appendEvents.mockClear();
    h.ports.appendEvents.mockRejectedValueOnce(new Error('event storage unavailable'));

    await expect(
      h.engine.recordAttempt('https://facebook.com/feed', 7, 'navigation'),
    ).rejects.toThrow('event storage unavailable');
    h.setNow(T0 + 31_000);
    await h.engine.recordAttempt('https://facebook.com/feed', 7, 'existing');

    expect(h.ports.appendEvents).toHaveBeenCalledTimes(2);
    const retriedEvents: EventRecord[] = h.ports.appendEvents.mock.calls[1]?.[0] ?? [];
    expect(
      retriedEvents.filter((event: EventRecord): boolean => event.t === 'attempt'),
    ).toHaveLength(2);
    expect(h.engine.snapshot().attemptsToday).toBe(2);
  });

  it('prunes absent tab records while preserving live restore state', async () => {
    const h: Harness = makeEngine();
    await h.engine.claimMute(7, 'https://kept.example', true);
    await h.engine.claimMute(8, 'https://missing.example', false);
    await h.engine.markStopped(7, 'https://kept.example', 'kept-document');
    await h.engine.markStopped(9, 'https://missing.example', 'missing-document');

    h.engine.reconcileTabs(
      new Map([
        [
          7,
          {
            url: 'https://kept.example',
            mutedByExtension: true,
            documentId: 'kept-document',
          },
        ],
      ]),
    );

    expect(h.engine.tabFacts(7, 'https://kept.example', 'kept-document')).toEqual({
      wasMutedByUs: true,
      priorMuted: true,
      wasStopped: true,
    });
    expect(h.engine.tabFacts(8, 'https://missing.example')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
    expect(h.engine.tabFacts(9, 'https://missing.example')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('persists mute ownership before resolving the claim and persists release', async () => {
    const h: Harness = makeEngine();
    let releaseSave: () => void = (): void => {};
    let signalSave: () => void = (): void => {};
    const saveBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseSave = resolve;
    });
    const saveStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalSave = resolve;
    });
    h.ports.saveRuntime.mockImplementationOnce((runtime: RuntimeState): Promise<void> => {
      expect(runtime.tabStates[7]).toEqual({
        muteUrl: 'https://blocked.example/page',
        priorMuted: false,
        stoppedDocumentId: null,
      });
      signalSave();
      return saveBlocked;
    });
    let claimed: boolean = false;

    const pendingClaim: Promise<void> = h.engine
      .claimMute(7, 'https://blocked.example/page', false)
      .then((result: boolean): void => {
        claimed = result;
      });
    const firstCompletion: 'save' | 'claim' = await Promise.race([
      saveStarted.then((): 'save' => 'save'),
      pendingClaim.then((): 'claim' => 'claim'),
    ]);

    expect(firstCompletion).toBe('save');
    expect(claimed).toBe(false);
    releaseSave();
    await pendingClaim;
    expect(claimed).toBe(true);

    h.ports.saveRuntime.mockClear();
    await h.engine.releaseMuteClaim(7, 'https://blocked.example/page');
    expect(h.ports.saveRuntime).toHaveBeenCalledWith(expect.objectContaining({ tabStates: {} }));
  });

  it('drops persisted tab state when a reused id has a different URL', async () => {
    const h: Harness = makeEngine();
    await h.engine.markStopped(7, 'https://blocked.example/old');
    await h.engine.claimMute(7, 'https://blocked.example/old', false);

    h.engine.reconcileTabs(
      new Map([[7, { url: 'https://allowed.example/new', mutedByExtension: false }]]),
    );

    expect(h.engine.tabFacts(7, 'https://allowed.example/new')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('drops same-url tab effects when the live mute is not extension-owned', async () => {
    const h: Harness = makeEngine();
    const url = 'https://blocked.example/page';
    await h.engine.markStopped(7, url);
    await h.engine.claimMute(7, url, false);

    h.engine.reconcileTabs(new Map([[7, { url, mutedByExtension: false }]]));

    expect(h.engine.tabFacts(7, url)).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('drops same-url stopped ownership when no extension mute confirms the tab', async () => {
    const h: Harness = makeEngine();
    const url = 'https://blocked.example/page';
    await h.engine.markStopped(7, url);

    h.engine.reconcileTabs(new Map([[7, { url, mutedByExtension: false }]]));

    expect(h.engine.tabFacts(7, url)).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('rebinds an extension-owned mute after navigation interrupts the mute update', async () => {
    const h: Harness = makeEngine();
    await h.engine.claimMute(7, 'https://blocked.example/old', false);

    h.engine.reconcileTabs(
      new Map([
        [
          7,
          {
            url: 'https://allowed.example/new',
            mutedByExtension: true,
          },
        ],
      ]),
    );

    expect(h.engine.tabFacts(7, 'https://allowed.example/new')).toEqual({
      wasMutedByUs: true,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('does not relabel persisted state through a direct URL mismatch', async () => {
    const h: Harness = makeEngine();
    await h.engine.markStopped(7, 'https://blocked.example/old');
    await h.engine.claimMute(7, 'https://blocked.example/old', false);

    expect(h.engine.tabFacts(7, 'https://allowed.example/new')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('rebinds a confirmed navigation while preserving its tab state', async () => {
    const h: Harness = makeEngine();
    await h.engine.markStopped(7, 'https://blocked.example/old', 'document-one');
    await h.engine.claimMute(7, 'https://blocked.example/old', false);

    h.engine.rebindTab(7, 'https://blocked.example/new');

    expect(h.engine.tabFacts(7, 'https://blocked.example/new', 'document-one')).toEqual({
      wasMutedByUs: true,
      priorMuted: false,
      wasStopped: true,
    });
  });

  it('ignores stale restore and reload completions for another URL', async () => {
    const h: Harness = makeEngine();
    await h.engine.markStopped(7, 'https://blocked.example/new', 'document-current');
    await h.engine.claimMute(7, 'https://blocked.example/new', false);

    h.engine.noteMuteRestored(7, 'https://blocked.example/old');
    h.engine.noteReloaded(7, 'document-stale');

    expect(h.engine.tabFacts(7, 'https://blocked.example/new', 'document-current')).toEqual({
      wasMutedByUs: true,
      priorMuted: false,
      wasStopped: true,
    });
  });

  it('preserves stopped-document ownership before mute ownership exists', async () => {
    const h: Harness = makeEngine();
    const url = 'https://blocked.example/page';

    await h.engine.markStopped(7, url, 'document-one');
    h.engine.reconcileTabs(
      new Map([
        [
          7,
          {
            url,
            mutedByExtension: false,
            documentId: 'document-one',
          },
        ],
      ]),
    );

    expect(h.engine.tabFacts(7, url, 'document-one')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: true,
    });
  });

  it('does not give a reused same-URL tab stopped-document ownership', async () => {
    const h: Harness = makeEngine();
    const url = 'https://blocked.example/page';

    await h.engine.markStopped(7, url, 'document-one');

    expect(h.engine.tabFacts(7, url, 'document-two')).toEqual({
      wasMutedByUs: false,
      priorMuted: false,
      wasStopped: false,
    });
  });

  it('caps the active daily attempt map before queueing sync data', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession(manualConfig);
    for (let index: number = 0; index < 25; index++) {
      await h.engine.recordAttempt(`https://site-${index}.com/feed`, index, 'existing');
    }

    const dailyWrites: unknown[][] = h.ports.queueSync.mock.calls.filter(
      (call: unknown[]): boolean => call[0] === `agg:dev-test:${localDateStr(T0)}`,
    );
    const latest = dailyWrites.at(-1)?.[1] as {
      attempts: Record<string, number>;
      attemptsOther: number;
    };
    expect(Object.keys(latest.attempts)).toHaveLength(20);
    expect(latest.attemptsOther).toBe(5);
    expect(Object.keys(h.engine.statsOverlay().todayAgg.attempts)).toHaveLength(20);
  });

  it('updateSettings rejects weakening during hard, applies otherwise', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession({ ...manualConfig, strictness: 'hard' });
    const weaker: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 1_000 },
    };
    const rejected = await h.engine.updateSettings(weaker);
    expect(rejected.ok).toBe(false);
    const stronger: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 30_000 },
    };
    const ack = await h.engine.updateSettings(stronger);
    expect(ack).toEqual({ ok: true });
    expect(h.engine.getSettings().gate.delayMs).toBe(30_000);
    expect(h.ports.queueSync).toHaveBeenCalledWith('settings', stronger);
  });

  it('does not acknowledge accepted lists before the sync journal is durable', async () => {
    let releaseJournal: () => void = (): void => {};
    let signalJournalStarted: () => void = (): void => {};
    const journalBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseJournal = resolve;
    });
    const journalStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalJournalStarted = resolve;
    });
    const h: Harness = makeEngine({
      persistSyncJournal: (): Promise<void> => {
        signalJournalStarted();
        return journalBlocked;
      },
    });
    const updatedLists = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host' as const, pattern: 'blocked.example' }],
    };
    let acknowledged: boolean = false;

    const pendingAck: Promise<void> = h.engine.updateLists(updatedLists).then((): void => {
      acknowledged = true;
    });
    const firstCompletion: 'journal' | 'ack' = await Promise.race([
      journalStarted.then((): 'journal' => 'journal'),
      pendingAck.then((): 'ack' => 'ack'),
    ]);

    expect(firstCompletion).toBe('journal');
    expect(acknowledged).toBe(false);
    releaseJournal();
    await pendingAck;
    expect(acknowledged).toBe(true);
  });

  it('journals aggregate writes discovered during the blocking sweep before acknowledgement', async () => {
    let persistCalls: number = 0;
    let releaseSecondJournal: () => void = (): void => {};
    let signalSecondJournal: () => void = (): void => {};
    const secondJournalBlocked: Promise<void> = new Promise((resolve: () => void): void => {
      releaseSecondJournal = resolve;
    });
    const secondJournalStarted: Promise<void> = new Promise((resolve: () => void): void => {
      signalSecondJournal = resolve;
    });
    const h: Harness = makeEngine({
      persistSyncJournal: (): Promise<void> => {
        persistCalls += 1;
        if (persistCalls !== 2) return Promise.resolve();
        signalSecondJournal();
        return secondJournalBlocked;
      },
    });
    h.ports.applyBlocking.mockImplementation(
      (lease: BlockingSweepLease): Promise<void> =>
        h.engine.recordAttempt('https://facebook.com/feed', 7, 'existing', lease),
    );

    const pendingAck: Promise<unknown> = h.engine.startSession(manualConfig);
    const firstCompletion: 'journal' | 'ack' = await Promise.race([
      secondJournalStarted.then((): 'journal' => 'journal'),
      pendingAck.then((): 'ack' => 'ack'),
    ]);

    expect(firstCompletion).toBe('journal');
    releaseSecondJournal();
    await pendingAck;
  });

  it('applies live sync changes without echoing and rejects hard-session weakening', async () => {
    const h: Harness = makeEngine();
    await h.engine.startSession({ ...manualConfig, strictness: 'hard' });
    h.ports.queueSync.mockClear();
    const weaker: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, delayMs: 1_000 },
    };

    const rejected = await h.engine.applySyncedSettings(weaker);
    const accepted = await h.engine.applySyncedBank({ balanceMs: 42_000 });

    expect(rejected.ok).toBe(false);
    expect(accepted).toEqual({ ok: true });
    expect(h.engine.getSettings().gate.delayMs).toBe(DEFAULT_SETTINGS.gate.delayMs);
    expect(h.engine.snapshot().bankMs).toBe(42_000);
    expect(h.ports.queueSync).not.toHaveBeenCalledWith('settings', expect.anything());
    expect(h.ports.queueSync).not.toHaveBeenCalledWith('bank', expect.anything());
  });

  it('applies newer synced streak progress and supersedes pending state', async () => {
    const local: StreakState = {
      current: 2,
      freezeTokens: 0,
      lastCountedDate: '2026-08-26',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [25, 26],
      activeMonth: '2026-08',
    };
    const remote: StreakState = {
      ...local,
      current: 3,
      lastCountedDate: '2026-08-27',
      activeDays: [25, 26, 27],
    };
    const h: Harness = makeEngine({ streak: local });

    await h.engine.applySyncedStreak(remote);

    expect(h.engine.getStreak()).toEqual(remote);
    expect(h.ports.supersedeSync).not.toHaveBeenCalled();
    expect(h.ports.queueSync).not.toHaveBeenCalled();
  });

  it('does not replace newer local streak progress with stale sync data', async () => {
    const remote: StreakState = {
      current: 2,
      freezeTokens: 0,
      lastCountedDate: '2026-08-26',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [25, 26],
      activeMonth: '2026-08',
    };
    const local: StreakState = {
      ...remote,
      current: 3,
      lastCountedDate: '2026-08-27',
      activeDays: [25, 26, 27],
    };
    const h: Harness = makeEngine({ streak: local });

    await h.engine.applySyncedStreak(remote);

    expect(h.engine.getStreak()).toEqual(local);
    expect(h.ports.queueSync).not.toHaveBeenCalled();
  });

  it('merges equal-marker streak counters and active days without regression', async () => {
    const remote: StreakState = {
      current: 3,
      freezeTokens: 2,
      lastCountedDate: '2026-08-28',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [25, 28],
      activeMonth: '2026-08',
    };
    const local: StreakState = {
      ...remote,
      current: 5,
      freezeTokens: 1,
      activeDays: [24, 25, 26, 27],
    };
    const h: Harness = makeEngine({ streak: local });

    await h.engine.applySyncedStreak(remote);

    const merged: StreakState = {
      ...remote,
      current: 5,
      freezeTokens: 2,
      activeDays: [24, 25, 26, 27, 28],
    };
    expect(h.engine.getStreak()).toEqual(merged);
    expect(h.ports.queueSync).not.toHaveBeenCalled();
  });

  it('sanitizes future remote streak markers before arbitration', async () => {
    const local: StreakState = {
      current: 0,
      freezeTokens: 1,
      lastCountedDate: null,
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [28],
      activeMonth: '2026-08',
    };
    const remote: StreakState = {
      current: 5,
      freezeTokens: 2,
      lastCountedDate: '2026-09-01',
      lastFreezeGrantDate: '2026-09-01',
      activeDays: [1],
      activeMonth: '2026-09',
    };
    const h: Harness = makeEngine({ streak: local });

    await h.engine.applySyncedStreak(remote);

    const corrected: StreakState = {
      current: 0,
      freezeTokens: 1,
      lastCountedDate: null,
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [28],
      activeMonth: '2026-08',
    };
    expect(h.engine.getStreak()).toEqual(corrected);
    expect(h.ports.queueSync).not.toHaveBeenCalled();
  });

  it('supersedes an older pending streak write with newer remote progress', async () => {
    const older: StreakState = {
      current: 2,
      freezeTokens: 0,
      lastCountedDate: '2026-08-26',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [25, 26],
      activeMonth: '2026-08',
    };
    const newer: StreakState = {
      ...older,
      current: 3,
      lastCountedDate: '2026-08-27',
      activeDays: [25, 26, 27],
    };
    const write = vi.fn().mockResolvedValue(undefined);
    const writer: SyncWriter = new SyncWriter(10_000, write);
    writer.queue(SYNC_STREAK, older);
    const h: Harness = makeEngine({
      streak: older,
      supersedeSync: (key: string, value: unknown): void => writer.supersede(key, value),
    });

    await h.engine.applySyncedStreak(newer);
    await writer.flushNow();

    expect(write).toHaveBeenCalledWith({ [SYNC_STREAK]: older });
  });

  it('does not create a sync write when no local streak is pending', async () => {
    const remote: StreakState = {
      current: 3,
      freezeTokens: 0,
      lastCountedDate: '2026-08-27',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [25, 26, 27],
      activeMonth: '2026-08',
    };
    const write = vi.fn().mockResolvedValue(undefined);
    const writer: SyncWriter = new SyncWriter(10_000, write);
    const h: Harness = makeEngine({
      supersedeSync: (key: string, value: unknown): void => writer.supersede(key, value),
    });

    await h.engine.applySyncedStreak(remote);
    await writer.flushNow();

    expect(write).not.toHaveBeenCalled();
  });
});
