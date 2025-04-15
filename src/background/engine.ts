import { accrue, spend } from '../core/budget';
import { ALL_CATEGORIES } from '../core/categories';
import {
  buildMatcherCache,
  type CompiledMatcher,
  compileSessionMatcher,
  evaluateUrl,
  type MatcherCacheBundle,
  normalizeSessionRules,
  registrableHost,
  type StoredMatcherCache,
  sessionRulesMatchLists,
} from '../core/matcher';
import { activeEntry, nextStart, windowEnd } from '../core/schedule';
import {
  advance,
  beginPause,
  endPauseEarly,
  type MachineEvent,
  startSession as machineStart,
  startNextFocusEarly as machineStartNextFocusEarly,
} from '../core/session';
import { addEvent, capAttempts, emptyDaily } from '../core/stats';
import { emptyStreak } from '../core/streak';
import {
  ATTEMPT_DEBOUNCE_MS,
  cancelPhrase,
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  GATE_EXPIRY_MS,
  rulesFromLists,
  TOP_SITES_DAILY,
} from '../shared/constants';
import { CoreError } from '../shared/errors';
import type { Ack, SoundId } from '../shared/messages';
import { isListsConfig } from '../shared/runtime-validation';
import { syncAggKey } from '../shared/storage-keys';
import { localDateStr, localMonthStr } from '../shared/time';
import type {
  BankState,
  DailyAgg,
  EventRecord,
  GateKind,
  GateState,
  ListsConfig,
  ScheduleEntry,
  SessionConfig,
  SessionRuleSnapshot,
  SessionSnapshot,
  SessionState,
  Settings,
  SiteUnlock,
  StreakState,
  Strictness,
  ThemeMode,
  Verdict,
} from '../shared/types';
import { listsChangeAllowed, settingsChangeAllowed } from './guard';
import { encodeListsForSync, LIST_SYNC_KEYS, type ListsSyncEncoding } from './list-sync-codec';
import type { PolicyValueByKey } from './policy-storage';
import {
  clockRebaseArchiveKey,
  planBackwardDateRebase,
  planRollover,
  type RolloverPlan,
} from './rollover';
import {
  emptyRuntime,
  type RuntimeCommitCheckpoint,
  type RuntimeState,
  type RuntimeTabState,
} from './stores';
import { chooseNewerStreak, rebaseStreakForDate } from './streak-sync';
import { assertSyncItemWithinQuota, SyncQuotaError } from './sync-quota';

export interface EnginePorts {
  now(): number;
  newId(): string;
  saveRuntime(r: RuntimeState): Promise<void>;
  saveMatcherCache(cache: StoredMatcherCache, lists: ListsConfig): Promise<void>;
  savePolicy?<K extends keyof PolicyValueByKey>(key: K, value: PolicyValueByKey[K]): Promise<void>;
  hasPendingSync(key: string): boolean;
  queueSync(key: string, value: unknown): void;
  supersedeSync(key: string, value: unknown): void;
  removeSync(key: string): void;
  persistSyncJournal(): Promise<void>;
  appendEvents(evs: EventRecord[]): Promise<void>;
  broadcast(snapshot: SessionSnapshot): void;
  applyBlocking(): Promise<void>;
  playSound(sound: SoundId): void;
  notify(title: string, message: string): void;
  updateIcon(snapshot: SessionSnapshot): void;
  scheduleWake(atMs: number | null): void;
  /** run the weekly sync-storage retention prune */
  prune(retentionDays: number, now: number): Promise<void>;
  reportError(error: unknown): void;
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

const NO_SESSION_VERDICT: Verdict = { blocked: false, reason: 'no-session', matchedPattern: null };

function strictnessStrength(strictness: Strictness): number {
  if (strictness === 'flexible') return 0;
  if (strictness === 'friction') return 1;
  return 2;
}

function scheduleOccurrenceToken(entry: ScheduleEntry, now: number): string {
  const endsAt: number = windowEnd(entry, new Date(now)).getTime();
  return `${entry.id}@${endsAt}`;
}

/**
 * Authoritative session engine. Pure src/core modules make every domain
 * decision, this class wires them to persistence and effects through
 * EnginePorts. Every public entry point runs catchUp() first, so a
 * worker woken after missed alarms is consistent before it answers.
 */
export class Engine {
  private activeMatcher: CompiledMatcher | null = null;
  private activeMatcherSessionIdentity: string | null = null;
  private activeMatcherRules: SessionRuleSnapshot | null = null;
  private activeMatcherMode: SessionConfig['mode'] | null = null;
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
  private applyingBlocking = false;
  private bankDirty = false;
  private streakDirty = false;
  private bankRevision = 0;
  private runtimePersistRevision = 0;
  private ownedRuntimeSnapshot: RuntimeState;
  private policyMutationQueue: Promise<void> = Promise.resolve();
  private listCachePersistenceInFlight = false;
  private inboundPolicyTransactionActive = false;
  private suppressPolicyPublication = false;
  private dataClearBarrierState: 'open' | 'draining' | 'quiesced' = 'open';
  private dataClearOperationRunning = false;

