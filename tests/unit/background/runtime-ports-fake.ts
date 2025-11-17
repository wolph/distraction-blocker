/**
 * The shared in-memory `RuntimePortsV2` every runtime engine test drives. It is a test fixture and
 * never a production builder: nothing here constructs a domain value a runner should build.
 *
 * Two properties make it useful as an oracle rather than a stub. Every `writeRuntime` and `commit`
 * value is validated with `parseRuntimeStateV2` and throws on rejection, so a runner that would
 * persist an invalid runtime fails the test that drove it rather than the one that reads it back.
 * And the transport answers by echoing the command it received, so the real transport classifier
 * decides the outcome and a test only scripts the deviations it cares about.
 */

import { expect } from 'vitest';
import type {
  AlarmNameV2,
  AlarmPortsV2,
  ScheduledAlarmV2,
} from '../../../src/background/alarms-v2';
import type { ContentTransportPortsV2 } from '../../../src/background/content-transport-v2';
import type { EnforcementTargetPortsV2 } from '../../../src/background/enforcement-targets-v2';
import type { RuntimeCommitInputV2 } from '../../../src/background/runtime-checkpoint-v2';
import type { RuntimePortsV2 } from '../../../src/background/runtime-ports-v2';
import type { CleanupTabClaim, RuntimeStateV2 } from '../../../src/background/runtime-v2-types';
import { parseRuntimeStateV2 } from '../../../src/background/runtime-v2-validation';
import type { ScheduleRunnerPortsV2 } from '../../../src/background/schedule-runner-v2';
import { ALL_CATEGORIES } from '../../../src/core/categories';
import type { CompiledMatcher } from '../../../src/core/matcher';
import { compileSessionMatcher, evaluateUrl } from '../../../src/core/matcher';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';
import type { DocumentContentCommand } from '../../../src/shared/enforcement-v2';
import { CoreError } from '../../../src/shared/errors';
import type { SoundId } from '../../../src/shared/messages';
import { localDateStr } from '../../../src/shared/time';
import type {
  BankState,
  DailyAgg,
  GateSettings,
  ListsConfig,
  PauseEconomy,
  ScheduleOccurrenceRef,
  SessionMode,
  SessionRuleSnapshot,
  SessionSnapshotV2,
  SettingsV2,
  SiteUnlock,
  ThemeMode,
  Verdict,
} from '../../../src/shared/types';

/** One scripted tab row. `documentId` null means the resolver finds no top-frame document. */
export interface FakeTabRowV2 {
  tabId: number;
  url: string | null;
  documentId?: string | null;
}

/** Answers one send. Return the raw content response, or throw to model a transport failure. */
export type FakeResponderV2 = (message: DocumentContentCommand) => unknown;

export interface FakeSendV2 {
  tabId: number;
  documentId: string;
  message: DocumentContentCommand;
}

export interface RuntimePortsFakeOptionsV2 {
  now?: number;
  /** Consumed in order by `newId`. Exhausting it is a test error, not a silent fallback. */
  ids?: readonly string[];
  tabs?: readonly FakeTabRowV2[];
  /** One tab set per `queryTopFrameTabs` call, then `tabs` for every later call. */
  tabSets?: ReadonlyArray<readonly FakeTabRowV2[]>;
  audit?: 'ready' | 'website-access-lost' | 'content-registration-failed';
  generation?: number;
  theme?: ThemeMode;
  economy?: PauseEconomy;
  gateSettings?: GateSettings;
  bank?: BankState;
  deviceId?: string;
  attemptsToday?: number;
  openOccurrences?: readonly ScheduleOccurrenceRef[];
  aggregates?: Record<string, DailyAgg>;
  /** How a created alarm reads back. `exact` is the browser behaving. */
  alarmReadBack?: 'exact' | 'missing' | 'other-time';
  /** Refuses exactly this many read-backs first, then behaves per `alarmReadBack`. */
  alarmReadBackFailures?: number;
  /** Runs when an alarm is created, so a test can move the clock during the alarm stage. */
  onAlarmCreate?: () => void;
  /** Runs while `auditEnforcement` is in flight, for interleaving a write during that await. */
  onAudit?: () => Promise<void> | void;
  /** Runs while `queryTopFrameTabs` is in flight, for interleaving a write during that await. */
  onQueryTabs?: () => Promise<void> | void;
  /** Runs while `loadAggregates` is in flight, for interleaving a write during that await. */
  onLoadAggregates?: () => Promise<void> | void;
  /**
   * Rejects every `writeRuntime` with the `CoreError` the runners' own `requireValid` raises, which
   * is what a durable write that will not land looks like from inside a command.
   */
  failWrites?: boolean;
}

