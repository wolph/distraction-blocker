import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRequest } from '../../../src/background/request-validation';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  emptySnapshot,
  policyRevision,
  rulesFromLists,
} from '../../../src/shared/constants';
import type { StatsBundle } from '../../../src/shared/messages';
import {
  ackError,
  isAck,
  isCanonicalSessionRuleSnapshot,
  isCycleConfig,
  isDeviceId,
  isEventRecord,
  isInstallMarker,
  isListsConfig,
  isPauseEconomy,
  isRetrySyncResponse,
  isScheduleDuration,
  isScheduleEntryV2,
  isScheduleOccurrenceRef,
  isSessionConfigV2,
  isSessionDuration,
  isSessionEndedEventV2,
  isSessionLifecycleV2,
  isSessionSnapshot,
  isSessionSnapshotV2,
  isSessionStartedEventV2,
  isSessionStateV2,
  isSettings,
  isSetupState,
  isStatsBundle,
  isWebsiteAccessReconciliation,
  parseEventExportResponse,
  parseStoredSettingsV2,
} from '../../../src/shared/runtime-validation';
import {
  LOCAL_BANK,
  LOCAL_DATA_CLEAR_JOURNAL,
  LOCAL_INSTALL_MARKER,
  LOCAL_LISTS,
  LOCAL_ONBOARDING_DRAFT,
  LOCAL_POLICY_COMMIT,
  LOCAL_POLICY_GENERATION_PREFIX,
  LOCAL_SETTINGS,
  LOCAL_SETUP,
  LOCAL_STREAK,
} from '../../../src/shared/storage-keys';
import type {
  CycleConfig,
  DailyAgg,
  EventRecord,
  InstallMarker,
  ListsConfig,
  MonthlyAgg,
  Rule,
  SessionConfig,
  SessionRuleSnapshot,
  SessionSnapshot,
  Settings,
  SettingsV2,
  SetupState,
  SiteUnlock,
} from '../../../src/shared/types';

afterEach((): void => {
  vi.restoreAllMocks();
});

const NOW: number = 1_700_000_000_000;
const SESSION_RULES: SessionRuleSnapshot = {
  baselineRevision: 'lists-v1-example',
  baselineCategories: { ...DEFAULT_LISTS.categories },
  categories: { ...DEFAULT_LISTS.categories },
  exclusions: {},
  permanentBlacklist: [{ kind: 'host', pattern: 'reddit.com' }],
  permanentAllowlist: [{ kind: 'host', pattern: 'github.com' }],
  sessionBlacklist: [],
  sessionAllowlist: [],
};
const CONFIG: SessionConfig = {
  mode: 'blacklist',
  strictness: 'flexible',
  duration: { kind: 'timed', minutes: 25 },
  cycling: null,
  intention: 'Review the release',
  source: 'manual',
  scheduleOccurrence: null,
  rules: SESSION_RULES,
};
const LEGACY_CONFIG: Omit<SessionConfig, 'rules'> = {
  mode: 'blacklist',
  strictness: 'friction',
  duration: { kind: 'timed', minutes: 25 },
  cycling: null,
  intention: 'Review the release',
  source: 'manual',
  scheduleOccurrence: null,
};
const SETUP: SetupState = {
  version: 1,
  completed: false,
  websiteAccess: 'pending',
  blockingRegistration: 'unavailable',
  websiteAccessNotice: null,
  storageMode: null,
  syncWriteStatus: 'idle',
  storageError: null,
  dataClear: { status: 'idle', scope: null, phase: null },
  legacyImported: false,
};

const INSTALL_MARKER: InstallMarker = {
  version: 1,
  profile: 'clean',
  latestReason: 'install',
  extensionVersion: '0.1.0',
};

function activeSnapshot(config: unknown = CONFIG): unknown {
  const startedAt: number = NOW - 10_000;
  return {
    ...emptySnapshot(NOW),
    // Flexible ends on request, so the authority is the immediate one.
    lifecycle: { kind: 'active', endAuthority: { kind: 'immediate', actionLabel: 'End session' } },
    phase: 'focus',
    config,
    startedAt,
    phaseStartedAt: startedAt,
    phaseEndsAt: NOW + 10_000,
    // A timed session ends exactly its duration after its start.
    sessionEndsAt: startedAt + 25 * 60_000,
    sessionFocusedMs: NOW - startedAt,
  };
}