  constructor(
    private readonly ports: EnginePorts,
    private settings: Settings,
    private lists: ListsConfig,
    private bank: BankState,
    private streak: StreakState | null,
    private runtime: RuntimeState,
    private deviceId: string,
    private readonly compileSessionPolicy: SessionMatcherCompiler = compileSessionMatcher,
  ) {
    const checkpoint: RuntimeCommitCheckpoint | null = this.runtime.commitCheckpoint;
    if (checkpoint !== null) {
      this.pendingEvents = [...checkpoint.events];
      if (checkpoint.syncBank) {
        this.bank = checkpoint.bank;
        this.bankDirty = true;
        this.bankRevision = 1;
      }
      this.dirty = true;
    }
    this.setSettingsAndClampBank(this.settings);
    if (this.runtime.session !== null && this.runtime.session.sessionId === undefined) {
      const startedAt: number = this.runtime.session.startedAt;
      const sessionId: string = this.ports.newId();
      this.runtime.session = { ...this.runtime.session, sessionId };
      this.pendingEvents.push({
        t: 'sessionIdentityAssigned',
        at: this.ports.now(),
        startedAt,
        sessionId,
      });
      this.runtime.commitCheckpoint = {
        bank: structuredClone(this.bank),
        events: [...this.pendingEvents],
        syncBank: this.bankDirty,
      };
      this.dirty = true;
    }
    this.activateMatcher(this.runtime.session);
    this.ownedRuntimeSnapshot = structuredClone(this.runtime);
  }

  reportError(error: unknown): void {
    this.ports.reportError(error);
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
      this.dataClearBarrierState = 'quiesced';
      const result: T = await operation();
      this.resetAfterAllDataClear();
      return result;
    } catch (error: unknown) {
      if (startingOpen && !retainQuiescence()) this.dataClearBarrierState = 'open';
      throw error;
    } finally {
      this.dataClearOperationRunning = false;
    }
  }

  snapshot(): SessionSnapshot {
    const now: number = this.ports.now();
    this.catchUp(now);
    const snap: SessionSnapshot = this.buildSnapshot(now);
    if (this.dataClearBarrierState !== 'quiesced' && this.dirty) this.commitInBackground(now);
    return snap;
  }

  async snapshotPersisted(): Promise<SessionSnapshot> {
    this.assertRuntimeMutationAllowed();
    const now: number = this.ports.now();
    this.catchUp(now);
    if (this.dirty) await this.commit(now);
    else await this.commitQueue;
    return this.buildSnapshot(now);
  }

  verdictFor(url: string): Verdict {
    const now: number = this.ports.now();
    this.catchUp(now);
    if (this.dataClearBarrierState !== 'quiesced' && this.dirty) this.commitInBackground(now);
    const session: SessionState | null = this.runtime.session;
    if (session === null || session.phase !== 'focus') return NO_SESSION_VERDICT;
    return evaluateUrl(this.ensureMatcher(session), url, this.runtime.unlocks, now);
  }

  async startSession(config: SessionConfig): Promise<Ack> {
    return this.enqueuePolicyMutation((): Promise<Ack> => this.startSessionNow(config));
  }

  private async startSessionNow(config: SessionConfig): Promise<Ack> {
    const now: number = this.ports.now();
    this.catchUp(now);
    if (this.runtime.session !== null) return this.fail(now, 'a session is already running');
    if (config.source !== 'manual' || config.scheduleEntryId !== null) {
      return this.fail(now, 'invalid manual session');
    }
    const rules: SessionRuleSnapshot | null = normalizeSessionRules(config.rules);
    if (rules === null) return this.fail(now, 'invalid session rules');
    if (!sessionRulesMatchLists(rules, this.lists)) {
      return this.fail(
        now,
        'Your default blocking lists changed. Review this session and start again.',
      );
    }
    const normalizedConfig: SessionConfig = { ...config, rules };
    const sessionId: string = this.ports.newId();
    this.runtime.session = machineStart(normalizedConfig, now, sessionId);
    this.activateMatcher(this.runtime.session);
    this.runtime.gate = null;
    this.runtime.unlocks = [];
    this.runtime.accruedFocusMs = 0;
    this.recordEvent({
      t: 'sessionStarted',
      at: now,
      source: normalizedConfig.source,
      mode: normalizedConfig.mode,
      strictness: normalizedConfig.strictness,
      durationMin: normalizedConfig.durationMin,
      intention: normalizedConfig.intention,
      sessionId,
    });
    this.dirty = true;
    this.needsBlocking = true;
    await this.commit(now);
    return { ok: true };
  }

  async openGate(gate: GateKind, host: string | null): Promise<Ack> {
    this.assertRuntimeMutationAllowed();
    const now: number = this.ports.now();
    this.catchUp(now);
    const session: SessionState | null = this.runtime.session;
    if (session === null) return this.fail(now, 'no session is running');
    if (gate === 'cancel') {
      return this.endSessionByStrictness(session, now);
    }
    if (session.phase !== 'focus') return this.fail(now, 'pauses only apply during focus');
    if (gate === 'unlockSite' && host === null) return this.fail(now, 'no site given to unlock');
    const cost: number =
      gate === 'pause' ? this.settings.pause.pauseMs : this.settings.pause.unlockMs;
    if (this.bank.balanceMs < cost) return this.fail(now, 'not enough pause budget yet');
    const needsPhrase: boolean = this.settings.gate.requireTypedPhrase;
    const unlockHost: string | null =
      gate === 'unlockSite' && host !== null ? (registrableHost(host) ?? host) : null;
    this.runtime.gate = {
      kind: gate,
      host: unlockHost,
      openedAt: now,
      readyAt: now + this.settings.gate.delayMs,
      requiredPhrase: needsPhrase ? cancelPhrase(session.config.intention) : null,
      forceEndAvailable: false,
    };
    this.recordEvent({ t: 'gateOpened', at: now, gate, ...sessionIdentity(session) });
    this.dirty = true;
    await this.commit(now);
    return { ok: true };
  }