export interface RuntimePortsFakeV2 extends RuntimePortsV2 {
  /** Every persisted runtime, in write order, including the ones a commit produced. */
  writes: RuntimeStateV2[];
  commits: RuntimeCommitInputV2[];
  sends: FakeSendV2[];
  errors: unknown[];
  /** Every boundary the controller asked the Engine to roll over, in order. */
  rollovers: number[];
  /** When true, `rolloverCheck` rebases `date` the way the retained Engine would. */
  onRolloverAdvanceDate?: boolean;
  auditCalls: number;
  alarmCalls: Array<{ kind: 'create' | 'createPeriodic' | 'clear'; name: AlarmNameV2 }>;
  /**
   * How many runtimes had landed at each alarm call, aligned with `alarmCalls` by index. It is what
   * pins an alarm against the write it must precede, and it stays out of `alarmCalls` so the
   * recorded call shape keeps comparing equal to a plain `{ kind, name }`.
   */
  alarmCallWrites: number[];
  setNow(at: number): void;
  advance(ms: number): void;
  setTabs(tabs: readonly FakeTabRowV2[]): void;
  scriptTabSets(sets: ReadonlyArray<readonly FakeTabRowV2[]>): void;
  setGeneration(generation: number): void;
  bumpGeneration(): void;
  setAudit(result: 'ready' | 'website-access-lost' | 'content-registration-failed'): void;
  setAlarmReadBack(mode: 'exact' | 'missing' | 'other-time'): void;
  /** Answers every send for one `${tabId}:${documentId}` target. */
  respondForDocument(tabId: number, documentId: string, responder: FakeResponderV2): void;
  /** Answers every send that carries one operation ID. Checked before the document responder. */
  respondForOperation(operationId: string, responder: FakeResponderV2): void;
  /** The last runtime this fake persisted, which is what `runtime()` returns. */
  current(): RuntimeStateV2;
  /** The stage of the durable transition at each write, for asserting the write sequence. */
  stages(): Array<string | null>;
}

const DEFAULT_DEVICE_ID: string = 'device-1';