function statsBundle(update: Partial<StatsBundle> = {}): StatsBundle {
  return {
    days: [],
    months: [],
    streak: {
      current: 0,
      freezeTokens: 0,
      lastCountedDate: null,
      lastFreezeGrantDate: null,
      activeDays: [],
      activeMonth: '2026-08',
    },
    recentSessions: [],
    totals: { focusMsToday: 0, focusMsLast7Days: 0, attemptsToday: 0, resistedToday: 0 },
    ...update,
  };
}

function sparseArray<T>(length: number, values: Readonly<Record<number, T>> = {}): T[] {
  const result: T[] = new Array<T>(length);
  for (const [index, value] of Object.entries(values)) result[Number(index)] = value;
  return result;
}

describe('runtime validation dense array boundaries', (): void => {
  it.each([
    [
      'custom rules',
      (): boolean => isListsConfig({ ...DEFAULT_LISTS, custom: sparseArray<Rule>(1) }),
    ],
    [
      'whitelist rules',
      (): boolean => isListsConfig({ ...DEFAULT_LISTS, whitelist: sparseArray<Rule>(1) }),
    ],
    [
      'exclusion hosts',
      (): boolean =>
        isListsConfig({
          ...DEFAULT_LISTS,
          exclusions: { social: sparseArray<string>(1) },
        }),
    ],
    [
      'active unlocks',
      (): boolean =>
        isSessionSnapshot({
          ...(activeSnapshot() as SessionSnapshot),
          activeUnlocks: sparseArray<SiteUnlock>(1),
        }),
    ],
    [
      'streak active days',
      (): boolean =>
        isStatsBundle(
          statsBundle({
            streak: {
              ...statsBundle().streak,
              activeDays: sparseArray<number>(1),
            },
          }),
        ),
    ],
    [
      'daily aggregates',
      (): boolean => isStatsBundle(statsBundle({ days: sparseArray<DailyAgg>(1) })),
    ],
    [
      'monthly aggregates',
      (): boolean => isStatsBundle(statsBundle({ months: sparseArray<MonthlyAgg>(1) })),
    ],
    [
      'recent sessions',
      (): boolean => isStatsBundle(statsBundle({ recentSessions: sparseArray<EventRecord>(1) })),
    ],
  ])('rejects sparse %s without throwing', (_label: string, validate: () => boolean): void => {
    expect(validate).not.toThrow();
    expect(validate()).toBe(false);
  });

  it('rejects an array whose own reads throw', (): void => {
    // `Array.isArray` sees straight through a proxy, so the dense walk is the first thing to touch
    // the trap. Sparse holes are the reachable case, and this is the hostile one beside it.
    const hostile: Rule[] = new Proxy<Rule[]>([], {
      get: (): never => {
        throw new Error('get trap');
      },
    });

    expect((): boolean => isListsConfig({ ...DEFAULT_LISTS, custom: hostile })).not.toThrow();
    expect(isListsConfig({ ...DEFAULT_LISTS, custom: hostile })).toBe(false);
    expect((): boolean =>
      isSessionSnapshot({
        ...(activeSnapshot() as SessionSnapshot),
        activeUnlocks: hostile as unknown as SiteUnlock[],
      }),
    ).not.toThrow();
    expect(
      isSessionSnapshot({
        ...(activeSnapshot() as SessionSnapshot),
        activeUnlocks: hostile as unknown as SiteUnlock[],
      }),
    ).toBe(false);
  });

  it('rejects a sparse event array returned by the JSON boundary', (): void => {
    vi.spyOn(JSON, 'parse').mockReturnValue(sparseArray<EventRecord>(1));

    expect(parseEventExportResponse({ json: '[]' })).toBeNull();
  });
});

