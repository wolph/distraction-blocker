import { ALL_CATEGORIES } from '../core/categories';
import {
  buildMatcherCache,
  type CompiledMatcher,
  compileSessionMatcher,
  evaluateUrl,
  type MatcherCacheBundle,
  registrableHost,
  type StoredMatcherCache,
} from '../core/matcher';
import { windowEnd } from '../core/schedule';
import {
  type ResolvedScheduleOccurrenceV2,
  resolveOpenScheduleOccurrencesV2,
} from '../core/schedule-v2';
import { addEvent, capAttempts, emptyDaily } from '../core/stats';
import { emptyStreak } from '../core/streak';
import {
  ATTEMPT_DEBOUNCE_MS,
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  emptySnapshot,
  TOP_SITES_DAILY,
} from '../shared/constants';
import type { DocumentContentCommand } from '../shared/enforcement-v2';
import type {
  Ack,
  CommandResponseV2,
  RetryCleanupResultCodeV2,
  SessionCommandResultCodeV2,
  SoundId,
  StartSessionResponseV2,
} from '../shared/messages';
import { isListsConfig } from '../shared/runtime-validation';
import { SYNC_BANK, syncAggKey } from '../shared/storage-keys';
import { localDateStr, localMonthStr } from '../shared/time';
import type {
  BankState,
  DailyAgg,
  EventRecord,
  GateSettings,
  ListsConfig,
  PauseEconomy,
  ScheduleEntryV2,
  ScheduleOccurrenceRef,
  SessionConfig,
  SessionMode,
  SessionRuleSnapshot,
  SessionSnapshot,
  SessionState,
  SessionStateV2,
  Settings,
  SiteUnlock,
  StreakState,
  Strictness,
  ThemeMode,
  Verdict,
} from '../shared/types';
import type { AlarmPortsV2 } from './alarms-v2';
import type { ContentTransportPortsV2 } from './content-transport-v2';
import type { DocumentEnforcementAck } from './enforcement-persistence-v2';
import type { EnforcementTargetPortsV2 } from './enforcement-targets-v2';
import { listsChangeAllowed, settingsChangeAllowed } from './guard';
import { encodeListsForSync, LIST_SYNC_KEYS, type ListsSyncEncoding } from './list-sync-codec';
import type { PolicyValueByKey } from './policy-storage';
import { planRollover, type RolloverPlan } from './rollover';
import {
  commitRuntimeCheckpointV2,
  projectRuntimeDomainV2,
  type RuntimeCommitInputV2,
} from './runtime-checkpoint-v2';
import type { RuntimePortsV2 } from './runtime-ports-v2';
import { emptyRuntimeV2 } from './runtime-store-v2';
import type {
  CleanupTabClaim,
  RuntimeCommitCheckpointV2,
  RuntimeStateV2,
} from './runtime-v2-types';
import type { ScheduleRunnerPortsV2 } from './schedule-runner-v2';
import { type SessionControllerEffectsV2, SessionControllerV2 } from './session-controller-v2';
import {
  type DeferredBlockClaim,
  type RuntimeTabState,
  sanitizeRuntimeForLocalHistory,
} from './stores';
import { chooseNewerStreak, rebaseStreakForDate } from './streak-sync';
import { assertSyncItemWithinQuota, SyncQuotaError } from './sync-quota';

declare const runtimeMutationLeaseBrand: unique symbol;

export interface RuntimeMutationLease {
  readonly [runtimeMutationLeaseBrand]: never;
}

export type BlockingSweepLease = RuntimeMutationLease;

interface DeferredBlockingSweep {
  promise: Promise<void>;
  reject(error: unknown): void;
  resolve(): void;
}

export interface EnginePorts {
  now(): number;
  newId(): string;
  /** Recreate and durably store the device identity after an all-data clear. */
  rehydrateAfterDataClear(): Promise<string>;
  saveRuntime(r: RuntimeStateV2): Promise<void>;
  saveMatcherCache(cache: StoredMatcherCache, lists: ListsConfig): Promise<void>;
  savePolicy?<K extends keyof PolicyValueByKey>(key: K, value: PolicyValueByKey[K]): Promise<void>;
  saveAggregate?(key: string, value: DailyAgg): Promise<void>;
  removeAggregate?(key: string): Promise<void>;
  hasPendingSync(key: string): boolean;
  queueSync(key: string, value: unknown): void;
  supersedeSync(key: string, value: unknown): void;
  removeSync(key: string): void;
  persistSyncJournal(): Promise<void>;
  appendEvents(evs: readonly EventRecord[]): Promise<void>;
  broadcast(snapshot: SessionSnapshot): void;
  applyBlocking(lease: BlockingSweepLease): Promise<void>;
  playSound(sound: SoundId): void;
  notify(title: string, message: string): void;
  updateIcon(snapshot: SessionSnapshot): void;
  scheduleWake(atMs: number | null): void;
  /** run the weekly sync-storage retention prune */
  prune(retentionDays: number, now: number): Promise<void>;
  reportError(error: unknown): void;
  /** Live website-blocking capability. */
  websiteBlockingReady(): boolean;
  /** The v2 enforcement seam: the browser surfaces the controller drives through this engine. */
  auditEnforcement(): Promise<'ready' | 'website-access-lost' | 'content-registration-failed'>;
  targets: EnforcementTargetPortsV2;
  transport: ContentTransportPortsV2;
  alarms: AlarmPortsV2;
  /** Stored daily aggregates by `syncAggKey`, for the closure that splits across a midnight. */
  loadAggregates(keys: readonly string[]): Promise<Record<string, DailyAgg>>;
  /** Clears blocking for a phase that blocks nothing, through the existing serialized sweep. */
  clearBlockingForNonBlockingPhase(): Promise<void>;
  restoreTabClaims(claims: readonly CleanupTabClaim[]): Promise<number[]>;
  reloadStoppedDocuments(claims: readonly CleanupTabClaim[]): Promise<void>;
}

export interface LiveTabState {
  url: string;
  mutedByExtension: boolean;
  documentId?: string | null;
}

export interface EngineStatsOverlay {
  deviceId: string;
  todayAgg: DailyAgg;
  streak: StreakState | null;
  pendingEvents: EventRecord[];
}

export type SessionMatcherCompiler = (
  rules: SessionRuleSnapshot,
  categories: typeof ALL_CATEGORIES,
  mode: SessionConfig['mode'],
) => CompiledMatcher;

interface AttemptDurability {
  revision: number;
  durable: boolean;
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

const _NO_SESSION_VERDICT: Verdict = {
  blocked: false,
  reason: 'no-session',
  categoryId: null,
  matchedPattern: null,
};
const WEBSITE_BLOCKING_LOSS_RETRY_MS: number = 1_000;

function _strictnessStrength(strictness: Strictness): number {
  if (strictness === 'flexible') return 0;
  if (strictness === 'friction') return 1;
  return 2;
}

function _scheduleOccurrenceToken(entry: ScheduleEntryV2, now: number): string {
  const endsAt: number = windowEnd(entry, new Date(now)).getTime();
  return `${entry.id}@${endsAt}`;
}

function _scheduleUnavailableNoticeToken(entry: ScheduleEntryV2, now: number): string {
  const [hour, minute]: number[] = entry.start.split(':').map(Number);
  const occurrenceStart: Date = new Date(now);
  occurrenceStart.setHours(hour ?? 0, minute ?? 0, 0, 0);
  if (occurrenceStart.getTime() > now) occurrenceStart.setDate(occurrenceStart.getDate() - 1);
  return `${entry.id}@${occurrenceStart.getTime()}`;
}

/**
 * Authoritative session engine. Pure src/core modules make every domain
 * decision, this class wires them to persistence and effects through
 * EnginePorts. Every public entry point runs catchUp() first, so a
 * worker woken after missed alarms is consistent before it answers.
 */
export class Engine {
  private pendingEvents: EventRecord[] = [];
  private dirty = false;
  private needsBlocking = false;
  private commitQueue: Promise<void> = Promise.resolve();
  private blockingMutationPersistQueue: Promise<void> = Promise.resolve();
  private domainPersistRevision: number = 0;
  private attemptRevision = 0;
  private attemptPersistInFlight: Map<string, Set<AttemptDurability>> = new Map();
  private failedAttemptPersistence: Set<string> = new Set();
  private runtimePersistQueue: Promise<void> = Promise.resolve();
  private activeRuntimeMutationLeases: Set<RuntimeMutationLease> = new Set();
  private runtimeMutationsInFlight: Set<Promise<void>> = new Set();
  private deferredBlockingSweep: DeferredBlockingSweep | null = null;
  private deferredBlockingSweepRequested = false;
  private bankDirty = false;
  private streakDirty = false;
  private bankRevision = 0;
  private runtimePersistRevision = 0;
  private ownedRuntimeSnapshot: RuntimeStateV2;
  private policyMutationQueue: Promise<void> = Promise.resolve();
  private suppressPolicyPublication = false;
  private pendingAggregateSets: Map<string, DailyAgg> = new Map();
  private pendingAggregateRemoves: Set<string> = new Set();
  private dataClearBarrierState: 'open' | 'draining' | 'quiesced' = 'open';
  private dataClearOperationRunning = false;
  private websiteBlockingLossPending = false;
  private readonly controller: SessionControllerV2;