  async requestSessionEnd(): Promise<Ack> {
    this.assertRuntimeMutationAllowed();
    const now: number = this.ports.now();
    this.catchUp(now);
    const session: SessionState | null = this.runtime.session;
    if (session === null) return this.fail(now, 'no session is running');
    return this.endSessionByStrictness(session, now);
  }

  private async endSessionByStrictness(session: SessionState, now: number): Promise<Ack> {
    if (session.config.strictness === 'hard') {
      return this.fail(now, 'hard sessions cannot be canceled');
    }
    if (session.config.strictness === 'flexible') {
      this.cancelSession(session, now);
      this.dirty = true;
      this.needsBlocking = true;
      await this.commit(now);
      return { ok: true };
    }
    return this.openCancelGate(session, now);
  }

  private async openCancelGate(session: SessionState, now: number): Promise<Ack> {
    if (this.runtime.gate?.kind === 'cancel') {
      if (this.dirty) await this.commit(now);
      return { ok: true };
    }
    this.runtime.gate = {
      kind: 'cancel',
      host: null,
      openedAt: now,
      readyAt: now + this.settings.gate.delayMs,
      requiredPhrase: this.settings.gate.requireTypedPhrase
        ? cancelPhrase(session.config.intention)
        : null,
      forceEndAvailable: false,
    };
    this.recordEvent({ t: 'gateOpened', at: now, gate: 'cancel', ...sessionIdentity(session) });
    this.dirty = true;
    await this.commit(now);
    return { ok: true };
  }

  async forceEndGate(): Promise<Ack> {
    return {
      ok: false,
      error: 'Force end is no longer available. Choose a Flexible session before starting.',
    };
  }

  async confirmGate(typedPhrase: string | null): Promise<Ack> {
    this.assertRuntimeMutationAllowed();
    const now: number = this.ports.now();
    this.catchUp(now);
    const gate: GateState | null = this.runtime.gate;
    const session: SessionState | null = this.runtime.session;
    if (gate === null) return this.fail(now, 'no gate is open');
    if (session === null) {
      this.runtime.gate = null;
      this.dirty = true;
      return this.fail(now, 'the session already ended');
    }
    if (gate.kind === 'cancel' && session.config.strictness === 'hard') {
      this.runtime.gate = null;
      this.dirty = true;
      return this.fail(now, 'hard sessions cannot be canceled');
    }
    if (now < gate.readyAt) return this.fail(now, 'the deliberation delay has not finished');
    if (gate.requiredPhrase !== null && typedPhrase !== gate.requiredPhrase) {
      return this.fail(now, 'that is not the exact phrase');
    }
    try {
      this.executeGate(gate, session, now);
    } catch (err: unknown) {
      if (err instanceof CoreError) return this.fail(now, err.message);
      throw err;
    }
    this.runtime.gate = null;
    this.dirty = true;
    this.needsBlocking = true;
    await this.commit(now);
    return { ok: true };
  }

  private executeGate(gate: GateState, session: SessionState, now: number): void {
    if (gate.kind === 'pause') {
      this.bank = spend(this.bank, this.settings.pause.pauseMs);
      this.bankDirty = true;
      this.bankRevision += 1;
      this.runtime.session = beginPause(session, now, this.settings.pause.pauseMs);
      this.recordEvent({
        t: 'phase',
        at: now,
        from: session.phase,
        to: 'paused',
        ...sessionIdentity(session),
      });
      this.recordEvent({
        t: 'pauseTaken',
        at: now,
        ms: this.settings.pause.pauseMs,
        ...sessionIdentity(session),
      });
    } else if (gate.kind === 'unlockSite') {
      const host: string = gate.host ?? '';
      this.bank = spend(this.bank, this.settings.pause.unlockMs);
      this.bankDirty = true;
      this.bankRevision += 1;
      this.runtime.unlocks = [
        ...this.runtime.unlocks,
        { host, until: now + this.settings.pause.unlockMs },
      ];
      this.recordEvent({
        t: 'unlockTaken',
        at: now,
        host,
        ms: this.settings.pause.unlockMs,
        ...sessionIdentity(session),
      });
    } else this.cancelSession(session, now);
  }