export function createRuntimePortsFakeV2(
  initial: RuntimeStateV2,
  options: RuntimePortsFakeOptionsV2 = {},
): RuntimePortsFakeV2 {
  const state: FakeStateV2 = {
    runtime: requireValidRuntime(initial, 'the fake was seeded with an invalid runtime'),
    now: options.now ?? initial.date.length,
    ids: [...(options.ids ?? [])],
    tabs: [...(options.tabs ?? [])],
    tabSets: (options.tabSets ?? []).map((set: readonly FakeTabRowV2[]): FakeTabRowV2[] => [
      ...set,
    ]),
    audit: options.audit ?? 'ready',
    generation: options.generation ?? 0,
    aggregates: structuredClone(options.aggregates ?? {}),
    alarmReadBack: options.alarmReadBack ?? 'exact',
    alarmReadBackFailures: options.alarmReadBackFailures ?? 0,
    bank: structuredClone(options.bank ?? { balanceMs: 0 }),
    alarms: new Map<AlarmNameV2, ScheduledAlarmV2>(),
    byDocument: new Map<string, FakeResponderV2>(),
    byOperation: new Map<string, FakeResponderV2>(),
  };
  if (options.now !== undefined) state.now = options.now;

  const writes: RuntimeStateV2[] = [];
  const commits: RuntimeCommitInputV2[] = [];
  const sends: FakeSendV2[] = [];
  const errors: unknown[] = [];
  const rollovers: number[] = [];
  const alarmCalls: Array<{ kind: 'create' | 'createPeriodic' | 'clear'; name: AlarmNameV2 }> = [];
  const alarmCallWrites: number[] = [];

  const fake: RuntimePortsFakeV2 = {
    writes,
    commits,
    sends,
    errors,
    rollovers,
    auditCalls: 0,
    alarmCalls,
    alarmCallWrites,

    now: (): number => state.now,
    newId: (): string => {
      const id: string | undefined = state.ids.shift();
      if (id === undefined) throw new Error('the ports fake ran out of scripted IDs');
      return id;
    },
    runtime: (): RuntimeStateV2 => structuredClone(state.runtime),
    writeRuntime: async (next: RuntimeStateV2): Promise<void> => {
      if (options.failWrites === true) {
        throw new CoreError('invalid-rule', 'the storage boundary refused the runtime write');
      }
      state.runtime = requireValidRuntime(next, 'writeRuntime received an invalid runtime');
      writes.push(structuredClone(state.runtime));
    },
    commit: async (input: RuntimeCommitInputV2): Promise<RuntimeStateV2> => {
      commits.push(structuredClone(input));
      // Production writes the bank the checkpoint carries whatever `syncBank` says, so the fake
      // does too: `syncBank` selects the sync mirror, not whether the local bank lands.
      state.bank = structuredClone(input.bank);
      // Production writes the checkpointed runtime and then replays until the checkpoint clears,
      // so the durable value a caller receives is the projection with no checkpoint left. One
      // write is recorded per commit, and `commits` holds the batch the checkpoint carried.
      const applied: RuntimeStateV2 = structuredClone({
        ...state.runtime,
        ...input.projection,
        commitCheckpoint: null,
      });
      state.runtime = requireValidRuntime(applied, 'commit produced an invalid runtime');
      writes.push(structuredClone(state.runtime));
      return structuredClone(state.runtime);
    },
    auditEnforcement: async (): Promise<
      'ready' | 'website-access-lost' | 'content-registration-failed'
    > => {
      fake.auditCalls += 1;
      await options.onAudit?.();
      return state.audit;
    },
    compileMatcher: (rules: SessionRuleSnapshot, mode: SessionMode): CompiledMatcher =>
      compileSessionMatcher(rules, ALL_CATEGORIES, mode),
    verdictFor: (matcher: CompiledMatcher, url: string, unlocks: readonly SiteUnlock[]): Verdict =>
      evaluateUrl(matcher, url, [...unlocks], state.now),
    targets: targetPorts(state, options.onQueryTabs),
    transport: transportPorts(state, sends),
    alarms: alarmPorts(state, alarmCalls, options.onAlarmCreate, (): void => {
      alarmCallWrites.push(writes.length);
    }),
    theme: (): ThemeMode => options.theme ?? 'dark',
    economy: (): PauseEconomy => structuredClone(options.economy ?? DEFAULT_SETTINGS.pause),
    gateSettings: (): GateSettings =>
      structuredClone(options.gateSettings ?? DEFAULT_SETTINGS.gate),
    bank: (): BankState => structuredClone(state.bank),
    deviceId: (): string => options.deviceId ?? DEFAULT_DEVICE_ID,
    attemptsToday: (): number => options.attemptsToday ?? 0,
    openOccurrencesAt: (): ScheduleOccurrenceRef[] =>
      structuredClone([...(options.openOccurrences ?? [])]),
    loadAggregates: async (keys: readonly string[]): Promise<Record<string, DailyAgg>> => {
      await options.onLoadAggregates?.();
      const found: Record<string, DailyAgg> = {};
      for (const key of keys) {
        const stored: DailyAgg | undefined = state.aggregates[key];
        if (stored !== undefined) found[key] = structuredClone(stored);
      }
      return found;
    },
    rolloverCheck: async (boundary: number): Promise<void> => {
      rollovers.push(boundary);
      // The retained Engine owns `date` and `todayAgg`. A test that wants the loop to make
      // progress asks the fake to stand in for that bookkeeping.
      if (!fake.onRolloverAdvanceDate) return;
      state.runtime = requireValidRuntime(
        { ...structuredClone(state.runtime), date: localDateStr(boundary) },
        'rolloverCheck produced an invalid runtime',
      );
      writes.push(structuredClone(state.runtime));
    },
    reportError: (error: unknown): void => {
      errors.push(error);
    },

    setNow: (at: number): void => {
      state.now = at;
    },
    advance: (ms: number): void => {
      state.now += ms;
    },
    setTabs: (tabs: readonly FakeTabRowV2[]): void => {
      state.tabs = [...tabs];
    },
    scriptTabSets: (sets: ReadonlyArray<readonly FakeTabRowV2[]>): void => {
      state.tabSets = sets.map((set: readonly FakeTabRowV2[]): FakeTabRowV2[] => [...set]);
    },
    setGeneration: (generation: number): void => {
      state.generation = generation;
    },
    bumpGeneration: (): void => {
      state.generation += 1;
    },
    setAudit: (result: 'ready' | 'website-access-lost' | 'content-registration-failed'): void => {
      state.audit = result;
    },
    setAlarmReadBack: (mode: 'exact' | 'missing' | 'other-time'): void => {
      state.alarmReadBack = mode;
    },
    respondForDocument: (tabId: number, documentId: string, responder: FakeResponderV2): void => {
      state.byDocument.set(`${tabId}:${documentId}`, responder);
    },
    respondForOperation: (operationId: string, responder: FakeResponderV2): void => {
      state.byOperation.set(operationId, responder);
    },
    current: (): RuntimeStateV2 => structuredClone(state.runtime),
    stages: (): Array<string | null> =>
      writes.map(
        (runtime: RuntimeStateV2): string | null =>
          runtime.pendingEnforcementTransition?.stage ?? null,
      ),
  };
  return fake;
}