  constructor(
    private readonly ports: EnginePorts,
    private settings: Settings,
    private lists: ListsConfig,
    private bank: BankState,
    private streak: StreakState | null,
    private runtime: RuntimeStateV2,
    private deviceId: string,
    private readonly compileSessionPolicy: SessionMatcherCompiler = compileSessionMatcher,
  ) {
    this.applyRemovedTabTombstones();
    const checkpoint: RuntimeCommitCheckpointV2 | null = this.runtime.commitCheckpoint;
    if (checkpoint !== null) {
      this.pendingEvents = [...checkpoint.events];
      for (const [key, value] of Object.entries(checkpoint.aggregateSets ?? {})) {
        this.pendingAggregateSets.set(key, capAttempts(value, TOP_SITES_DAILY));
      }
      for (const key of checkpoint.aggregateRemoves ?? []) this.pendingAggregateRemoves.add(key);
      if (checkpoint.syncBank) {
        this.bank = checkpoint.bank;
        this.bankDirty = true;
        this.bankRevision = 1;
      }
      this.dirty = true;
    }
    this.setSettingsAndClampBank(this.settings);
    // A v2 runtime always carries its session identity, so the legacy assignment branch is gone
    // with the migration that mints it.
    this.controller = new SessionControllerV2(
      this.runtimePorts(),
      this.scheduleRunnerPorts(),
      this.controllerEffects(),
    );
    this.ownedRuntimeSnapshot = structuredClone(this.runtime);
  }

  /** Everything the controller is not allowed to own, bound to this engine and its ports. */
  private runtimePorts(): RuntimePortsV2 {
    return {
      now: (): number => this.ports.now(),
      newId: (): string => this.ports.newId(),
      runtime: (): RuntimeStateV2 => this.runtime,
      writeRuntime: (next: RuntimeStateV2): Promise<void> => this.adoptRuntime(next),
      commit: (input: RuntimeCommitInputV2): Promise<RuntimeStateV2> => this.commitRuntime(input),
      auditEnforcement: (): Promise<
        'ready' | 'website-access-lost' | 'content-registration-failed'
      > => this.ports.auditEnforcement(),
      compileMatcher: (rules: SessionRuleSnapshot, mode: SessionMode): CompiledMatcher =>
        this.compileSessionPolicy(rules, ALL_CATEGORIES, mode),
      verdictFor: (
        matcher: CompiledMatcher,
        url: string,
        unlocks: readonly SiteUnlock[],
      ): Verdict => evaluateUrl(matcher, url, [...unlocks], this.ports.now()),
      targets: this.ports.targets,
      transport: this.ports.transport,
      alarms: this.ports.alarms,
      theme: (): ThemeMode => this.settings.theme,
      economy: (): PauseEconomy => structuredClone(this.settings.pause),
      gateSettings: (): GateSettings => structuredClone(this.settings.gate),
      bank: (): BankState => structuredClone(this.bank),
      deviceId: (): string => this.deviceId,
      attemptsToday: (): number => attemptsTodayOf(this.runtime.todayAgg),
      openOccurrencesAt: (at: number): ScheduleOccurrenceRef[] =>
        resolveOpenScheduleOccurrencesV2(this.settings.schedule, at).map(
          (resolved: ResolvedScheduleOccurrenceV2): ScheduleOccurrenceRef => resolved.occurrence,
        ),
      loadAggregates: (keys: readonly string[]): Promise<Record<string, DailyAgg>> =>
        this.ports.loadAggregates(keys),
      rolloverCheck: (boundary: number): Promise<void> => this.rolloverCheck(boundary),
      reportError: (error: unknown): void => this.ports.reportError(error),
    };
  }

  private scheduleRunnerPorts(): ScheduleRunnerPortsV2 {
    return {
      settings: (): Settings => this.settings,
      lists: (): ListsConfig => this.lists,
      websiteBlockingReady: (): boolean => this.ports.websiteBlockingReady(),
      notify: (title: string, body: string): void => this.ports.notify(title, body),
      playSound: (sound: 'scheduleStart'): void => this.ports.playSound(sound),
    };
  }

  private controllerEffects(): SessionControllerEffectsV2 {
    return {
      broadcast: (snapshot: SessionSnapshot): void => this.ports.broadcast(snapshot),
      updateBadge: (snapshot: SessionSnapshot): void => this.ports.updateIcon(snapshot),
      playSound: (sound: SoundId): void => this.ports.playSound(sound),
      notify: (title: string, body: string): void => this.ports.notify(title, body),
      clearBlockingForNonBlockingPhase: (): Promise<void> =>
        this.ports.clearBlockingForNonBlockingPhase(),
      recordAttempt: (url: string, tabId: number, kind: 'navigation' | 'existing'): Promise<void> =>
        this.recordAttempt(url, tabId, kind),
      restoreTabClaims: (claims: readonly CleanupTabClaim[]): Promise<number[]> =>
        this.ports.restoreTabClaims(claims),
      reloadStoppedDocuments: (claims: readonly CleanupTabClaim[]): Promise<void> =>
        this.ports.reloadStoppedDocuments(claims),
      requestBlankBadge: (): void => this.ports.updateIcon(emptySnapshot(this.ports.now())),
    };
  }

  /** One durable runtime write, which the controller owns the content of. */
  private async adoptRuntime(next: RuntimeStateV2): Promise<void> {
    this.runtime = structuredClone(next);
    this.ownedRuntimeSnapshot = structuredClone(next);
    await this.ports.saveRuntime(this.runtime);
  }

  /** One durable checkpoint, through the same writers the retained engine commits with. */
  private async commitRuntime(input: RuntimeCommitInputV2): Promise<RuntimeStateV2> {
    const committed: RuntimeStateV2 = await commitRuntimeCheckpointV2(
      {
        saveRuntime: (runtime: RuntimeStateV2): Promise<void> => this.ports.saveRuntime(runtime),
        appendEvents: (events: readonly EventRecord[]): Promise<void> =>
          this.ports.appendEvents(events),
        saveBank: (bank: BankState, syncBank: boolean): Promise<void> =>
          this.saveCommittedBank(bank, syncBank),
        saveAggregate: (key: string, value: DailyAgg): Promise<void> =>
          this.saveAggregate(key, value),
        removeAggregate: (key: string): Promise<void> => this.removeAggregate(key),
      },
      this.runtime,
      input,
    );
    this.runtime = committed;
    this.ownedRuntimeSnapshot = structuredClone(committed);
    return committed;
  }

  /** The committed bank is the engine's bank, and only a synced one reaches the sync journal. */
  private async saveCommittedBank(bank: BankState, syncBank: boolean): Promise<void> {
    this.bank = structuredClone(bank);
    await this.savePolicy('bank', this.bank);
    if (syncBank) this.ports.queueSync(SYNC_BANK, this.bank);
  }

  reportError(error: unknown): void {
    this.ports.reportError(error);
  }

  applyBlockingNow(): Promise<void> {
    return this.applyBlockingWithLease();
  }

  runWithRuntimeMutationLease<T>(
    operation: (lease: RuntimeMutationLease) => Promise<T>,
  ): Promise<T> {
    if (this.dataClearBarrierState !== 'open') {
      return Promise.reject(
        new Error(
          'runtime mutation rejected while storage transition or data clear is in progress',
        ),
      );
    }
    return this.trackRuntimeMutation(operation);
  }

  runWithRuntimeMutationLeaseOrBlockingSweep(
    operation: (lease: RuntimeMutationLease) => Promise<void>,
  ): Promise<void> {
    if (this.dataClearBarrierState === 'open') return this.trackRuntimeMutation(operation);
    if (!this.dataClearOperationRunning) {
      return Promise.reject(
        new Error(
          'runtime mutation rejected while storage transition or data clear is in progress',
        ),
      );
    }
    this.deferredBlockingSweepRequested = true;
    if (this.deferredBlockingSweep !== null) return this.deferredBlockingSweep.promise;
    let resolveSweep: () => void = (): void => undefined;
    let rejectSweep: (error: unknown) => void = (): void => undefined;
    const promise: Promise<void> = new Promise<void>(
      (resolve: () => void, reject: (error: unknown) => void): void => {
        resolveSweep = resolve;
        rejectSweep = reject;
      },
    );
    this.deferredBlockingSweep = {
      promise,
      reject: rejectSweep,
      resolve: resolveSweep,
    };
    return promise;
  }

  async runWithDataClearBarrier<T>(
    operation: () => Promise<T>,
    retainQuiescence: () => boolean = (): boolean => false,
  ): Promise<T> {
    if (this.dataClearOperationRunning) throw new Error('all-data clear is already in progress');
    const startingOpen: boolean = this.dataClearBarrierState === 'open';
    this.dataClearOperationRunning = true;
    if (startingOpen) this.dataClearBarrierState = 'draining';
    try {
      if (startingOpen) await this.drainRuntimeMutations();
      await this.prepareRuntimeForAllDataClear();
      this.dataClearBarrierState = 'quiesced';
      const result: T = await operation();
      await this.resetAfterAllDataClear();
      this.dataClearBarrierState = 'open';
      return result;
    } catch (error: unknown) {
      if (startingOpen && !retainQuiescence()) this.dataClearBarrierState = 'open';
      throw error;
    } finally {
      this.dataClearOperationRunning = false;
      if (this.dataClearBarrierState === 'open') {
        await this.applyPendingWebsiteBlockingLoss();
        await this.flushDeferredBlockClaims();
        await this.flushRemovedTabTombstones();
        await this.flushDeferredBlockingSweep();
      } else {
        this.rejectDeferredBlockingSweep(
          new Error('runtime mutation deferred while all-data deletion remains pending'),
        );
      }
    }
  }