  private cancelSession(session: SessionState, now: number): void {
    this.recordEvent({
      t: 'sessionCanceled',
      at: now,
      focusedMs: focusedMsAt(session, now),
      ...sessionIdentity(session),
    });
    this.runtime.session = null;
    this.activateMatcher(null);
    this.runtime.gate = null;
    this.runtime.unlocks = [];
    this.runtime.accruedFocusMs = 0;
    if (session.config.source !== 'schedule') {
      this.runtime.scheduleActiveEntryId = null;
      return;
    }
    const entryId: string | null = session.config.scheduleEntryId;
    const existingMarker: string | null = this.runtime.scheduleActiveEntryId;
    if (entryId === null || (existingMarker !== null && existingMarker !== entryId)) return;
    const sourceEntry: ScheduleEntry | undefined = this.settings.schedule.find(
      (entry: ScheduleEntry): boolean => entry.id === entryId,
    );
    this.runtime.scheduleActiveEntryId =
      sourceEntry === undefined ? entryId : scheduleOccurrenceToken(sourceEntry, now);
  }

  async abandonGate(): Promise<Ack> {
    this.assertRuntimeMutationAllowed();
    const now: number = this.ports.now();
    this.catchUp(now);
    if (this.runtime.gate !== null) {
      this.recordEvent({
        t: 'gateResisted',
        at: now,
        gate: this.runtime.gate.kind,
        ...sessionIdentity(this.runtime.session),
      });
      this.runtime.gate = null;
      this.dirty = true;
    }
    if (this.dirty) await this.commit(now);
    return { ok: true };
  }

  async resumeFromPause(): Promise<Ack> {
    this.assertRuntimeMutationAllowed();
    const now: number = this.ports.now();
    this.catchUp(now);
    const session: SessionState | null = this.runtime.session;
    if (session === null || session.phase !== 'paused') {
      return this.fail(now, 'no pause is running');
    }
    const restored: SessionState = endPauseEarly(session, now);
    this.recordEvent({
      t: 'phase',
      at: now,
      from: 'paused',
      to: restored.phase,
      ...sessionIdentity(session),
    });
    this.runtime.session = restored;
    this.dirty = true;
    this.needsBlocking = true;
    await this.commit(now);
    return { ok: true };
  }

  async startNextFocusEarly(): Promise<Ack> {
    this.assertRuntimeMutationAllowed();
    const now: number = this.ports.now();
    this.catchUp(now);
    const session: SessionState | null = this.runtime.session;
    if (session === null || session.phase !== 'break') return this.fail(now, 'no break is running');
    try {
      this.runtime.session = machineStartNextFocusEarly(session, now);
    } catch (err: unknown) {
      if (err instanceof CoreError) return this.fail(now, err.message);
      throw err;
    }
    this.recordEvent({
      t: 'phase',
      at: now,
      from: 'break',
      to: 'focus',
      ...sessionIdentity(session),
    });
    this.dirty = true;
    this.needsBlocking = true;
    await this.commit(now);
    return { ok: true };
  }

  async recordAttempt(url: string, tabId: number, kind: 'navigation' | 'existing'): Promise<void> {
    this.assertRuntimeMutationAllowed();
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
    const persistence: Promise<void> = this.applyingBlocking
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

  async markStopped(tabId: number, _url: string, documentId?: string): Promise<void> {
    this.assertRuntimeMutationAllowed();
    if (typeof documentId !== 'string' || documentId === '') return;
    const state: RuntimeTabState = this.ensureTabState(tabId);
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

  async claimMute(tabId: number, url: string, priorMuted: boolean): Promise<boolean> {
    this.assertRuntimeMutationAllowed();
    const existing: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (existing !== undefined && existing.priorMuted !== null && existing.muteUrl !== url) {
      return false;
    }
    const state: RuntimeTabState = this.ensureTabState(tabId);
    state.muteUrl = url;
    state.priorMuted = priorMuted;
    await this.persistRuntime();
    return true;
  }

  async releaseMuteClaim(tabId: number, url: string): Promise<void> {
    this.assertRuntimeMutationAllowed();
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state === undefined || state.muteUrl !== url) return;
    state.muteUrl = null;
    state.priorMuted = null;
    this.dropEmptyTabState(tabId, state);
    await this.persistRuntime();
  }

  async transferMuteClaim(tabId: number, fromUrl: string, toUrl: string): Promise<void> {
    this.assertRuntimeMutationAllowed();
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state === undefined) return;
    if (state.muteUrl === fromUrl) state.muteUrl = toUrl;
    if (state.muteUrl !== toUrl || state.priorMuted === null) return;
    await this.persistRuntime();
  }

  async settleMuteClaim(tabId: number, finalUrl: string | null): Promise<void> {
    this.assertRuntimeMutationAllowed();
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
  noteMuteRestored(tabId: number, url: string): void {
    if (this.dataClearBarrierState === 'quiesced') return;
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state === undefined || state.muteUrl !== url) return;
    state.muteUrl = null;
    state.priorMuted = null;
    this.dropEmptyTabState(tabId, state);
  }