/** The exact `applied` answer a well-behaved document returns for one enforcement command. */
export function appliedResponseFor(message: DocumentContentCommand, handledAt: number): unknown {
  if (message.command !== 'apply-enforcement') {
    throw new Error('appliedResponseFor needs an apply-enforcement command');
  }
  return {
    version: 1,
    disposition: 'applied',
    operationId: message.operationId,
    enforcementEpoch: message.enforcementEpoch,
    sessionId: message.sessionId,
    reservedSessionId: message.reservedSessionId,
    basePolicyRevision: message.basePolicyRevision,
    runtimeRevision: message.runtimeRevision,
    documentId: message.documentId,
    observedUrl: message.expectedUrl,
    presentation: message.presentation,
    verdict: structuredClone(message.verdict),
    overlay: structuredClone(message.overlay),
    handledAt,
  };
}

/** The exact `epoch-reset` answer a well-behaved document returns for one reset command. */
export function epochResetResponseFor(message: DocumentContentCommand, handledAt: number): unknown {
  if (message.command !== 'reset-enforcement-epoch') {
    throw new Error('epochResetResponseFor needs a reset-enforcement-epoch command');
  }
  return {
    version: 1,
    disposition: 'epoch-reset',
    operationId: message.operationId,
    enforcementEpoch: message.enforcementEpoch,
    documentId: message.documentId,
    observedUrl: message.expectedUrl,
    handledAt,
  };
}

/** A responder that models a document with no listener at all. */
export function noReceiverResponder(): FakeResponderV2 {
  return (): never => {
    throw new Error('Could not establish connection. Receiving end does not exist.');
  };
}

/** A responder that answers nothing, which the transport reports as a mismatch. */
export function silentResponder(): FakeResponderV2 {
  return (): unknown => undefined;
}

interface FakeStateV2 {
  runtime: RuntimeStateV2;
  now: number;
  ids: string[];
  tabs: FakeTabRowV2[];
  tabSets: FakeTabRowV2[][];
  audit: 'ready' | 'website-access-lost' | 'content-registration-failed';
  generation: number;
  aggregates: Record<string, DailyAgg>;
  alarmReadBack: 'exact' | 'missing' | 'other-time';
  alarmReadBackFailures: number;
  bank: BankState;
  alarms: Map<AlarmNameV2, ScheduledAlarmV2>;
  byDocument: Map<string, FakeResponderV2>;
  byOperation: Map<string, FakeResponderV2>;
}