  async retainDataClearQuiescence(): Promise<void> {
    if (this.dataClearOperationRunning || this.dataClearBarrierState !== 'open') {
      throw new Error('another storage transition is already in progress');
    }
    this.dataClearOperationRunning = true;
    this.dataClearBarrierState = 'draining';
    try {
      await this.drainRuntimeMutations();
      this.dataClearBarrierState = 'quiesced';
    } finally {
      this.dataClearOperationRunning = false;
      this.rejectDeferredBlockingSweep(
        new Error('runtime mutation deferred while all-data deletion remains pending'),
      );
    }
  }

  async runWithLocalHistoryClear(
    operation: () => Promise<boolean>,
    finish: () => Promise<void>,
  ): Promise<boolean> {
    return this.runWithAggregateStorageBarrier(async (): Promise<boolean> => {
      const aggregatesCleared: boolean = await operation();
      this.runtime = sanitizeRuntimeForLocalHistory(this.runtime, aggregatesCleared);
      this.pendingEvents = [];
      this.pendingAggregateSets.clear();
      this.pendingAggregateRemoves.clear();
      this.ownedRuntimeSnapshot = structuredClone(this.runtime);
      await this.persistRuntime(structuredClone(this.runtime));
      await finish();
      return aggregatesCleared;
    });
  }

  async runWithAggregateStorageBarrier<T>(operation: () => Promise<T>): Promise<T> {
    if (this.dataClearOperationRunning) {
      throw new Error('another storage transition is already in progress');
    }
    if (this.dataClearBarrierState !== 'open') {
      throw new Error('another storage transition is already in progress');
    }
    this.dataClearOperationRunning = true;
    this.dataClearBarrierState = 'draining';
    try {
      await this.drainRuntimeMutations();
      if (this.dirty) await this.commit(this.ports.now());
      await this.drainRuntimeMutations();
      this.dataClearBarrierState = 'quiesced';
      return await operation();
    } finally {
      let barrierReopened: boolean = false;
      try {
        await this.flushDeferredBlockClaims();
        await this.flushRemovedTabTombstones();
        await this.flushDeferredBlockingSweep(true);
        barrierReopened = true;
      } finally {
        if (!barrierReopened) {
          this.openRuntimeMutationBarrier();
          this.rejectDeferredBlockingSweep(
            new Error('runtime reconciliation cancelled while the storage barrier reopened'),
          );
        }
      }
      await this.applyPendingWebsiteBlockingLoss();
    }
  }

  /**
   * The public read model. The controller settles the core state through `at` in memory, so this
   * stays pure and every caller sees the phase the user is in.
   */
  snapshot(): SessionSnapshot {
    const now: number = this.ports.now();
    if (this.dataClearBarrierState === 'open' && this.dirty) this.commitInBackground(now);
    return this.controller.snapshot(now);
  }

  async snapshotPersisted(): Promise<SessionSnapshot> {
    return this.enqueuePolicyMutation((): Promise<SessionSnapshot> => this.snapshotPersistedNow());
  }

  private async snapshotPersistedNow(): Promise<SessionSnapshot> {
    const now: number = this.ports.now();
    if (this.dirty) await this.commit(now);
    else await this.commitQueue;
    return this.controller.snapshot(this.ports.now());
  }

  /** Resolves the durable journals once, before any alarm or message reaches the controller. */
  async recover(): Promise<void> {
    await this.controller.recover();
  }

  async startSession(config: SessionConfig): Promise<StartSessionResponseV2> {
    return this.enqueuePolicyMutation(
      (): Promise<StartSessionResponseV2> => this.controller.startSession(config),
    );
  }

  hasActiveSession(): boolean {
    return this.controller.hasActiveSession();
  }

  async endSessionForWebsiteBlockingLoss(): Promise<boolean> {
    if (this.dataClearBarrierState !== 'open') {
      return this.endSessionForWebsiteBlockingLossDuringBarrier();
    }
    return this.enqueuePolicyMutation(async (): Promise<boolean> => {
      if (!this.controller.hasActiveSession()) return false;
      await this.controller.endForEnforcementLoss('website-access-lost');
      return true;
    });
  }

  /**
   * The barrier is closed, so no runtime write may land. The loss is remembered and applied when
   * the barrier reopens; the pages are cleared right away, because the session is over for the user.
   */
  private async endSessionForWebsiteBlockingLossDuringBarrier(): Promise<boolean> {
    if (!this.controller.hasActiveSession()) return false;
    this.domainPersistRevision += 1;
    this.websiteBlockingLossPending = true;
    const snapshot: SessionSnapshot = this.controller.snapshot(this.ports.now());
    this.ports.broadcast(snapshot);
    this.ports.updateIcon(snapshot);
    this.ports.scheduleWake(null);
    try {
      await this.applyBlockingWithLease();
    } catch (error: unknown) {
      this.ports.reportError(error);
    }
    return true;
  }

  private async applyPendingWebsiteBlockingLoss(): Promise<void> {
    if (!this.websiteBlockingLossPending) return;
    this.websiteBlockingLossPending = false;
    try {
      await this.controller.endForEnforcementLoss('website-access-lost');
    } catch (error: unknown) {
      this.websiteBlockingLossPending = true;
      this.ports.reportError(error);
      this.ports.scheduleWake(this.ports.now() + WEBSITE_BLOCKING_LOSS_RETRY_MS);
    }
  }

  async requestSessionEnd(): Promise<CommandResponseV2<SessionCommandResultCodeV2>> {
    return this.enqueuePolicyMutation(
      (): Promise<CommandResponseV2<SessionCommandResultCodeV2>> =>
        this.controller.requestSessionEnd(),
    );
  }

  async openEndGate(): Promise<CommandResponseV2<SessionCommandResultCodeV2>> {
    return this.enqueuePolicyMutation(
      (): Promise<CommandResponseV2<SessionCommandResultCodeV2>> => this.controller.openEndGate(),
    );
  }

  async openGate(
    gate: 'pause' | 'unlockSite',
    host: string | null,
  ): Promise<CommandResponseV2<SessionCommandResultCodeV2>> {
    return this.enqueuePolicyMutation(
      (): Promise<CommandResponseV2<SessionCommandResultCodeV2>> =>
        this.controller.openGate(gate, host),
    );
  }

  async confirmGate(
    typedPhrase: string | null,
  ): Promise<CommandResponseV2<SessionCommandResultCodeV2>> {
    return this.enqueuePolicyMutation(
      (): Promise<CommandResponseV2<SessionCommandResultCodeV2>> =>
        this.controller.confirmGate(typedPhrase),
    );
  }

  async abandonGate(): Promise<CommandResponseV2<SessionCommandResultCodeV2>> {
    return this.enqueuePolicyMutation(
      (): Promise<CommandResponseV2<SessionCommandResultCodeV2>> => this.controller.abandonGate(),
    );
  }

  async resumeFromPause(): Promise<CommandResponseV2<SessionCommandResultCodeV2>> {
    return this.enqueuePolicyMutation(
      (): Promise<CommandResponseV2<SessionCommandResultCodeV2>> =>
        this.controller.resumeFromPause(),
    );
  }

  async startNextFocusEarly(): Promise<CommandResponseV2<SessionCommandResultCodeV2>> {
    return this.enqueuePolicyMutation(
      (): Promise<CommandResponseV2<SessionCommandResultCodeV2>> =>
        this.controller.startNextFocusEarly(),
    );
  }

  async retryTransitionCleanup(): Promise<CommandResponseV2<RetryCleanupResultCodeV2>> {
    return this.enqueuePolicyMutation(
      (): Promise<CommandResponseV2<RetryCleanupResultCodeV2>> =>
        this.controller.retryTransitionCleanup(),
    );
  }

  async retryClosureCleanup(): Promise<CommandResponseV2<RetryCleanupResultCodeV2>> {
    return this.enqueuePolicyMutation(
      (): Promise<CommandResponseV2<RetryCleanupResultCodeV2>> =>
        this.controller.retryClosureCleanup(),
    );
  }

  /** One alarm, routed by name to the journal or the settlement that owns it. */
  async handleAlarm(name: string): Promise<void> {
    await this.enqueuePolicyMutation((): Promise<void> => this.controller.handleAlarm(name));
  }

  /** The commands one document must apply, and the attempt the blocked ones record. */
  async documentCommandsFor(
    target: { tabId: number; documentId: string; url: string },
    attemptKind: 'navigation' | 'existing' | null,
  ): Promise<DocumentContentCommand[]> {
    // All-data clear needs no session, so a closed barrier answers nothing and writes nothing.
    if (this.dataClearBarrierState !== 'open') return [];
    return await this.controller.documentCommandsFor(target, attemptKind);
  }

  async handleNavigation(
    target: { tabId: number; documentId: string; url: string },
    attemptKind: 'navigation' | 'existing' | null,
  ): Promise<void> {
    if (this.dataClearBarrierState !== 'open') return;
    await this.controller.handleNavigation(target, attemptKind);
  }

  async recordDocumentAck(ack: DocumentEnforcementAck): Promise<void> {
    await this.controller.recordDocumentAck(ack);
  }