describe('runtime and worker request validation parity', (): void => {
  it('accepts only retry responses that prove durable Sync completion', (): void => {
    expect(isRetrySyncResponse({ ok: true, syncWriteStatus: 'idle' })).toBe(true);
    expect(isRetrySyncResponse({ ok: true })).toBe(false);
    expect(isRetrySyncResponse({ ok: true, syncWriteStatus: 'pending' })).toBe(false);
    expect(isRetrySyncResponse({ ok: false, error: 'sync unavailable' })).toBe(true);
    expect(isRetrySyncResponse({ ok: false, error: '' })).toBe(false);
  });

  it('defines the initial setup contract', (): void => {
    expect(DEFAULT_SETUP).toEqual(SETUP);
    expect(INSTALL_MARKER).toEqual({
      version: 1,
      profile: 'clean',
      latestReason: 'install',
      extensionVersion: '0.1.0',
    });
    expect(isSetupState(SETUP)).toBe(true);
    expect(
      isSetupState({
        ...SETUP,
        dataClear: { status: 'pending', scope: 'local-history', phase: 'runtime' },
      }),
    ).toBe(true);
    expect(
      isSetupState({
        ...SETUP,
        dataClear: { status: 'pending', scope: 'local-history', phase: 'remote' },
      }),
    ).toBe(false);
    expect(
      isSetupState({
        ...SETUP,
        dataClear: { status: 'pending', scope: 'all', phase: 'browser-reset' },
      }),
    ).toBe(true);
    expect(
      isSetupState({
        ...SETUP,
        dataClear: { status: 'error', scope: 'all', phase: 'browser-reset' },
      }),
    ).toBe(true);
    expect(
      isSetupState({
        ...SETUP,
        dataClear: { status: 'pending', scope: 'synced-policy', phase: 'browser-reset' },
      }),
    ).toBe(false);
    expect(
      isSetupState({
        ...SETUP,
        dataClear: { status: 'pending', scope: 'local-history', phase: 'browser-reset' },
      }),
    ).toBe(false);
    expect(isSetupState({ ...SETUP, storageError: 'unknown' })).toBe(false);
    // The two boot overlays are answered by the worker, never stored, and the popup validates the
    // answer with the same guard it uses for the stored record.
    expect(isSetupState({ ...SETUP, storageError: 'boot-failed' })).toBe(true);
    expect(isSetupState({ ...SETUP, storageError: 'runtime-boot-failed' })).toBe(true);
    expect(isInstallMarker(INSTALL_MARKER)).toBe(true);
    expect(isInstallMarker({ ...INSTALL_MARKER, latestReason: 'startup' })).toBe(false);
  });

  it('defines a Flexible session with a complete rules snapshot', (): void => {
    expect(CONFIG.strictness).toBe('flexible');
    expect(CONFIG.rules).toEqual(SESSION_RULES);
  });

  it('defines the public launch local storage keys', (): void => {
    expect({
      LOCAL_SETUP,
      LOCAL_INSTALL_MARKER,
      LOCAL_ONBOARDING_DRAFT,
      LOCAL_POLICY_GENERATION_PREFIX,
      LOCAL_POLICY_COMMIT,
      LOCAL_DATA_CLEAR_JOURNAL,
      LOCAL_SETTINGS,
      LOCAL_LISTS,
      LOCAL_BANK,
      LOCAL_STREAK,
    }).toEqual({
      LOCAL_SETUP: 'setup',
      LOCAL_INSTALL_MARKER: 'installMarker',
      LOCAL_ONBOARDING_DRAFT: 'onboardingDraft',
      LOCAL_POLICY_GENERATION_PREFIX: 'policyGeneration:',
      LOCAL_POLICY_COMMIT: 'policyCommit',
      LOCAL_DATA_CLEAR_JOURNAL: 'dataClearJournal',
      LOCAL_SETTINGS: 'settings',
      LOCAL_LISTS: 'lists',
      LOCAL_BANK: 'bank',
      LOCAL_STREAK: 'streak',
    });
  });

  it('builds an isolated session rules snapshot from lists', (): void => {
    const lists: ListsConfig = {
      custom: [{ kind: 'host', pattern: 'reddit.com' }],
      whitelist: [{ kind: 'host', pattern: 'github.com' }],
      categories: { ...DEFAULT_LISTS.categories, social: true },
      exclusions: { social: ['workplace.com'] },
    };
    const snapshot: SessionRuleSnapshot = rulesFromLists(lists);

    expect(snapshot).toEqual({
      baselineRevision: policyRevision(lists),
      baselineCategories: lists.categories,
      categories: lists.categories,
      exclusions: lists.exclusions,
      permanentBlacklist: lists.custom,
      permanentAllowlist: lists.whitelist,
      sessionBlacklist: [],
      sessionAllowlist: [],
    });

    lists.categories.social = false;
    (lists.exclusions.social as string[]).push('calendar.example');
    const customRule: Rule | undefined = lists.custom[0];
    const allowRule: Rule | undefined = lists.whitelist[0];
    if (customRule === undefined || allowRule === undefined) throw new Error('missing test rules');
    customRule.pattern = 'changed.example';
    allowRule.pattern = 'changed.example';

    expect(snapshot.baselineCategories.social).toBe(true);
    expect(snapshot.categories.social).toBe(true);
    expect(snapshot.exclusions.social).toEqual(['workplace.com']);
    expect(snapshot.permanentBlacklist).toEqual([{ kind: 'host', pattern: 'reddit.com' }]);
    expect(snapshot.permanentAllowlist).toEqual([{ kind: 'host', pattern: 'github.com' }]);
  });

  it('canonicalizes a stored list the Settings editor accepts but the validator would refuse', (): void => {
    // Exactly what RulesEditor stores: validateRule passes on these, and nothing lowercases them.
    const lists: ListsConfig = {
      custom: [
        { kind: 'host', pattern: 'Facebook.com' },
        { kind: 'host', pattern: 'example.com.' },
      ],
      whitelist: [{ kind: 'host', pattern: 'Docs.Example.com' }],
      categories: { ...DEFAULT_LISTS.categories, social: true },
      exclusions: { social: ['Workplace.com.'] },
    };
    expect(isListsConfig(lists)).toBe(true);

    const snapshot: SessionRuleSnapshot = rulesFromLists(lists);

    expect(snapshot.permanentBlacklist).toEqual([
      { kind: 'host', pattern: 'facebook.com' },
      { kind: 'host', pattern: 'example.com' },
    ]);
    expect(snapshot.permanentAllowlist).toEqual([{ kind: 'host', pattern: 'docs.example.com' }]);
    expect(snapshot.exclusions.social).toEqual(['workplace.com']);
    expect(isCanonicalSessionRuleSnapshot(snapshot)).toBe(true);
  });

  it('leaves a regex rule and the order of the stored list alone', (): void => {
    const lists: ListsConfig = {
      custom: [
        { kind: 'host', pattern: 'Zebra.example' },
        { kind: 'regex', pattern: 'News|Sport' },
        { kind: 'host', pattern: 'alpha.example' },
      ],
      whitelist: [],
      categories: { ...DEFAULT_LISTS.categories },
      exclusions: {},
    };

    const snapshot: SessionRuleSnapshot = rulesFromLists(lists);

    expect(snapshot.permanentBlacklist).toEqual([
      { kind: 'host', pattern: 'zebra.example' },
      { kind: 'regex', pattern: 'News|Sport' },
      { kind: 'host', pattern: 'alpha.example' },
    ]);
    expect(isCanonicalSessionRuleSnapshot(snapshot)).toBe(true);
  });

  it('computes policy revisions independently of object insertion order', (): void => {
    const first: ListsConfig = {
      custom: [{ kind: 'host', pattern: 'reddit.com' }],
      whitelist: [{ kind: 'host', pattern: 'github.com' }],
      categories: { ...DEFAULT_LISTS.categories, social: true, news: true },
      exclusions: { social: ['workplace.com'], news: ['news.example'] },
    };
    const second: ListsConfig = {
      whitelist: [{ pattern: 'github.com', kind: 'host' }],
      custom: [{ pattern: 'reddit.com', kind: 'host' }],
      exclusions: { news: ['news.example'], social: ['workplace.com'] },
      categories: {
        forums: false,
        gaming: false,
        shopping: false,
        mail: false,
        news: true,
        video: false,
        social: true,
      },
    };
    const explicitEmptyExclusion: ListsConfig = {
      ...first,
      exclusions: { video: [], news: ['news.example'], social: ['workplace.com'] },
    };
    const changed: ListsConfig = {
      ...first,
      categories: { ...first.categories, social: false },
    };

    expect(policyRevision(second)).toBe(policyRevision(first));
    expect(policyRevision(explicitEmptyExclusion)).toBe(policyRevision(first));
    expect(policyRevision(changed)).not.toBe(policyRevision(first));
    expect(policyRevision(first)).toMatch(/^lists-v1:/);
  });

  it('normalizes equivalent host spellings in policy revisions', (): void => {
    const withHost: (host: string) => ListsConfig = (host: string): ListsConfig => ({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: host }],
      exclusions: { social: [host] },
    });
    const unicode: string = policyRevision(withHost('BÜCHER.EXAMPLE'));

    expect(policyRevision(withHost('xn--bcher-kva.example'))).toBe(unicode);
    expect(policyRevision(withHost('xn--bcher-kva.example.'))).toBe(unicode);
  });

  it('does not collapse distinct policies with the former FNV collision', (): void => {
    const withRegex: (pattern: string) => ListsConfig = (pattern: string): ListsConfig => ({
      ...DEFAULT_LISTS,
      custom: [{ kind: 'regex', pattern }],
    });

    expect(policyRevision(withRegex('collision-57429'))).not.toBe(
      policyRevision(withRegex('collision-244702')),
    );
  });

  it('defines Auto as the default theme', (): void => {
    expect(DEFAULT_SETTINGS).toHaveProperty('theme', 'auto');
  });

  it.each([
    ['valid settings', DEFAULT_SETTINGS, true],
    ['Auto theme', { ...DEFAULT_SETTINGS, theme: 'auto' }, true],
    ['Light theme', { ...DEFAULT_SETTINGS, theme: 'light' }, true],
    ['Dark theme', { ...DEFAULT_SETTINGS, theme: 'dark' }, true],
    ['Flexible default', { ...DEFAULT_SETTINGS, defaultStrictness: 'flexible' }, true],
    ['unknown theme', { ...DEFAULT_SETTINGS, theme: 'sepia' }, false],
    ['top-level extra settings key', { ...DEFAULT_SETTINGS, extra: true }, false],
    [
      'nested extra pause key',
      { ...DEFAULT_SETTINGS, pause: { ...DEFAULT_SETTINGS.pause, extra: true } },
      false,
    ],
    [
      'sparse preset values',
      { ...DEFAULT_SETTINGS, presetsMin: sparseArray(3, { 0: 15, 2: 50 }) },
      false,
    ],
  ])(
    'matches worker settings validation for %s',
    (_label: string, value: unknown, accepted: boolean): void => {
      const workerAccepted: boolean =
        parseRequest({ type: 'updateSettings', settings: value as typeof DEFAULT_SETTINGS }) !==
        null;
      expect(workerAccepted).toBe(accepted);
      expect(isSettings(value)).toBe(workerAccepted);
    },
  );

  it('accepts Flexible schedule entries at the shared runtime boundary', (): void => {
    expect(
      isSettings({
        ...DEFAULT_SETTINGS,
        schedule: [
          {
            id: 'flexible-entry',
            days: [1],
            start: '09:00',
            end: '10:00',
            duration: { kind: 'window' },
            mode: 'blacklist',
            strictness: 'flexible',
            cycling: null,
            intention: 'Review the release',
            enabled: true,
          },
        ],
      }),
    ).toBe(true);
  });

  it.each(['auto', 'light', 'dark'])(
    'accepts the %s theme in session snapshots',
    (theme: string): void => {
      expect(isSessionSnapshot({ ...(activeSnapshot() as SessionSnapshot), theme })).toBe(true);
    },
  );

  it('rejects an unknown session snapshot theme', (): void => {
    expect(isSessionSnapshot({ ...(activeSnapshot() as SessionSnapshot), theme: 'sepia' })).toBe(
      false,
    );
  });

  it.each([
    ['valid lists', DEFAULT_LISTS, true],
    ['top-level extra lists key', { ...DEFAULT_LISTS, extra: true }, false],
    [
      'extra custom rule key',
      { ...DEFAULT_LISTS, custom: [{ kind: 'host', pattern: 'example.com', extra: true }] },
      false,
    ],
    [
      'extra category key',
      { ...DEFAULT_LISTS, categories: { ...DEFAULT_LISTS.categories, extra: false } },
      false,
    ],
    [
      'unknown exclusion category',
      { ...DEFAULT_LISTS, exclusions: { unknown: ['example.com'] } },
      false,
    ],
    [
      'untrimmed exclusion host',
      { ...DEFAULT_LISTS, exclusions: { social: [' example.com'] } },
      false,
    ],
  ])(
    'matches worker list validation for %s',
    (_label: string, value: unknown, accepted: boolean): void => {
      const workerAccepted: boolean =
        parseRequest({ type: 'updateLists', lists: value as ListsConfig }) !== null;
      expect(workerAccepted).toBe(accepted);
      expect(isListsConfig(value)).toBe(workerAccepted);
    },
  );

  it.each([
    ['valid session config', CONFIG, true],
    ['legacy session config without rules', LEGACY_CONFIG, false],
    ['extra session config key', { ...CONFIG, extra: true }, false],
    [
      'extra cycle config key',
      { ...CONFIG, cycling: { ...DEFAULT_SETTINGS.defaultCycling, extra: true } },
      false,
    ],
    [
      'manual config with a schedule occurrence',
      {
        ...CONFIG,
        scheduleOccurrence: {
          version: 1,
          token: 'weekday@2026-09-03',
          entryId: 'weekday',
          localStartDate: '2026-09-03',
        },
      },
      false,
    ],
  ])(
    'matches worker session validation for %s',
    (_label: string, value: unknown, accepted: boolean): void => {
      const workerAccepted: boolean =
        parseRequest({ type: 'startSession', config: value as SessionConfig }) !== null;
      expect(workerAccepted).toBe(accepted);
      expect(isSessionSnapshot(activeSnapshot(value))).toBe(workerAccepted);
    },
  );
});