  noteReloaded(tabId: number, documentId: string): void {
    if (this.dataClearBarrierState === 'quiesced') return;
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state === undefined || state.stoppedDocumentId !== documentId) return;
    state.stoppedDocumentId = null;
    this.dropEmptyTabState(tabId, state);
  }

  reconcileTabs(
    liveTabs: ReadonlyMap<number, LiveTabState>,
    protectedTabIds: ReadonlySet<number> = new Set(),
  ): void {
    if (this.dataClearBarrierState === 'quiesced') return;
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

  rebindTab(tabId: number, url: string): void {
    if (this.dataClearBarrierState === 'quiesced') return;
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state !== undefined && state.priorMuted !== null) state.muteUrl = url;
  }

  flushRuntime(): Promise<void> {
    this.assertRuntimeMutationAllowed();
    return this.persistRuntime();
  }

  /** Purges a closed tab from mute, stopped, and debounce bookkeeping. */
  async dropTab(tabId: number): Promise<void> {
    this.assertRuntimeMutationAllowed();
    delete this.runtime.tabStates[tabId];
    for (const key of Object.keys(this.runtime.attemptDebounce)) {
      if (key.startsWith(`${tabId}:`)) {
        delete this.runtime.attemptDebounce[key];
        this.failedAttemptPersistence.delete(key);
      }
    }
    await this.persistDroppedTab(tabId);
  }

  private ensureTabState(tabId: number): RuntimeTabState {
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
    const now: number = this.ports.now();
    this.catchUp(now);
    this.pruneDebounce(now);
    await this.maybePrune(now);
    await this.commit(now);
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
    this.catchUp(now);
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
    return this.enqueuePolicyMutation(
      (): Promise<Ack> => this.updateSettingsNow({ ...this.settings, theme }),
    );
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
    this.catchUp(now);
    const reason: string | null = listsChangeAllowed(
      this.runtime.session,
      this.runtime.session?.config.mode ?? null,
      this.lists,
      l,
    );
    if (reason !== null) return this.fail(now, reason);
    const bundle: MatcherCacheBundle = buildMatcherCache(l, ALL_CATEGORIES);
    this.listCachePersistenceInFlight = true;
    try {
      await this.ports.saveMatcherCache(bundle.stored, l);
    } finally {
      this.listCachePersistenceInFlight = false;
    }
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
    this.catchUp(committedAt);
    await this.commit(committedAt);
    return { ok: true };
  }

  async applySyncedSettings(settings: Settings): Promise<Ack> {
    this.assertRuntimeMutationAllowed();
    const now: number = this.ports.now();
    this.catchUp(now);
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
    this.catchUp(now);
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
      this.catchUp(admittedAt);
      this.inboundPolicyTransactionActive = true;
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
        this.inboundPolicyTransactionActive = false;
        const completedAt: number = this.ports.now();
        this.catchUp(completedAt);
        if (this.dirty) await this.commit(completedAt);
      }
    });
  }

  private async prepareSyncedListBundle(lists: ListsConfig): Promise<MatcherCacheBundle> {
    const bundle: MatcherCacheBundle = buildMatcherCache(lists, ALL_CATEGORIES);
    this.listCachePersistenceInFlight = true;
    try {
      await this.ports.saveMatcherCache(bundle.stored, lists);
    } finally {
      this.listCachePersistenceInFlight = false;
    }
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
    this.catchUp(now);
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
    this.catchUp(now);
    if (this.dataClearBarrierState !== 'quiesced' && this.dirty) this.commitInBackground(now);
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

  // --- catch-up: settle accrual, advance the machine, expire gates and unlocks ---

  private catchUp(now: number): void {
    if (this.dataClearBarrierState === 'quiesced') return;
    const today: string = localDateStr(now);
    if (this.runtime.date > today) this.rebaseDateBackward(today, now);
    while (this.runtime.date !== today) {
      const boundary: number = localMidnightAfter(this.runtime.date);
      this.settleSession(boundary);
      this.expireGate(boundary);
      this.expireUnlocks(boundary);
      this.rolloverCheck(boundary);
    }
    this.settleSession(now);
    this.expireGate(now);
    this.expireUnlocks(now);
    if (!this.listCachePersistenceInFlight && !this.inboundPolicyTransactionActive) {
      this.scheduleCheck(now);
    }
  }

  private rebaseDateBackward(today: string, now: number): void {
    const futureDate: string = this.runtime.date;
    const plan: ReturnType<typeof planBackwardDateRebase> = planBackwardDateRebase(
      today,
      this.runtime.todayAgg ?? emptyDaily(futureDate),
    );
    this.ports.removeSync(syncAggKey(this.deviceId, futureDate));
    this.ports.queueSync(
      clockRebaseArchiveKey(this.deviceId, futureDate, now, this.ports.newId()),
      plan.archive,
    );
    this.runtime.date = today;
    this.runtime.todayAgg = plan.newAgg;
    this.runtime.attemptDebounce = {};
    this.failedAttemptPersistence.clear();
    this.runtime.lastPruneDate = null;
    this.rebaseStreakBackward(today);
    this.dirty = true;
  }

  private rebaseStreakBackward(today: string): void {
    if (this.streak === null) return;
    this.streak = rebaseStreakForDate(this.streak, today);
    this.streakDirty = true;
  }

  private settleSession(now: number): void {
    const session: SessionState | null = this.runtime.session;
    if (session === null) return;
    const { next, events }: ReturnType<typeof advance> = advance(session, now);
    const completed: MachineEvent | undefined = events.find(
      (e: MachineEvent): boolean => e.type === 'completed',
    );
    const focusedNow: number =
      completed?.type === 'completed' ? completed.focusedMs : focusedMsAt(next ?? session, now);
    const delta: number = Math.max(0, focusedNow - this.runtime.accruedFocusMs);
    if (delta > 0) {
      const previousBalanceMs: number = this.bank.balanceMs;
      this.bank = accrue(this.bank, delta, this.settings.pause);
      const earnedMs: number = this.bank.balanceMs - previousBalanceMs;
      this.runtime.accruedFocusMs = focusedNow;
      const aggregate: DailyAgg = this.runtime.todayAgg ?? emptyDaily(this.runtime.date);
      this.runtime.todayAgg = { ...aggregate, focusMs: aggregate.focusMs + delta };
      if (earnedMs > 0) {
        this.bankDirty = true;
        this.bankRevision += 1;
        this.recordEvent({
          t: 'budgetEarned',
          at: now,
          ms: earnedMs,
          ...sessionIdentity(session),
        });
      }
      this.dirty = true;
    }
    if (next !== session) {
      this.runtime.session = next;
      if (next === null) this.activateMatcher(null);
      this.dirty = true;
    }
    for (const ev of events) this.routeMachineEvent(ev, session);
  }

  private routeMachineEvent(ev: MachineEvent, session: SessionState): void {
    if (ev.type === 'phaseChanged') {
      this.recordEvent({
        t: 'phase',
        at: ev.at,
        from: ev.from,
        to: ev.to,
        ...sessionIdentity(session),
      });
      if (ev.from === 'focus' && ev.to === 'break') this.ports.playSound('breakStart');
      if (ev.from === 'break' && ev.to === 'focus') this.ports.playSound('breakEnd');
    } else {
      this.recordEvent({
        t: 'sessionCompleted',
        at: ev.at,
        focusedMs: ev.focusedMs,
        ...sessionIdentity(session),
      });
      this.ports.playSound('sessionComplete');
      if (this.settings.sessionCompleteNotification) {
        this.ports.notify('Focus session complete', 'The lock is off. Time for a real break.');
      }
      this.runtime.gate = null;
      this.runtime.unlocks = [];
      this.runtime.accruedFocusMs = 0;
      this.runtime.scheduleActiveEntryId = null;
    }
    this.dirty = true;
    this.needsBlocking = true;
  }

  private expireGate(now: number): void {
    const gate: GateState | null = this.runtime.gate;
    if (gate === null || now <= gate.readyAt + GATE_EXPIRY_MS) return;
    this.recordEvent({
      t: 'gateResisted',
      at: now,
      gate: gate.kind,
      ...sessionIdentity(this.runtime.session),
    });
    this.runtime.gate = null;
    this.dirty = true;
  }

  private expireUnlocks(now: number): void {
    const live: SiteUnlock[] = this.runtime.unlocks.filter(
      (u: SiteUnlock): boolean => u.until > now,
    );
    if (live.length !== this.runtime.unlocks.length) {
      this.runtime.unlocks = live;
      this.dirty = true;
      this.needsBlocking = true;
    }
  }

  private scheduleCheck(now: number): void {
    const entries: ScheduleEntry[] = this.settings.schedule.filter(
      (e: ScheduleEntry): boolean => e.enabled,
    );
    const active: ScheduleEntry | null =
      entries.length === 0 ? null : activeEntry(entries, new Date(now));
    const session: SessionState | null = this.runtime.session;
    if (active === null) {
      if (this.runtime.scheduleActiveEntryId !== null && session === null) {
        this.runtime.scheduleActiveEntryId = null;
        this.dirty = true;
      }
      return;
    }
    if (session === null) {
      const occurrenceToken: string = scheduleOccurrenceToken(active, now);
      if (this.runtime.scheduleActiveEntryId === occurrenceToken) return;
      if (this.runtime.scheduleActiveEntryId === active.id) {
        // Legacy markers did not identify an occurrence. Suppress the current
        // window once, then the absolute token allows later occurrences.
        this.runtime.scheduleActiveEntryId = occurrenceToken;
        this.dirty = true;
        return;
      }
      this.startFromScheduleEntry(active, now);
      return;
    }
    if (
      session.config.source === 'schedule' &&
      session.config.scheduleEntryId === active.id &&
      this.runtime.scheduleActiveEntryId !== scheduleOccurrenceToken(active, now)
    ) {
      this.runtime.scheduleActiveEntryId = scheduleOccurrenceToken(active, now);
      this.dirty = true;
    }
    // One session at a time. An active schedule may strengthen the running
    // session, never weaken it.
    if (strictnessStrength(active.strictness) > strictnessStrength(session.config.strictness)) {
      this.runtime.session = {
        ...session,
        config: { ...session.config, strictness: active.strictness },
      };
      if (active.strictness === 'hard' && this.runtime.gate?.kind === 'cancel') {
        this.runtime.gate = null;
      }
      this.dirty = true;
    }
  }

  private startFromScheduleEntry(entry: ScheduleEntry, now: number): void {
    const endsAt: number = windowEnd(entry, new Date(now)).getTime();
    const rules: SessionRuleSnapshot | null = normalizeSessionRules(rulesFromLists(this.lists));
    if (rules === null) {
      this.ports.reportError(new Error('cannot start schedule from invalid blocking lists'));
      return;
    }
    const config: SessionConfig = {
      mode: entry.mode,
      strictness: entry.strictness,
      durationMin: Math.max(0, (endsAt - now) / 60_000),
      cycling: entry.cycling,
      intention: entry.intention,
      source: 'schedule',
      scheduleEntryId: entry.id,
      rules,
    };
    const sessionId: string = this.ports.newId();
    this.runtime.session = machineStart(config, now, sessionId);
    this.activateMatcher(this.runtime.session);
    this.runtime.accruedFocusMs = 0;
    this.runtime.scheduleActiveEntryId = scheduleOccurrenceToken(entry, now);
    this.recordEvent({
      t: 'sessionStarted',
      at: now,
      source: 'schedule',
      mode: config.mode,
      strictness: config.strictness,
      durationMin: config.durationMin,
      intention: config.intention,
      sessionId,
    });
    this.ports.playSound('scheduleStart');
    this.ports.notify('Focus schedule started', `Locked until ${entry.end}.`);
    this.dirty = true;
    this.needsBlocking = true;
  }

  private rolloverCheck(now: number): void {
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
    this.ports.queueSync(syncAggKey(this.deviceId, plan.finished.date), plan.finished);
    this.streak = plan.streak;
    this.streakDirty = true;
    this.runtime.todayAgg = plan.newAgg;
    this.runtime.date = today;
    this.dirty = true;
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

  private async flushEvents(
    aggregate: DailyAgg | null,
    date: string,
    batch: EventRecord[],
  ): Promise<void> {
    if (aggregate !== null) {
      this.ports.queueSync(
        syncAggKey(this.deviceId, date),
        capAttempts(aggregate, TOP_SITES_DAILY),
      );
    }
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
    const snap: SessionSnapshot = this.buildSnapshot(now);
    this.resolveAttemptDurability(attemptRevision);
    this.ports.broadcast(snap);
    this.ports.updateIcon(snap);
    const wakeCandidates: number[] = this.runtime.unlocks.map(
      (unlock: SiteUnlock): number => unlock.until,
    );
    if (this.runtime.session?.phaseEndsAt !== undefined) {
      wakeCandidates.push(this.runtime.session.phaseEndsAt);
    }
    this.ports.scheduleWake(wakeCandidates.length === 0 ? null : Math.min(...wakeCandidates));
    if (block) {
      this.applyingBlocking = true;
      try {
        await this.ports.applyBlocking();
      } finally {
        this.applyingBlocking = false;
      }
    }
    if (this.dirty) {
      const updatedAttemptRevision: number = this.attemptRevision;
      await this.persistDomainState();
      this.dirty = false;
      const updated: SessionSnapshot = this.buildSnapshot(this.ports.now());
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
    this.runtime.commitCheckpoint = { bank, events, syncBank };
    const checkpointRuntime: RuntimeState = structuredClone(this.runtime);
    this.ownedRuntimeSnapshot = structuredClone(checkpointRuntime);
    await this.persistRuntime(checkpointRuntime);
    if (syncBank) await this.savePolicy('bank', bank);
    if (this.streakDirty && this.streak !== null) {
      await this.savePolicy('streak', this.streak);
      this.streakDirty = false;
    }
    await this.flushEvents(aggregate, date, events);
    await this.ports.persistSyncJournal();
    for (const event of events) {
      const index: number = this.pendingEvents.indexOf(event);
      if (index >= 0) this.pendingEvents.splice(index, 1);
    }
    if (this.bankRevision === bankRevision) this.bankDirty = false;
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

  private persistRuntime(snapshot?: RuntimeState): Promise<void> {
    if (snapshot === undefined) {
      this.runtimePersistRevision += 1;
      this.ownedRuntimeSnapshot.tabStates = structuredClone(this.runtime.tabStates);
      return this.queueRuntimeSnapshot(structuredClone(this.ownedRuntimeSnapshot));
    }
    return this.queueRuntimeSnapshot(snapshot);
  }

  private persistDroppedTab(tabId: number): Promise<void> {
    this.runtimePersistRevision += 1;
    this.ownedRuntimeSnapshot.tabStates = structuredClone(this.runtime.tabStates);
    for (const key of Object.keys(this.ownedRuntimeSnapshot.attemptDebounce)) {
      if (key.startsWith(`${tabId}:`)) delete this.ownedRuntimeSnapshot.attemptDebounce[key];
    }
    return this.queueRuntimeSnapshot(structuredClone(this.ownedRuntimeSnapshot));
  }

  private queueRuntimeSnapshot(snapshot: RuntimeState): Promise<void> {
    const requested: Promise<void> = this.runtimePersistQueue.then(
      (): Promise<void> => this.ports.saveRuntime(snapshot),
    );
    this.runtimePersistQueue = requested.catch((): void => {});
    return requested.catch((error: unknown): never => {
      this.dirty = true;
      throw error;
    });
  }

  private sessionIdentityKey(session: SessionState): string {
    return session.sessionId ?? `legacy:${session.startedAt}`;
  }

  private activateMatcher(session: SessionState | null): void {
    if (session === null) {
      this.activeMatcher = null;
      this.activeMatcherSessionIdentity = null;
      this.activeMatcherRules = null;
      this.activeMatcherMode = null;
      return;
    }
    this.activeMatcher = this.compileSessionPolicy(
      session.config.rules,
      ALL_CATEGORIES,
      session.config.mode,
    );
    this.activeMatcherSessionIdentity = this.sessionIdentityKey(session);
    this.activeMatcherRules = session.config.rules;
    this.activeMatcherMode = session.config.mode;
  }

  private ensureMatcher(session: SessionState): CompiledMatcher {
    if (
      this.activeMatcher === null ||
      this.activeMatcherSessionIdentity !== this.sessionIdentityKey(session) ||
      this.activeMatcherRules !== session.config.rules ||
      this.activeMatcherMode !== session.config.mode
    ) {
      this.activateMatcher(session);
    }
    if (this.activeMatcher === null) throw new Error('active session matcher was not compiled');
    return this.activeMatcher;
  }

  private enqueuePolicyMutation<T>(mutation: () => Promise<T>): Promise<T> {
    if (this.dataClearBarrierState !== 'open') {
      return Promise.reject(
        new Error('runtime mutation rejected while all-data clear is in progress'),
      );
    }
    const requested: Promise<T> = this.policyMutationQueue.then(mutation, mutation);
    this.policyMutationQueue = requested.then(
      (): void => undefined,
      (): void => undefined,
    );
    return requested;
  }

  private assertRuntimeMutationAllowed(): void {
    if (this.dataClearBarrierState === 'quiesced') {
      throw new Error('runtime mutation rejected while all-data clear is in progress');
    }
  }

  private resetAfterAllDataClear(): void {
    const now: number = this.ports.now();
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.lists = structuredClone(DEFAULT_LISTS);
    this.bank = { balanceMs: 0 };
    this.streak = null;
    this.runtime = emptyRuntime(now);
    this.deviceId = '';
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
    this.activeMatcher = null;
    this.activeMatcherSessionIdentity = null;
    this.activeMatcherRules = null;
    this.activeMatcherMode = null;
    this.ownedRuntimeSnapshot = structuredClone(this.runtime);
  }

  private async drainRuntimeMutations(): Promise<void> {
    while (true) {
      const policy: Promise<void> = this.policyMutationQueue;
      const commits: Promise<void> = this.commitQueue;
      const blocking: Promise<void> = this.blockingMutationPersistQueue;
      const runtime: Promise<void> = this.runtimePersistQueue;
      const attempts: Promise<void>[] = [...this.attemptPersistInFlight.values()].flatMap(
        (durabilities: Set<AttemptDurability>): Promise<void>[] =>
          [...durabilities].map(
            (durability: AttemptDurability): Promise<void> => durability.promise,
          ),
      );
      await Promise.all([policy, commits, blocking, runtime, ...attempts]);
      if (
        policy === this.policyMutationQueue &&
        commits === this.commitQueue &&
        blocking === this.blockingMutationPersistQueue &&
        runtime === this.runtimePersistQueue &&
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

  private buildSnapshot(now: number): SessionSnapshot {
    const s: SessionState | null = this.runtime.session;
    const agg: DailyAgg | null = this.runtime.todayAgg;
    const attemptsToday: number =
      agg === null
        ? 0
        : Object.values(agg.attempts).reduce((a: number, b: number): number => a + b, 0) +
          agg.attemptsOther;
    return {
      at: now,
      theme: this.settings.theme,
      phase: s === null ? 'idle' : s.phase,
      config: s === null ? null : structuredClone(s.config),
      startedAt: s?.startedAt ?? null,
      phaseStartedAt: s?.phaseStartedAt ?? null,
      phaseEndsAt: s?.phaseEndsAt ?? null,
      sessionEndsAt: s?.sessionEndsAt ?? null,
      cycleIndex: s?.cycleIndex ?? 0,
      bankMs: this.bank.balanceMs,
      bankAccrualPerMs: s !== null && s.phase === 'focus' ? this.settings.pause.earnRatio : 0,
      bankCapMs: this.settings.pause.capMs,
      pauseCostMs: this.settings.pause.pauseMs,
      unlockCostMs: this.settings.pause.unlockMs,
      activeUnlocks: structuredClone(this.runtime.unlocks),
      gate:
        this.runtime.gate === null
          ? null
          : { ...structuredClone(this.runtime.gate), forceEndAvailable: false },
      attemptsToday,
      scheduleActive: this.runtime.scheduleActiveEntryId !== null,
      nextSchedule: this.nextScheduleInfo(now),
    };
  }

  private nextScheduleInfo(now: number): { entryId: string; startsAt: number } | null {
    const enabled: ScheduleEntry[] = this.settings.schedule.filter(
      (e: ScheduleEntry): boolean => e.enabled,
    );
    if (enabled.length === 0) return null;
    const found: { entry: ScheduleEntry; startsAt: Date } | null = nextStart(
      enabled,
      new Date(now),
    );
    return found === null ? null : { entryId: found.entry.id, startsAt: found.startsAt.getTime() };
  }
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

function focusedMsAt(session: SessionState, now: number): number {
  if (session.phase !== 'focus') return session.focusedMs;
  const focusedUntil: number = Math.min(now, session.phaseEndsAt, session.sessionEndsAt);
  return session.focusedMs + Math.max(0, focusedUntil - session.phaseStartedAt);
}

function sessionIdentity(session: SessionState | null): { sessionId?: string } {
  return session?.sessionId === undefined ? {} : { sessionId: session.sessionId };
}

function localMidnightAfter(date: string): number {
  const midnight: Date = new Date(`${date}T00:00:00`);
  midnight.setDate(midnight.getDate() + 1);
  return midnight.getTime();
}