  /** Refreezes every live document view, for a change the frozen views must carry. */
  async refreshLiveViews(): Promise<void> {
    await this.controller.refreshLiveViews();
  }

  /**
   * The same refresh, for the policy paths that only need it while a session is live. An idle
   * profile holds no frozen view worth refreezing.
   */
  private async refreshLiveViewsIfLive(): Promise<void> {
    if (!this.controller.hasActiveSession()) return;
    await this.controller.refreshLiveViews();
  }

  async recordAttempt(
    url: string,
    tabId: number,
    kind: 'navigation' | 'existing',
    lease?: BlockingSweepLease,
  ): Promise<void> {
    this.assertRuntimeMutationAllowed(lease);
    const now: number = this.ports.now();
    const key: string = `${tabId}:${url}`;
    const last: number | undefined = this.runtime.attemptDebounce[key];
    const persistenceFailed: boolean = this.failedAttemptPersistence.delete(key);
    const retryFailedPersistence: boolean =
      persistenceFailed && last !== undefined && now - last < ATTEMPT_DEBOUNCE_MS;
    if (!retryFailedPersistence && last !== undefined && now - last < ATTEMPT_DEBOUNCE_MS) {
      const inFlight: Set<AttemptDurability> | undefined = this.attemptPersistInFlight.get(key);
      let latest: AttemptDurability | undefined;
      if (inFlight !== undefined) {
        for (const durability of inFlight) latest = durability;
      }
      if (latest !== undefined) await latest.promise;
      return;
    }
    const attemptMarker: number = retryFailedPersistence ? (last ?? now) : now;
    if (!retryFailedPersistence) {
      this.runtime.attemptDebounce[key] = attemptMarker;
      this.recordEvent({
        t: 'attempt',
        at: now,
        url,
        host: hostOf(url),
        tabId,
        kind,
        ...sessionIdentity(this.runtime.session),
      });
      this.dirty = true;
    }
    this.attemptRevision += 1;
    const revision: number = this.attemptRevision;
    let resolveDurability: () => void = (): void => undefined;
    let rejectDurability: (error: unknown) => void = (): void => undefined;
    const durabilityPromise: Promise<void> = new Promise(
      (resolve: () => void, reject: (error: unknown) => void): void => {
        resolveDurability = resolve;
        rejectDurability = reject;
      },
    );
    const durability: AttemptDurability = {
      revision,
      durable: false,
      promise: durabilityPromise,
      resolve: resolveDurability,
      reject: rejectDurability,
    };
    const inFlight: Set<AttemptDurability> =
      this.attemptPersistInFlight.get(key) ?? new Set<AttemptDurability>();
    inFlight.add(durability);
    this.attemptPersistInFlight.set(key, inFlight);
    const leasedSweepMutation: boolean =
      lease !== undefined && this.activeRuntimeMutationLeases.has(lease);
    const persistence: Promise<void> = leasedSweepMutation
      ? this.persistBlockingMutation(revision)
      : this.commit(now);
    void persistence.catch((error: unknown): void => {
      if (durability.durable) {
        this.ports.reportError(error);
      } else {
        if (this.runtime.attemptDebounce[key] === attemptMarker) {
          this.failedAttemptPersistence.add(key);
        }
        durability.reject(error);
      }
    });
    try {
      await durability.promise;
    } finally {
      inFlight.delete(durability);
      if (inFlight.size === 0 && this.attemptPersistInFlight.get(key) === inFlight) {
        this.attemptPersistInFlight.delete(key);
      }
    }
  }

  async markStopped(
    tabId: number,
    _url: string,
    documentId?: string,
    lease?: BlockingSweepLease,
  ): Promise<void> {
    this.assertRuntimeMutationAllowed(lease);
    if (typeof documentId !== 'string' || documentId === '') return;
    const state: RuntimeTabState | null = this.ensureTabState(tabId);
    if (state === null) return;
    state.stoppedDocumentId = documentId;
    await this.persistRuntime();
  }

  /** Mute and stopped-tab facts for one tab, for tabs.ts action planning. */
  tabFacts(
    tabId: number,
    url: string,
    documentId: string | null = null,
  ): { wasMutedByUs: boolean; priorMuted: boolean; wasStopped: boolean } {
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state === undefined) {
      return { wasMutedByUs: false, priorMuted: false, wasStopped: false };
    }
    const wasMutedByUs: boolean = state.priorMuted !== null && state.muteUrl === url;
    return {
      wasMutedByUs,
      priorMuted: wasMutedByUs ? (state.priorMuted ?? false) : false,
      wasStopped:
        documentId !== null && state.stoppedDocumentId !== null
          ? state.stoppedDocumentId === documentId
          : false,
    };
  }

  async claimMute(
    tabId: number,
    url: string,
    priorMuted: boolean,
    lease?: BlockingSweepLease,
  ): Promise<boolean> {
    this.assertRuntimeMutationAllowed(lease);
    if (this.runtime.removedTabTombstones[tabId] === true) return false;
    const existing: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (existing !== undefined && existing.priorMuted !== null && existing.muteUrl !== url) {
      return false;
    }
    const state: RuntimeTabState | null = this.ensureTabState(tabId);
    if (state === null) return false;
    state.muteUrl = url;
    state.priorMuted = priorMuted;
    await this.persistRuntime();
    return true;
  }