function targetPorts(
  state: FakeStateV2,
  onQueryTabs?: () => Promise<void> | void,
): EnforcementTargetPortsV2 {
  return {
    queryTopFrameTabs: async (): Promise<Array<{ tabId: number; url: string | null }>> => {
      await onQueryTabs?.();
      const set: FakeTabRowV2[] = state.tabSets.shift() ?? state.tabs;
      return set.map((row: FakeTabRowV2): { tabId: number; url: string | null } => ({
        tabId: row.tabId,
        url: row.url,
      }));
    },
    topFrameDocumentId: async (tabId: number): Promise<string | null> => {
      const row: FakeTabRowV2 | undefined = state.tabs.find(
        (candidate: FakeTabRowV2): boolean => candidate.tabId === tabId,
      );
      if (row === undefined) return null;
      return row.documentId === undefined ? `document-${tabId}` : row.documentId;
    },
    readTargetGeneration: (): number => state.generation,
    now: (): number => state.now,
  };
}

function transportPorts(state: FakeStateV2, sends: FakeSendV2[]): ContentTransportPortsV2 {
  return {
    sendToDocument: async (
      tabId: number,
      documentId: string,
      message: DocumentContentCommand,
    ): Promise<unknown> => {
      sends.push({ tabId, documentId, message: structuredClone(message) });
      const byOperation: FakeResponderV2 | undefined = state.byOperation.get(message.operationId);
      if (byOperation !== undefined) return byOperation(message);
      const byDocument: FakeResponderV2 | undefined = state.byDocument.get(
        `${tabId}:${documentId}`,
      );
      if (byDocument !== undefined) return byDocument(message);
      return message.command === 'apply-enforcement'
        ? appliedResponseFor(message, state.now)
        : epochResetResponseFor(message, state.now);
    },
  };
}

function alarmPorts(
  state: FakeStateV2,
  alarmCalls: Array<{ kind: 'create' | 'createPeriodic' | 'clear'; name: AlarmNameV2 }>,
  onCreate: (() => void) | undefined,
  recordWrites: () => void,
): AlarmPortsV2 {
  return {
    create: async (name: AlarmNameV2, when: number): Promise<void> => {
      alarmCalls.push({ kind: 'create', name });
      recordWrites();
      state.alarms.set(name, { scheduledTime: when, periodInMinutes: null });
      onCreate?.();
    },
    createPeriodic: async (name: AlarmNameV2, periodInMinutes: number): Promise<void> => {
      alarmCalls.push({ kind: 'createPeriodic', name });
      recordWrites();
      state.alarms.set(name, { scheduledTime: state.now, periodInMinutes });
    },
    get: async (name: AlarmNameV2): Promise<ScheduledAlarmV2 | null> => {
      const stored: ScheduledAlarmV2 | undefined = state.alarms.get(name);
      // An absent alarm reads back as absent, which is how a clear confirms itself. The scripted
      // failures apply only to reading back an alarm that was just created.
      if (stored === undefined) return null;
      if (state.alarmReadBackFailures > 0) {
        state.alarmReadBackFailures -= 1;
        return null;
      }
      if (state.alarmReadBack === 'missing') return null;
      if (state.alarmReadBack === 'other-time') {
        return { ...stored, scheduledTime: stored.scheduledTime + 1 };
      }
      return { ...stored };
    },
    clear: async (name: AlarmNameV2): Promise<void> => {
      alarmCalls.push({ kind: 'clear', name });
      recordWrites();
      state.alarms.delete(name);
    },
  };
}

/** Every persisted value passes the storage boundary, so an invalid write fails its own test. */
function requireValidRuntime(runtime: RuntimeStateV2, detail: string): RuntimeStateV2 {
  const parsed: RuntimeStateV2 | null = parseRuntimeStateV2(runtime);
  expect(parsed, detail).not.toBeNull();
  if (parsed === null) throw new Error(detail);
  return parsed;
}