describe('transparent Proxy handling across the cycle, settings, session, and schedule paths', (): void => {
  it('keeps the v1 cycle and settings paths transparent and holds the v2 paths to exact data', (): void => {
    const cycling: CycleConfig = new Proxy<CycleConfig>({ ...DEFAULT_SETTINGS.defaultCycling }, {});
    const config: SessionConfig = { ...CONFIG, cycling };
    const settings: Settings = { ...DEFAULT_SETTINGS, defaultCycling: cycling };
    const scheduled: Settings = {
      ...settings,
      schedule: [
        {
          id: 'weekday',
          days: [1],
          start: '09:00',
          end: '10:00',
          duration: { kind: 'window' },
          mode: 'blacklist',
          strictness: 'flexible',
          cycling,
          intention: '',
          enabled: true,
        },
      ],
    };

    expect(isCycleConfig(cycling)).toBe(true);
    expect(parseRequest({ type: 'updateSettings', settings })).not.toBeNull();
    expect(isSettings(settings)).toBe(true);

    // The v2 session and schedule contracts read exact own data, which a Proxy is not.
    expect(parseRequest({ type: 'startSession', config })).toBeNull();
    expect(isSessionSnapshot(activeSnapshot(config))).toBe(false);
    expect(parseRequest({ type: 'updateSettings', settings: scheduled })).toBeNull();
    expect(isSettings(scheduled)).toBe(false);
  });
});