  async releaseMuteClaim(tabId: number, url: string, lease?: BlockingSweepLease): Promise<void> {
    this.assertRuntimeMutationAllowed(lease);
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state === undefined || state.muteUrl !== url) return;
    state.muteUrl = null;
    state.priorMuted = null;
    this.dropEmptyTabState(tabId, state);
    await this.persistRuntime();
  }

  async transferMuteClaim(
    tabId: number,
    fromUrl: string,
    toUrl: string,
    lease?: BlockingSweepLease,
  ): Promise<void> {
    this.assertRuntimeMutationAllowed(lease);
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state === undefined) return;
    if (state.muteUrl === fromUrl) state.muteUrl = toUrl;
    if (state.muteUrl !== toUrl || state.priorMuted === null) return;
    await this.persistRuntime();
  }

  async settleMuteClaim(
    tabId: number,
    finalUrl: string | null,
    lease?: BlockingSweepLease,
  ): Promise<void> {
    this.assertRuntimeMutationAllowed(lease);
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state === undefined || state.priorMuted === null) return;
    if (finalUrl === null) {
      state.muteUrl = null;
      state.priorMuted = null;
      this.dropEmptyTabState(tabId, state);
    } else {
      state.muteUrl = finalUrl;
    }
    await this.persistRuntime();
  }

  /** In-memory bookkeeping mutators for tabs.ts, persisted by flushRuntime. */
  noteMuteRestored(tabId: number, url: string, lease?: BlockingSweepLease): void {
    if (!this.runtimeMutationAllowed(lease)) return;
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state === undefined || state.muteUrl !== url) return;
    state.muteUrl = null;
    state.priorMuted = null;
    this.dropEmptyTabState(tabId, state);
  }

  noteReloaded(tabId: number, documentId: string, lease?: BlockingSweepLease): void {
    if (!this.runtimeMutationAllowed(lease)) return;
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state === undefined || state.stoppedDocumentId !== documentId) return;
    state.stoppedDocumentId = null;
    this.dropEmptyTabState(tabId, state);
  }

  reconcileTabs(
    liveTabs: ReadonlyMap<number, LiveTabState>,
    protectedTabIds: ReadonlySet<number> = new Set(),
    lease?: BlockingSweepLease,
  ): void {
    if (!this.runtimeMutationAllowed(lease)) return;
    for (const [tabIdText, state] of Object.entries(this.runtime.tabStates)) {
      const tabId: number = Number(tabIdText);
      const live: LiveTabState | undefined = liveTabs.get(tabId);
      if (live === undefined) {
        if (protectedTabIds.has(tabId)) continue;
        delete this.runtime.tabStates[tabId];
        continue;
      }
      if (state.priorMuted !== null) {
        if (live.mutedByExtension) state.muteUrl = live.url;
        else {
          state.muteUrl = null;
          state.priorMuted = null;
        }
      }
      if (
        typeof live.documentId === 'string' &&
        state.stoppedDocumentId !== null &&
        live.documentId !== state.stoppedDocumentId
      ) {
        state.stoppedDocumentId = null;
      }
      this.dropEmptyTabState(tabId, state);
    }
  }

  rebindTab(tabId: number, url: string, lease?: BlockingSweepLease): void {
    if (!this.runtimeMutationAllowed(lease)) return;
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state !== undefined && state.priorMuted !== null) state.muteUrl = url;
  }

  flushRuntime(lease?: BlockingSweepLease): Promise<void> {
    this.assertRuntimeMutationAllowed(lease);
    return this.persistRuntime();
  }

  /** Purges a closed tab from mute, stopped, and debounce bookkeeping. */
  async dropTab(tabId: number): Promise<void> {
    this.runtime.removedTabTombstones[tabId] = true;
    delete this.runtime.tabStates[tabId];
    for (const key of Object.keys(this.runtime.attemptDebounce)) {
      if (key.startsWith(`${tabId}:`)) {
        delete this.runtime.attemptDebounce[key];
        this.failedAttemptPersistence.delete(key);
      }
    }
    for (const [key, claim] of Object.entries(this.runtime.deferredBlockClaims)) {
      if (claim.tabId === tabId) delete this.runtime.deferredBlockClaims[key];
    }
    await this.persistRuntime();
  }

  private ensureTabState(tabId: number): RuntimeTabState | null {
    if (this.runtime.removedTabTombstones[tabId] === true) return null;
    const existing: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (existing !== undefined) return existing;
    const created: RuntimeTabState = {
      muteUrl: null,
      priorMuted: null,
      stoppedDocumentId: null,
    };
    this.runtime.tabStates[tabId] = created;
    return created;
  }

  private dropEmptyTabState(tabId: number, state: RuntimeTabState): void {
    if (state.priorMuted === null && state.stoppedDocumentId === null) {
      delete this.runtime.tabStates[tabId];
    }
  }

  /** The 1-minute tick alarm and exact phase alarms both land here. */
  async tick(): Promise<void> {
    return this.enqueuePolicyMutation((): Promise<void> => this.tickNow());
  }

  private async tickNow(): Promise<void> {
    await this.flushDeferredBlockClaims();
    await this.flushRemovedTabTombstones();
    const now: number = this.ports.now();
    this.pruneDebounce(now);
    await this.commit(now);
    await this.maybePrune(now);
    if (this.dirty) await this.commit(now);
    if (this.websiteBlockingLossPending && this.runtime.session === null) {
      this.websiteBlockingLossPending = false;
    }
  }

  async updateSettings(s: Settings): Promise<Ack> {
    return this.enqueuePolicyMutation((): Promise<Ack> => this.updateSettingsNow(s));
  }

  private async updateSettingsNow(s: Settings): Promise<Ack> {
    if (this.ports.savePolicy === undefined) {
      try {
        assertSyncItemWithinQuota('settings', s);
      } catch (error: unknown) {
        if (!(error instanceof SyncQuotaError)) throw error;
        return {
          ok: false,
          error:
            'Settings exceed the 8 KB Chrome Sync limit. Remove schedule entries or shorten intentions, then try again.',
        };
      }
    }
    const now: number = this.ports.now();
    const reason: string | null = settingsChangeAllowed(this.runtime.session, this.settings, s);
    if (reason !== null) return this.fail(now, reason);
    try {
      await this.savePolicy('settings', s);
    } catch (error: unknown) {
      if (!(error instanceof SyncQuotaError)) throw error;
      return {
        ok: false,
        error:
          'Settings exceed the 8 KB Chrome Sync limit. Remove schedule entries or shorten intentions, then try again.',
      };
    }
    this.setSettingsAndClampBank(s);
    this.dirty = true;
    await this.commit(now);
    return { ok: true };
  }

  async updateTheme(theme: ThemeMode): Promise<Ack> {
    return this.enqueuePolicyMutation(async (): Promise<Ack> => {
      const ack: Ack = await this.updateSettingsNow({ ...this.settings, theme });
      // The frozen views carry the theme, so a change of it is a live update for every document.
      if (ack.ok) await this.refreshLiveViewsIfLive();
      return ack;
    });
  }

  async updateLists(l: ListsConfig): Promise<Ack> {
    return this.enqueuePolicyMutation(async (): Promise<Ack> => {
      if (this.ports.savePolicy === undefined) {
        try {
          await encodeListsForSync(l);
        } catch (error: unknown) {
          if (!(error instanceof SyncQuotaError)) throw error;
          return {
            ok: false,
            error:
              'Lists exceed the 8 KB Chrome Sync limit. Remove custom or whitelist rules, then try again.',
          };
        }
      }
      return this.updateListsNow(l, null, true, false);
    });
  }

  private async updateListsNow(
    l: ListsConfig,
    encoding: ListsSyncEncoding | null,
    queueForSync: boolean,
    reconcilePendingSync: boolean,
  ): Promise<Ack> {
    const now: number = this.ports.now();
    const reason: string | null = listsChangeAllowed(
      this.runtime.session,
      this.runtime.session?.config.mode ?? null,
      this.lists,
      l,
    );
    if (reason !== null) return this.fail(now, reason);
    const bundle: MatcherCacheBundle = buildMatcherCache(l, ALL_CATEGORIES);
    await this.ports.saveMatcherCache(bundle.stored, l);
    if (queueForSync) {
      try {
        await this.savePolicy('lists', l);
      } catch (error: unknown) {
        if (!(error instanceof SyncQuotaError)) throw error;
        return {
          ok: false,
          error:
            'Lists exceed the 8 KB Chrome Sync limit. Remove custom or whitelist rules, then try again.',
        };
      }
    }
    this.lists = l;
    if (reconcilePendingSync && encoding !== null) this.queueListsEncoding(encoding);
    this.dirty = true;
    this.needsBlocking = this.runtime.session !== null;
    const committedAt: number = this.ports.now();
    await this.commit(committedAt);
    // A lists change moves what every open document must show, so the frozen views follow it.
    await this.refreshLiveViewsIfLive();
    return { ok: true };
  }

  async applySyncedSettings(settings: Settings): Promise<Ack> {
    this.assertRuntimeMutationAllowed();
    const now: number = this.ports.now();
    const reason: string | null = settingsChangeAllowed(
      this.runtime.session,
      this.settings,
      settings,
    );
    if (reason !== null) return this.fail(now, reason);
    this.setSettingsAndClampBank(settings);
    this.dirty = true;
    await this.commit(now);
    return { ok: true };
  }

  async applySyncedLists(lists: ListsConfig, reconcilePendingSync?: boolean): Promise<Ack> {
    const pendingSyncAtArrival: boolean = reconcilePendingSync ?? this.hasPendingListsSync();
    return this.enqueuePolicyMutation(async (): Promise<Ack> => {
      let encoding: ListsSyncEncoding;
      try {
        encoding = await encodeListsForSync(lists);
      } catch (error: unknown) {
        if (!(error instanceof SyncQuotaError)) throw error;
        return {
          ok: false,
          error:
            'Lists exceed the 8 KB Chrome Sync limit. Remove custom or whitelist rules, then try again.',
        };
      }
      return this.updateListsNow(
        lists,
        encoding,
        false,
        pendingSyncAtArrival || this.hasPendingListsSync(),
      );
    });
  }

  private hasPendingListsSync(): boolean {
    return LIST_SYNC_KEYS.some((key: string): boolean => this.ports.hasPendingSync(key));
  }

  private queueListsEncoding(encoding: ListsSyncEncoding): void {
    for (const [key, value] of Object.entries(encoding.sets)) {
      this.ports.queueSync(key, value);
    }
    for (const key of encoding.removes) this.ports.removeSync(key);
  }

  async applySyncedBank(bank: BankState): Promise<Ack> {
    this.assertRuntimeMutationAllowed();
    const now: number = this.ports.now();
    if (!Number.isFinite(bank.balanceMs) || bank.balanceMs < 0) {
      return this.fail(now, 'invalid synced pause bank');
    }
    this.bank = { balanceMs: Math.min(bank.balanceMs, this.settings.pause.capMs) };
    this.bankRevision += 1;
    this.dirty = true;
    await this.commit(now);
    return { ok: true };
  }

  async applySyncedStreak(streak: StreakState): Promise<void> {
    this.assertRuntimeMutationAllowed();
    const sanitized: StreakState = rebaseStreakForDate(streak, localDateStr(this.ports.now()));
    const chosen: StreakState | null = chooseNewerStreak(sanitized, this.streak);
    this.streak = chosen;
    if (chosen === null) return;
  }

  private async previewSyncedPolicyNow(
    changes: Partial<PolicyValueByKey>,
    _reconcilePendingLists: boolean,
  ): Promise<Ack & { accepted?: Partial<PolicyValueByKey> }> {
    if (changes.settings !== undefined) {
      const reason: string | null = settingsChangeAllowed(
        this.runtime.session,
        this.settings,
        changes.settings,
      );
      if (reason !== null) return { ok: false, error: reason };
    }
    if (changes.lists !== undefined) {
      const reason: string | null = listsChangeAllowed(
        this.runtime.session,
        this.runtime.session?.config.mode ?? null,
        this.lists,
        changes.lists,
      );
      if (reason !== null) return { ok: false, error: reason };
      try {
        await encodeListsForSync(changes.lists);
      } catch (error: unknown) {
        if (!(error instanceof SyncQuotaError)) throw error;
        return {
          ok: false,
          error:
            'Lists exceed the 8 KB Chrome Sync limit. Remove custom or whitelist rules, then try again.',
        };
      }
    }
    if (
      changes.bank !== undefined &&
      (!Number.isFinite(changes.bank.balanceMs) || changes.bank.balanceMs < 0)
    ) {
      return { ok: false, error: 'invalid synced pause bank' };
    }
    const accepted: Partial<PolicyValueByKey> = { ...changes };
    const effectiveSettings: Settings = changes.settings ?? this.settings;
    if (changes.bank !== undefined) {
      accepted.bank = {
        balanceMs: Math.min(changes.bank.balanceMs, effectiveSettings.pause.capMs),
      };
    } else if (
      changes.settings !== undefined &&
      this.bank.balanceMs > effectiveSettings.pause.capMs
    ) {
      accepted.bank = { balanceMs: effectiveSettings.pause.capMs };
    }
    if (changes.streak !== undefined && changes.streak !== null) {
      const sanitized: StreakState = rebaseStreakForDate(
        changes.streak,
        localDateStr(this.ports.now()),
      );
      accepted.streak = chooseNewerStreak(sanitized, this.streak);
    }
    return { ok: true, accepted };
  }

  async transactSyncedPolicy(
    changes: Partial<PolicyValueByKey>,
    reconcilePendingLists: boolean,
    mirror: (accepted: Partial<PolicyValueByKey>) => Promise<void>,
  ): Promise<Ack> {
    return this.enqueuePolicyMutation(async (): Promise<Ack> => {
      const admittedAt: number = this.ports.now();
      try {
        if (this.dirty) await this.commit(admittedAt);
        const preview: Ack & { accepted?: Partial<PolicyValueByKey> } =
          await this.previewSyncedPolicyNow(changes, reconcilePendingLists);
        if (!preview.ok) return preview;
        const accepted: Partial<PolicyValueByKey> = preview.accepted ?? changes;
        const listBundle: MatcherCacheBundle | undefined =
          accepted.lists === undefined
            ? undefined
            : await this.prepareSyncedListBundle(accepted.lists);
        await mirror(accepted);
        await this.commitSyncedPolicyNow(accepted, listBundle);
        return { ok: true };
      } finally {
        const completedAt: number = this.ports.now();
        if (this.dirty) await this.commit(completedAt);
      }
    });
  }

  private async prepareSyncedListBundle(lists: ListsConfig): Promise<MatcherCacheBundle> {
    const bundle: MatcherCacheBundle = buildMatcherCache(lists, ALL_CATEGORIES);
    await this.ports.saveMatcherCache(bundle.stored, lists);
    return bundle;
  }

  private async commitSyncedPolicyNow(
    changes: Partial<PolicyValueByKey>,
    preparedListBundle?: MatcherCacheBundle,
  ): Promise<void> {
    const listBundle: MatcherCacheBundle | null =
      changes.lists === undefined
        ? null
        : (preparedListBundle ?? (await this.prepareSyncedListBundle(changes.lists)));
    const now: number = this.ports.now();
    this.suppressPolicyPublication = true;
    try {
      if (changes.settings !== undefined) this.setSettingsAndClampBank(changes.settings);
      if (changes.lists !== undefined && listBundle !== null) {
        this.lists = changes.lists;
        this.needsBlocking = this.runtime.session !== null;
        this.dirty = true;
      }
      if (changes.bank !== undefined) {
        this.bank = {
          balanceMs: Math.min(changes.bank.balanceMs, this.settings.pause.capMs),
        };
        this.bankRevision += 1;
        this.bankDirty = true;
        this.dirty = true;
      }
      if (changes.streak !== undefined) {
        const sanitized: StreakState | null =
          changes.streak === null
            ? null
            : rebaseStreakForDate(changes.streak, localDateStr(this.ports.now()));
        this.streak = sanitized === null ? null : chooseNewerStreak(sanitized, this.streak);
        this.streakDirty = this.streak !== null;
        this.dirty = true;
      }
      await this.commit(now);
    } finally {
      this.suppressPolicyPublication = false;
    }
  }

  getSettings(): Settings {
    return this.settings;
  }

  private setSettingsAndClampBank(settings: Settings): void {
    const balanceMs: number = Math.min(this.bank.balanceMs, settings.pause.capMs);
    if (this.settings.theme !== settings.theme) this.needsBlocking = true;
    this.settings = settings;
    if (balanceMs === this.bank.balanceMs) return;
    this.bank = { balanceMs };
    this.bankDirty = true;
    this.bankRevision += 1;
    this.dirty = true;
  }

  getLists(): ListsConfig {
    return this.lists;
  }

  /** Task 8's rollover and stats service read and update this. */
  getStreak(): StreakState | null {
    return this.streak;
  }

  statsOverlay(): EngineStatsOverlay {
    const now: number = this.ports.now();
    if (this.dataClearBarrierState === 'open' && this.dirty) this.commitInBackground(now);
    return {
      deviceId: this.deviceId,
      todayAgg: capAttempts(
        this.runtime.todayAgg ?? emptyDaily(this.runtime.date),
        TOP_SITES_DAILY,
      ),
      streak: this.streak,
      pendingEvents: [...this.pendingEvents],
    };
  }

  /**
   * Closes the day the boundary just left: the finished aggregate is credited, the streak moves,
   * and `todayAgg` and `date` advance to the day the boundary belongs to. The controller's tick
   * owns the settlement that precedes it, so this only does the bookkeeping the Engine retains.
   */
  async rolloverCheck(boundary: number): Promise<void> {
    const now: number = boundary;
    const today: string = localDateStr(now);
    if (today === this.runtime.date) return;
    const streak: StreakState = this.streak ?? emptyStreak(localMonthStr(now));
    const plan: RolloverPlan = planRollover(
      this.runtime.date,
      now,
      this.runtime.todayAgg,
      streak,
      this.settings.streakGoalMin,
      this.settings.streakFreezeIntervalDays,
    );
    this.recordAggregateSet(syncAggKey(this.deviceId, plan.finished.date), plan.finished);
    this.streak = plan.streak;
    this.streakDirty = true;
    this.runtime.todayAgg = plan.newAgg;
    this.runtime.date = today;
    this.dirty = true;
    await this.commit(now);
  }

  /** Weekly retention prune, marked only after storage operations finish. */
  private async maybePrune(now: number): Promise<void> {
    const today: string = localDateStr(now);
    const last: string | null = this.runtime.lastPruneDate;
    if (last !== null) {
      const elapsedDays: number =
        (new Date(today).getTime() - new Date(last).getTime()) / 86_400_000;
      if (elapsedDays < 7) return;
    }
    try {
      await this.ports.prune(this.settings.retentionDays, now);
    } catch (error: unknown) {
      this.ports.reportError(error);
      return;
    }
    this.runtime.lastPruneDate = today;
    this.dirty = true;
  }

  // --- the commit tail: fold events, persist, broadcast, icon, wake ---

  private async fail(now: number, error: string): Promise<Ack> {
    if (this.dirty) await this.commit(now);
    return { ok: false, error };
  }

  private recordEvent(event: EventRecord): void {
    const aggregateEvent: EventRecord =
      event.t === 'sessionCompleted' || event.t === 'sessionCanceled'
        ? { ...event, focusedMs: 0 }
        : event;
    const aggregate: DailyAgg = this.runtime.todayAgg ?? emptyDaily(this.runtime.date);
    this.runtime.todayAgg = addEvent(aggregate, aggregateEvent);
    this.pendingEvents.push(event);
    this.dirty = true;
  }

  private recordAggregateSet(key: string, value: DailyAgg): void {
    this.pendingAggregateRemoves.delete(key);
    this.pendingAggregateSets.set(key, capAttempts(value, TOP_SITES_DAILY));
  }

  private async saveAggregate(key: string, value: DailyAgg): Promise<void> {
    if (this.ports.saveAggregate !== undefined) {
      await this.ports.saveAggregate(key, value);
      return;
    }
    this.ports.queueSync(key, value);
  }

  private async removeAggregate(key: string): Promise<void> {
    if (this.ports.removeAggregate !== undefined) {
      await this.ports.removeAggregate(key);
      return;
    }
    this.ports.removeSync(key);
  }

  private async flushEvents(batch: EventRecord[]): Promise<void> {
    if (batch.length === 0) return;
    await this.ports.appendEvents(batch);
  }

  private commit(now: number): Promise<void> {
    const queued: Promise<void> = this.commitQueue.then(
      (): Promise<void> => this.performCommit(now),
    );
    this.commitQueue = queued.catch((): void => {
      // Keep later commits usable. The caller still receives the rejection.
    });
    return queued;
  }

  private commitInBackground(now: number): void {
    void this.commit(now).catch((error: unknown): void => this.ports.reportError(error));
  }

  private persistBlockingMutation(attemptRevision: number): Promise<void> {
    const queued: Promise<void> = this.blockingMutationPersistQueue.then(
      async (): Promise<void> => {
        await this.persistDomainState();
        this.resolveAttemptDurability(attemptRevision);
      },
    );
    this.blockingMutationPersistQueue = queued.catch((): void => {
      // Keep later in-sweep persistence usable. The caller still receives the rejection.
    });
    return queued;
  }

  private resolveAttemptDurability(revision: number): void {
    for (const inFlight of this.attemptPersistInFlight.values()) {
      for (const durability of inFlight) {
        if (durability.revision <= revision) {
          durability.durable = true;
          durability.resolve();
        }
      }
    }
  }

  private async performCommit(now: number): Promise<void> {
    const attemptRevision: number = this.attemptRevision;
    await this.persistDomainState();
    this.dirty = false;
    const block: boolean = this.needsBlocking;
    this.needsBlocking = false;
    const snap: SessionSnapshot = this.controller.snapshot(now);
    this.resolveAttemptDurability(attemptRevision);
    this.ports.broadcast(snap);
    this.ports.updateIcon(snap);
    const wakeCandidates: number[] = this.runtime.unlocks.map(
      (unlock: SiteUnlock): number => unlock.until,
    );
    // An indefinite session has no boundary to wake for, and a phase without an end has none
    // either, so only the finite ones join the candidates.
    const session: SessionStateV2 | null = this.runtime.session;
    if (session !== null) {
      const boundaries: number[] = [session.phaseEndsAt, session.sessionEndsAt].filter(
        (boundary: number | null): boundary is number => boundary !== null,
      );
      if (boundaries.length > 0) wakeCandidates.push(Math.min(...boundaries));
    }
    this.ports.scheduleWake(wakeCandidates.length === 0 ? null : Math.min(...wakeCandidates));
    if (block) {
      try {
        await this.applyBlockingWithLease();
      } catch (error: unknown) {
        this.needsBlocking = true;
        throw error;
      }
    }
    if (this.dirty) {
      const updatedAttemptRevision: number = this.attemptRevision;
      await this.persistDomainState();
      this.dirty = false;
      const updated: SessionSnapshot = this.controller.snapshot(this.ports.now());
      this.resolveAttemptDurability(updatedAttemptRevision);
      this.ports.broadcast(updated);
      this.ports.updateIcon(updated);
    }
  }

  private async persistDomainState(): Promise<void> {
    this.domainPersistRevision += 1;
    const domainPersistRevision: number = this.domainPersistRevision;
    const bank: BankState = structuredClone(this.bank);
    const events: EventRecord[] = [...this.pendingEvents];
    const aggregate: DailyAgg | null = structuredClone(this.runtime.todayAgg);
    const date: string = this.runtime.date;
    const syncBank: boolean = this.bankDirty;
    const bankRevision: number = this.bankRevision;
    const runtimePersistRevision: number = this.runtimePersistRevision;
    const aggregateSets: Record<string, DailyAgg> = Object.fromEntries(
      [...this.pendingAggregateSets.entries()].map(
        ([key, value]: [string, DailyAgg]): [string, DailyAgg] => [key, structuredClone(value)],
      ),
    );
    if (aggregate !== null) {
      aggregateSets[syncAggKey(this.deviceId, date)] = capAttempts(aggregate, TOP_SITES_DAILY);
    }
    const aggregateRemoves: string[] = [...this.pendingAggregateRemoves];
    // The retained engine writes a v2 checkpoint, because the runtime it persists is a v2 runtime
    // and replay reads it back through the v2 reader.
    this.runtime.commitCheckpoint = {
      version: 2,
      checkpointId: `${this.runtime.enforcementEpoch}:engine-${this.domainPersistRevision}`,
      projection: projectRuntimeDomainV2(this.runtime),
      bank,
      events,
      syncBank,
      aggregateSets,
      aggregateRemoves,
    };
    const checkpointRuntime: RuntimeStateV2 = structuredClone(this.runtime);
    this.ownedRuntimeSnapshot = structuredClone(checkpointRuntime);
    await this.persistRuntime(checkpointRuntime);
    if (syncBank) await this.savePolicy('bank', bank);
    if (this.streakDirty && this.streak !== null) {
      await this.savePolicy('streak', this.streak);
      this.streakDirty = false;
    }
    for (const [key, value] of Object.entries(aggregateSets)) {
      await this.saveAggregate(key, value);
    }
    for (const key of aggregateRemoves) await this.removeAggregate(key);
    await this.flushEvents(events);
    await this.ports.persistSyncJournal();
    for (const event of events) {
      const index: number = this.pendingEvents.indexOf(event);
      if (index >= 0) this.pendingEvents.splice(index, 1);
    }
    if (this.bankRevision === bankRevision) this.bankDirty = false;
    for (const [key, value] of Object.entries(aggregateSets)) {
      const pending: DailyAgg | undefined = this.pendingAggregateSets.get(key);
      if (pending !== undefined && JSON.stringify(pending) === JSON.stringify(value)) {
        this.pendingAggregateSets.delete(key);
      }
    }
    for (const key of aggregateRemoves) this.pendingAggregateRemoves.delete(key);
    if (this.domainPersistRevision === domainPersistRevision) {
      this.runtime.commitCheckpoint = null;
      if (this.runtimePersistRevision === runtimePersistRevision) {
        checkpointRuntime.commitCheckpoint = null;
        this.ownedRuntimeSnapshot = structuredClone(checkpointRuntime);
        await this.persistRuntime(checkpointRuntime);
      }
    }
  }

  private async savePolicy<K extends keyof PolicyValueByKey>(
    key: K,
    value: PolicyValueByKey[K],
  ): Promise<void> {
    if (this.suppressPolicyPublication) return;
    if (this.ports.savePolicy !== undefined) {
      await this.ports.savePolicy(key, value);
      return;
    }
    if (key === 'lists') {
      if (!isListsConfig(value)) throw new Error('invalid lists policy');
      this.queueListsEncoding(await encodeListsForSync(value));
    } else if (key === 'settings') {
      assertSyncItemWithinQuota('settings', value);
      this.ports.queueSync('settings', value);
    } else if (key === 'bank') {
      this.ports.queueSync('bank', value);
    } else {
      this.ports.queueSync('streak', value);
    }
    await this.ports.persistSyncJournal();
  }

  private persistRuntime(snapshot?: RuntimeStateV2): Promise<void> {
    if (snapshot === undefined) {
      this.runtimePersistRevision += 1;
      this.ownedRuntimeSnapshot.tabStates = structuredClone(this.runtime.tabStates);
      this.ownedRuntimeSnapshot.attemptDebounce = structuredClone(this.runtime.attemptDebounce);
      this.ownedRuntimeSnapshot.deferredBlockClaims = structuredClone(
        this.runtime.deferredBlockClaims,
      );
      this.ownedRuntimeSnapshot.removedTabTombstones = structuredClone(
        this.runtime.removedTabTombstones,
      );
      return this.queueRuntimeSnapshot(structuredClone(this.ownedRuntimeSnapshot));
    }
    return this.queueRuntimeSnapshot(snapshot);
  }

  private queueRuntimeSnapshot(snapshot: RuntimeStateV2): Promise<void> {
    const requested: Promise<void> = this.runtimePersistQueue.then(
      (): Promise<void> => this.ports.saveRuntime(snapshot),
    );
    this.runtimePersistQueue = requested.catch((): void => {});
    return requested.catch((error: unknown): never => {
      this.dirty = true;
      throw error;
    });
  }

  private enqueuePolicyMutation<T>(mutation: () => Promise<T>): Promise<T> {
    if (this.dataClearBarrierState !== 'open') {
      return Promise.reject(
        new Error(
          'runtime mutation rejected while storage transition or data clear is in progress',
        ),
      );
    }
    const requested: Promise<T> = this.policyMutationQueue.then(mutation, mutation);
    this.policyMutationQueue = requested.then(
      (): void => undefined,
      (): void => undefined,
    );
    return requested;
  }

  private runtimeMutationAllowed(lease?: BlockingSweepLease): boolean {
    return (
      this.dataClearBarrierState === 'open' ||
      (lease !== undefined && this.activeRuntimeMutationLeases.has(lease))
    );
  }

  private assertRuntimeMutationAllowed(lease?: BlockingSweepLease): void {
    if (!this.runtimeMutationAllowed(lease)) {
      throw new Error(
        'runtime mutation rejected while storage transition or data clear is in progress',
      );
    }
  }

  private async applyBlockingWithLease(): Promise<void> {
    return this.trackRuntimeMutation(
      (lease: RuntimeMutationLease): Promise<void> => this.ports.applyBlocking(lease),
    );
  }

  private async flushDeferredBlockingSweep(openBarrierAfter: boolean = false): Promise<void> {
    const deferred: DeferredBlockingSweep | null = this.deferredBlockingSweep;
    if (deferred === null) {
      if (openBarrierAfter) this.openRuntimeMutationBarrier();
      return;
    }
    let retryFailure: unknown = null;
    while (this.deferredBlockingSweepRequested) {
      this.deferredBlockingSweepRequested = false;
      try {
        await this.applyBlockingWithLease();
      } catch (error: unknown) {
        this.ports.reportError(error);
        try {
          await this.applyBlockingWithLease();
        } catch (retryError: unknown) {
          this.needsBlocking = true;
          retryFailure = retryError;
          break;
        }
      }
    }
    this.deferredBlockingSweep = null;
    this.deferredBlockingSweepRequested = false;
    if (openBarrierAfter) this.openRuntimeMutationBarrier();
    if (retryFailure === null) deferred.resolve();
    else deferred.reject(retryFailure);
  }

  private openRuntimeMutationBarrier(): void {
    this.dataClearBarrierState = 'open';
    this.dataClearOperationRunning = false;
  }

  private rejectDeferredBlockingSweep(error: Error): void {
    const deferred: DeferredBlockingSweep | null = this.deferredBlockingSweep;
    if (deferred === null) return;
    this.deferredBlockingSweep = null;
    this.deferredBlockingSweepRequested = false;
    deferred.reject(error);
  }

  private trackRuntimeMutation<T>(
    operation: (lease: RuntimeMutationLease) => Promise<T>,
  ): Promise<T> {
    const lease: RuntimeMutationLease = {} as RuntimeMutationLease;
    this.activeRuntimeMutationLeases.add(lease);
    const requested: Promise<T> = (async (): Promise<T> => {
      try {
        return await operation(lease);
      } finally {
        this.activeRuntimeMutationLeases.delete(lease);
      }
    })();
    const settled: Promise<void> = requested.then(
      (): void => undefined,
      (): void => undefined,
    );
    this.runtimeMutationsInFlight.add(settled);
    void settled.then((): void => {
      this.runtimeMutationsInFlight.delete(settled);
    });
    return requested;
  }

  private async resetAfterAllDataClear(): Promise<void> {
    const now: number = this.ports.now();
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.lists = structuredClone(DEFAULT_LISTS);
    this.bank = { balanceMs: 0 };
    this.streak = null;
    this.runtime = emptyRuntimeV2(now, this.ports.newId());
    this.deviceId = await this.ports.rehydrateAfterDataClear();
    this.pendingEvents = [];
    this.dirty = false;
    this.needsBlocking = false;
    this.bankDirty = false;
    this.streakDirty = false;
    this.bankRevision = 0;
    this.runtimePersistRevision = 0;
    this.attemptRevision = 0;
    this.attemptPersistInFlight.clear();
    this.failedAttemptPersistence.clear();
    this.websiteBlockingLossPending = false;
    this.ownedRuntimeSnapshot = structuredClone(this.runtime);
    await this.persistRuntime(structuredClone(this.runtime));
  }

  private async prepareRuntimeForAllDataClear(): Promise<void> {
    const hadTabStates: boolean = Object.keys(this.runtime.tabStates).length > 0;
    const hadBlockingState: boolean =
      this.runtime.session !== null ||
      this.runtime.gate !== null ||
      this.runtime.unlocks.length > 0 ||
      hadTabStates;
    if (!hadBlockingState) return;
    const now: number = this.ports.now();
    // The all-data clear takes the session with it, and the controller owns how it ends.
    if (this.runtime.session !== null) {
      await this.controller.endForEnforcementLoss('website-access-lost');
    }
    this.runtime.gate = null;
    this.runtime.unlocks = [];
    this.dirty = true;
    this.needsBlocking = true;
    await this.commit(now);
    await this.drainRuntimeMutations();
    if (hadTabStates) {
      this.runtime.tabStates = {};
      await this.persistRuntime();
      await this.drainRuntimeMutations();
    }
  }

  private async flushDeferredBlockClaims(): Promise<void> {
    await this.runtimePersistQueue;
    if (Object.keys(this.runtime.deferredBlockClaims).length === 0) return;
    if (this.dirty) {
      try {
        await this.commit(this.ports.now());
      } catch (error: unknown) {
        this.ports.reportError(error);
        return;
      }
    }
    while (Object.keys(this.runtime.deferredBlockClaims).length > 0) {
      let replayed: boolean = false;
      for (const [key, storedClaim] of Object.entries(this.runtime.deferredBlockClaims)) {
        const claim: DeferredBlockClaim | undefined = this.runtime.deferredBlockClaims[key];
        if (claim === undefined || claim !== storedClaim) continue;
        if (this.runtime.removedTabTombstones[claim.tabId] === true) {
          delete this.runtime.deferredBlockClaims[key];
          await this.persistRuntime();
          replayed = true;
          continue;
        }
        try {
          await this.replayDeferredBlockClaim(key, claim);
          replayed = true;
        } catch (error: unknown) {
          this.ports.reportError(error);
        }
      }
      if (!replayed) {
        if (!this.dirty) return;
        try {
          await this.commit(this.ports.now());
        } catch (error: unknown) {
          this.ports.reportError(error);
          return;
        }
      }
    }
  }

  private async replayDeferredBlockClaim(key: string, claim: DeferredBlockClaim): Promise<void> {
    if (claim.stage === 'attempt') {
      const nextStage: 'stopped' | null =
        claim.kind === 'navigation' && claim.documentId !== undefined ? 'stopped' : null;
      if (nextStage === null) delete this.runtime.deferredBlockClaims[key];
      else this.runtime.deferredBlockClaims[key] = { ...claim, stage: nextStage };
      this.runtime.attemptDebounce[`${claim.tabId}:${claim.url}`] = claim.attemptAt;
      this.recordEvent({
        t: 'attempt',
        at: claim.attemptAt,
        url: claim.url,
        host: hostOf(claim.url),
        tabId: claim.tabId,
        kind: claim.kind,
        sessionId: claim.sessionId,
      });
      this.attemptRevision += 1;
      await this.commit(this.ports.now());
    }
    const stoppedClaim: DeferredBlockClaim | undefined = this.runtime.deferredBlockClaims[key];
    if (stoppedClaim?.stage !== 'stopped' || stoppedClaim.documentId === undefined) return;
    const state: RuntimeTabState | null = this.ensureTabState(stoppedClaim.tabId);
    if (state === null) {
      delete this.runtime.deferredBlockClaims[key];
      await this.persistRuntime();
      return;
    }
    state.stoppedDocumentId = stoppedClaim.documentId;
    delete this.runtime.deferredBlockClaims[key];
    try {
      await this.persistRuntime();
    } catch (error: unknown) {
      this.runtime.deferredBlockClaims[key] = stoppedClaim;
      throw error;
    }
  }

  private applyRemovedTabTombstones(): void {
    for (const tabIdText of Object.keys(this.runtime.removedTabTombstones)) {
      const tabId: number = Number(tabIdText);
      delete this.runtime.tabStates[tabId];
      for (const key of Object.keys(this.runtime.attemptDebounce)) {
        if (key.startsWith(`${tabId}:`)) {
          delete this.runtime.attemptDebounce[key];
          this.failedAttemptPersistence.delete(key);
        }
      }
      for (const [key, claim] of Object.entries(this.runtime.deferredBlockClaims)) {
        if (claim.tabId === tabId) delete this.runtime.deferredBlockClaims[key];
      }
    }
  }

  private async flushRemovedTabTombstones(): Promise<void> {
    if (Object.keys(this.runtime.removedTabTombstones).length === 0) return;
    await this.drainRuntimePersistence();
    this.applyRemovedTabTombstones();
    const flushing: Record<number, true> = this.runtime.removedTabTombstones;
    this.runtime.removedTabTombstones = {};
    try {
      await this.persistRuntime();
    } catch (error: unknown) {
      this.runtime.removedTabTombstones = {
        ...flushing,
        ...this.runtime.removedTabTombstones,
      };
      this.ownedRuntimeSnapshot.removedTabTombstones = structuredClone(
        this.runtime.removedTabTombstones,
      );
      this.applyRemovedTabTombstones();
      throw error;
    }
  }

  private async drainRuntimePersistence(): Promise<void> {
    while (true) {
      const commits: Promise<void> = this.commitQueue;
      const blocking: Promise<void> = this.blockingMutationPersistQueue;
      const runtime: Promise<void> = this.runtimePersistQueue;
      const leasedMutations: Promise<void>[] = [...this.runtimeMutationsInFlight];
      const attempts: Promise<void>[] = [...this.attemptPersistInFlight.values()].flatMap(
        (durabilities: Set<AttemptDurability>): Promise<void>[] =>
          [...durabilities].map(
            (durability: AttemptDurability): Promise<void> => durability.promise,
          ),
      );
      await Promise.all([commits, blocking, runtime, ...leasedMutations, ...attempts]);
      if (
        commits === this.commitQueue &&
        blocking === this.blockingMutationPersistQueue &&
        runtime === this.runtimePersistQueue &&
        this.runtimeMutationsInFlight.size === 0 &&
        this.attemptPersistInFlight.size === 0
      ) {
        return;
      }
    }
  }

  private async drainRuntimeMutations(): Promise<void> {
    while (true) {
      const policy: Promise<void> = this.policyMutationQueue;
      const commits: Promise<void> = this.commitQueue;
      const blocking: Promise<void> = this.blockingMutationPersistQueue;
      const runtime: Promise<void> = this.runtimePersistQueue;
      const leasedMutations: Promise<void>[] = [...this.runtimeMutationsInFlight];
      const attempts: Promise<void>[] = [...this.attemptPersistInFlight.values()].flatMap(
        (durabilities: Set<AttemptDurability>): Promise<void>[] =>
          [...durabilities].map(
            (durability: AttemptDurability): Promise<void> => durability.promise,
          ),
      );
      await Promise.all([policy, commits, blocking, runtime, ...leasedMutations, ...attempts]);
      if (
        policy === this.policyMutationQueue &&
        commits === this.commitQueue &&
        blocking === this.blockingMutationPersistQueue &&
        runtime === this.runtimePersistQueue &&
        this.runtimeMutationsInFlight.size === 0 &&
        this.attemptPersistInFlight.size === 0
      ) {
        return;
      }
    }
  }

  private pruneDebounce(now: number): void {
    for (const [key, at] of Object.entries(this.runtime.attemptDebounce)) {
      if (now - at >= ATTEMPT_DEBOUNCE_MS) {
        delete this.runtime.attemptDebounce[key];
        this.failedAttemptPersistence.delete(key);
      }
    }
  }
}

/** The attempts the current day has recorded, which the frozen views report. */
function attemptsTodayOf(todayAgg: DailyAgg | null): number {
  if (todayAgg === null) return 0;
  return Object.values(todayAgg.attempts).reduce(
    (total: number, count: number): number => total + count,
    0,
  );
}

function hostOf(url: string): string {
  try {
    const registrable: string | null = registrableHost(url);
    if (registrable !== null) return registrable;
  } catch {
    // Malformed external input falls through to URL parsing.
  }
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Focus through one instant, capped by whichever finite boundary the phase carries. */
function _focusedMsAt(session: SessionState, now: number): number {
  if (session.phase !== 'focus') return session.focusedMs;
  const boundaries: number[] = [now, session.phaseEndsAt, session.sessionEndsAt].filter(
    (boundary: number | null): boundary is number => boundary !== null,
  );
  return session.focusedMs + Math.max(0, Math.min(...boundaries) - session.phaseStartedAt);
}

function sessionIdentity(session: SessionState | null): { sessionId?: string } {
  return session?.sessionId === undefined ? {} : { sessionId: session.sessionId };
}