/** The schedule ports the controller hands to the schedule runner. */
export interface ScheduleRunnerPortsFakeV2 extends ScheduleRunnerPortsV2 {
  notices: Array<{ title: string; body: string }>;
  sounds: string[];
  setSettings(settings: SettingsV2): void;
  setReady(ready: boolean): void;
}

export function createScheduleRunnerPortsFakeV2(
  settings: SettingsV2 = { ...DEFAULT_SETTINGS, schedule: [] },
  ready: boolean = true,
): ScheduleRunnerPortsFakeV2 {
  let current: SettingsV2 = structuredClone(settings);
  let blockingReady: boolean = ready;
  const notices: Array<{ title: string; body: string }> = [];
  const sounds: string[] = [];
  return {
    notices,
    sounds,
    settings: (): SettingsV2 => structuredClone(current),
    lists: (): ListsConfig => structuredClone(DEFAULT_LISTS),
    websiteBlockingReady: (): boolean => blockingReady,
    notify: (title: string, body: string): void => {
      notices.push({ title, body });
    },
    playSound: (sound: 'scheduleStart'): void => {
      sounds.push(sound);
    },
    setSettings: (next: SettingsV2): void => {
      current = structuredClone(next);
    },
    setReady: (next: boolean): void => {
      blockingReady = next;
    },
  };
}

/** Everything the controller does to the browser, recorded in order. */
export interface ControllerEffectsFakeV2 {
  broadcasts: SessionSnapshotV2[];
  badges: SessionSnapshotV2[];
  sounds: SoundId[];
  notices: Array<{ title: string; body: string }>;
  clears: number;
  attempts: Array<{ url: string; tabId: number; kind: 'navigation' | 'existing' }>;
  restored: number[][];
  reloads: number;
  blankBadges: number;
  /** Runs inside `restoreTabClaims`, for interleaving a write during a cleanup attempt. */
  onRestore?: () => Promise<void> | void;
  restoreTabClaims(claims: readonly CleanupTabClaim[]): Promise<number[]>;
  reloadStoppedDocuments(claims: readonly CleanupTabClaim[]): Promise<void>;
  requestBlankBadge(): void;
  broadcast(snapshot: SessionSnapshotV2): void;
  updateBadge(snapshot: SessionSnapshotV2): void;
  playSound(sound: SoundId): void;
  notify(title: string, body: string): void;
  clearBlockingForNonBlockingPhase(): Promise<void>;
  recordAttempt(url: string, tabId: number, kind: 'navigation' | 'existing'): Promise<void>;
}

export function createControllerEffectsFakeV2(): ControllerEffectsFakeV2 {
  const fake: ControllerEffectsFakeV2 = {
    broadcasts: [],
    badges: [],
    sounds: [],
    notices: [],
    clears: 0,
    attempts: [],
    restored: [],
    reloads: 0,
    blankBadges: 0,
    restoreTabClaims: async (claims: readonly CleanupTabClaim[]): Promise<number[]> => {
      await fake.onRestore?.();
      const resolved: number[] = claims.map((claim: CleanupTabClaim): number => claim.tabId);
      fake.restored.push(resolved);
      return resolved;
    },
    reloadStoppedDocuments: async (): Promise<void> => {
      fake.reloads += 1;
    },
    requestBlankBadge: (): void => {
      fake.blankBadges += 1;
    },
    broadcast: (snapshot: SessionSnapshotV2): void => {
      fake.broadcasts.push(structuredClone(snapshot));
    },
    updateBadge: (snapshot: SessionSnapshotV2): void => {
      fake.badges.push(structuredClone(snapshot));
    },
    playSound: (sound: SoundId): void => {
      fake.sounds.push(sound);
    },
    notify: (title: string, body: string): void => {
      fake.notices.push({ title, body });
    },
    clearBlockingForNonBlockingPhase: async (): Promise<void> => {
      fake.clears += 1;
    },
    recordAttempt: async (
      url: string,
      tabId: number,
      kind: 'navigation' | 'existing',
    ): Promise<void> => {
      fake.attempts.push({ url, tabId, kind });
    },
  };
  return fake;
}