describe('exported runtime validators are total for hostile unknowns', (): void => {
  it.each([
    [{ ok: true, granted: true, registration: 'ready' }, true],
    [{ ok: true, granted: false, registration: 'unavailable' }, true],
    [{ ok: false, error: 'worker failed' }, true],
    [{ ok: false, error: 'registration failed', granted: true, registration: 'error' }, true],
    [{ ok: false, error: 'cleanup failed', granted: false, registration: 'error' }, true],
    [{ ok: false, error: 'permission unknown', registration: 'error' }, true],
    [{ ok: true, granted: true }, false],
    [{ ok: true, granted: true, registration: 'ready', extra: true }, false],
    [{ ok: true, granted: true, registration: 'error' }, false],
    [{ ok: true, granted: true, registration: 'bogus' }, false],
    [{ ok: true, granted: false, registration: 'ready' }, false],
    [{ ok: false }, false],
    [{ ok: false, error: '' }, false],
    [{ ok: false, error: 'failed', registration: 'ready' }, false],
    [{ ok: false, error: 'failed', registration: 'error', extra: true }, false],
  ])(
    'validates exact website access reconciliation responses %#',
    (value: unknown, accepted: boolean): void => {
      expect(isWebsiteAccessReconciliation(value)).toBe(accepted);
    },
  );

  it.each([
    [{ ok: true }, true],
    [{ ok: false, error: 'failed' }, true],
    [{}, false],
    [{ ok: true, extra: true }, false],
    [{ ok: false }, false],
    [{ ok: false, error: '' }, false],
    [{ ok: false, error: 'failed', extra: true }, false],
  ])('validates exact acknowledgements %#', (value: unknown, accepted: boolean): void => {
    expect(isAck(value)).toBe(accepted);
  });

  it('returns rejection values for a revoked proxy', (): void => {
    const revocable: { proxy: object; revoke: () => void } = Proxy.revocable<object>({}, {});
    revocable.revoke();
    const hostile: unknown = revocable.proxy;
    const booleanValidators: ReadonlyArray<(value: unknown) => boolean> = [
      isCycleConfig,
      isPauseEconomy,
      isSettings,
      isListsConfig,
      isSessionSnapshot,
      isEventRecord,
      isStatsBundle,
      isDeviceId,
      isAck,
      isWebsiteAccessReconciliation,
      isCanonicalSessionRuleSnapshot,
      isSessionDuration,
      isScheduleDuration,
      isScheduleOccurrenceRef,
      isSessionConfigV2,
      isScheduleEntryV2,
      isSessionStartedEventV2,
      isSessionEndedEventV2,
      isSessionStateV2,
      isSessionLifecycleV2,
      isSessionSnapshotV2,
    ];

    expect(booleanValidators).toEqual(
      expect.arrayContaining([
        isCanonicalSessionRuleSnapshot,
        isSessionDuration,
        isScheduleDuration,
        isScheduleOccurrenceRef,
        isSessionConfigV2,
        isScheduleEntryV2,
        isSessionStartedEventV2,
        isSessionEndedEventV2,
        isSessionStateV2,
        isSessionLifecycleV2,
        isSessionSnapshotV2,
      ]),
    );

    for (const validate of booleanValidators) {
      expect((): boolean => validate(hostile)).not.toThrow();
      expect(validate(hostile)).toBe(false);
    }
    expect((): string | null => ackError(hostile, 'malformed')).not.toThrow();
    expect(ackError(hostile, 'malformed')).toBe('malformed');
    expect((): EventRecord[] | null => parseEventExportResponse(hostile)).not.toThrow();
    expect(parseEventExportResponse(hostile)).toBeNull();
    expect((): SettingsV2 | null => parseStoredSettingsV2(hostile)).not.toThrow();
    expect(parseStoredSettingsV2(hostile)).toBeNull();
  });

  it('returns rejection values when property access and reflection throw', (): void => {
    const hostile: unknown = new Proxy<Record<string, unknown>>(
      {},
      {
        get: (): never => {
          throw new Error('get trap');
        },
        ownKeys: (): never => {
          throw new Error('ownKeys trap');
        },
      },
    );

    expect((): boolean => isSettings(hostile)).not.toThrow();
    expect(isSettings(hostile)).toBe(false);
    expect((): boolean => isListsConfig(hostile)).not.toThrow();
    expect(isListsConfig(hostile)).toBe(false);
    expect((): boolean => isSessionSnapshot(hostile)).not.toThrow();
    expect(isSessionSnapshot(hostile)).toBe(false);
    expect((): boolean => isStatsBundle(hostile)).not.toThrow();
    expect(isStatsBundle(hostile)).toBe(false);
    expect((): string | null => ackError(hostile, 'malformed')).not.toThrow();
    expect(ackError(hostile, 'malformed')).toBe('malformed');
    expect((): EventRecord[] | null => parseEventExportResponse(hostile)).not.toThrow();
    expect(parseEventExportResponse(hostile)).toBeNull();
  });
});
