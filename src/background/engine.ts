import { accrue, spend } from '../core/budget';
import { ALL_CATEGORIES } from '../core/categories';
import {
  type CompiledMatcher,
  compileMatcher,
  evaluateUrl,
  registrableHost,
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
  CANCEL_GATE_DELAY_MS,
  cancelPhrase,
  GATE_EXPIRY_MS,
  TOP_SITES_DAILY,
} from '../shared/constants';
import { CoreError } from '../shared/errors';
import type { Ack, SoundId } from '../shared/messages';
import {
  SYNC_BANK,
  SYNC_LISTS,
  SYNC_SETTINGS,
  SYNC_STREAK,
  syncAggKey,
} from '../shared/storage-keys';
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
  SessionSnapshot,
  SessionState,
  Settings,
  SiteUnlock,
  StreakState,
  Verdict,
} from '../shared/types';
import { listsChangeAllowed, settingsChangeAllowed } from './guard';
import {
  clockRebaseArchiveKey,
  planBackwardDateRebase,
  planRollover,
  type RolloverPlan,
} from './rollover';
import type { RuntimeCommitCheckpoint, RuntimeState, RuntimeTabState } from './stores';
import { chooseNewerStreak, rebaseStreakForDate, streaksEqual } from './streak-sync';
import { assertSyncItemWithinQuota, SyncQuotaError } from './sync-quota';

export interface EnginePorts {
  now(): number;
  newId(): string;
  saveRuntime(r: RuntimeState): Promise<void>;
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

interface AttemptDurability {
  revision: number;
  durable: boolean;
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

const NO_SESSION_VERDICT: Verdict = { blocked: false, reason: 'no-session', matchedPattern: null };

/**
 * Authoritative session engine. Pure src/core modules make every domain
 * decision, this class wires them to persistence and effects through
 * EnginePorts. Every public entry point runs catchUp() first, so a
 * worker woken after missed alarms is consistent before it answers.
 */
export class Engine {
  private matcher: CompiledMatcher | null = null;
  private pendingEvents: EventRecord[] = [];
  private dirty = false;
  private needsBlocking = false;
  private commitQueue: Promise<void> = Promise.resolve();
  private blockingMutationPersistQueue: Promise<void> = Promise.resolve();
  private domainPersistQueue: Promise<void> = Promise.resolve();
  private attemptRevision = 0;
  private attemptPersistInFlight: Map<string, Set<AttemptDurability>> = new Map();
  private failedAttemptPersistence: Set<string> = new Set();
  private runtimePersistQueue: Promise<void> = Promise.resolve();
  private applyingBlocking = false;
  private bankDirty = false;
  private bankRevision = 0;
  private runtimePersistRevision = 0;
  private ownedRuntimeSnapshot: RuntimeState;

  constructor(
    private readonly ports: EnginePorts,
    private settings: Settings,
    private lists: ListsConfig,
    private bank: BankState,
    private streak: StreakState | null,
    private runtime: RuntimeState,
    private readonly deviceId: string,
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
      this.runtime.session = { ...this.runtime.session, sessionId: this.ports.newId() };
      this.dirty = true;
    }
    this.ownedRuntimeSnapshot = structuredClone(this.runtime);
  }

  reportError(error: unknown): void {
    this.ports.reportError(error);
  }

  snapshot(): SessionSnapshot {
    const now: number = this.ports.now();
    this.catchUp(now);
    const snap: SessionSnapshot = this.buildSnapshot(now);
    if (this.dirty) this.commitInBackground(now);
    return snap;
  }

  async snapshotPersisted(): Promise<SessionSnapshot> {
    const now: number = this.ports.now();
    this.catchUp(now);
    if (this.dirty) await this.commit(now);
    else await this.commitQueue;
    return this.buildSnapshot(now);
  }

  verdictFor(url: string): Verdict {
    const now: number = this.ports.now();
    this.catchUp(now);
    if (this.dirty) this.commitInBackground(now);
    const session: SessionState | null = this.runtime.session;
    if (session === null || session.phase !== 'focus') return NO_SESSION_VERDICT;
    return evaluateUrl(this.ensureMatcher(session.config.mode), url, this.runtime.unlocks, now);
  }

  async startSession(config: SessionConfig): Promise<Ack> {
    const now: number = this.ports.now();
    this.catchUp(now);
    if (this.runtime.session !== null) return this.fail(now, 'a session is already running');
    const sessionId: string = this.ports.newId();
    this.runtime.session = machineStart(config, now, sessionId);
    this.runtime.gate = null;
    this.runtime.unlocks = [];
    this.runtime.accruedFocusMs = 0;
    this.matcher = compileMatcher(this.lists, ALL_CATEGORIES, config.mode);
    this.recordEvent({
      t: 'sessionStarted',
      at: now,
      source: config.source,
      mode: config.mode,
      strictness: config.strictness,
      durationMin: config.durationMin,
      intention: config.intention,
      sessionId,
    });
    this.dirty = true;
    this.needsBlocking = true;
    await this.commit(now);
    return { ok: true };
  }

  async openGate(gate: GateKind, host: string | null): Promise<Ack> {
    const now: number = this.ports.now();
    this.catchUp(now);
    const session: SessionState | null = this.runtime.session;
    if (session === null) return this.fail(now, 'no session is running');
    if (gate === 'cancel') {
      if (session.config.strictness === 'hard') {
        return this.fail(now, 'hard sessions cannot be canceled');
      }
    } else {
      if (session.phase !== 'focus') return this.fail(now, 'pauses only apply during focus');
      if (gate === 'unlockSite' && host === null) return this.fail(now, 'no site given to unlock');
      const cost: number =
        gate === 'pause' ? this.settings.pause.pauseMs : this.settings.pause.unlockMs;
      if (this.bank.balanceMs < cost) return this.fail(now, 'not enough pause budget yet');
    }
    const needsPhrase: boolean = gate === 'cancel' || this.settings.gate.requireTypedPhrase;
    const unlockHost: string | null =
      gate === 'unlockSite' && host !== null ? (registrableHost(host) ?? host) : null;
    this.runtime.gate = {
      kind: gate,
      host: unlockHost,
      openedAt: now,
      readyAt: now + (gate === 'cancel' ? CANCEL_GATE_DELAY_MS : this.settings.gate.delayMs),
      requiredPhrase: needsPhrase ? cancelPhrase(session.config.intention) : null,
    };
    this.recordEvent({ t: 'gateOpened', at: now, gate, ...sessionIdentity(session) });
    this.dirty = true;
    await this.commit(now);
    return { ok: true };
  }

  async confirmGate(typedPhrase: string | null): Promise<Ack> {
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
    } else {
      this.recordEvent({
        t: 'sessionCanceled',
        at: now,
        focusedMs: focusedMsAt(session, now),
        ...sessionIdentity(session),
      });
      this.runtime.session = null;
      this.runtime.gate = null;
      this.runtime.unlocks = [];
      this.runtime.accruedFocusMs = 0;
      this.runtime.scheduleActiveEntryId = null;
    }
  }

  async abandonGate(): Promise<Ack> {
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
    const now: number = this.ports.now();
    const key = `${tabId}:${url}`;
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
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state === undefined || state.muteUrl !== url) return;
    state.muteUrl = null;
    state.priorMuted = null;
    this.dropEmptyTabState(tabId, state);
    await this.persistRuntime();
  }

  async transferMuteClaim(tabId: number, fromUrl: string, toUrl: string): Promise<void> {
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state === undefined) return;
    if (state.muteUrl === fromUrl) state.muteUrl = toUrl;
    if (state.muteUrl !== toUrl || state.priorMuted === null) return;
    await this.persistRuntime();
  }

  async settleMuteClaim(tabId: number, finalUrl: string | null): Promise<void> {
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
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state === undefined || state.muteUrl !== url) return;
    state.muteUrl = null;
    state.priorMuted = null;
    this.dropEmptyTabState(tabId, state);
  }

  noteReloaded(tabId: number, documentId: string): void {
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state === undefined || state.stoppedDocumentId !== documentId) return;
    state.stoppedDocumentId = null;
    this.dropEmptyTabState(tabId, state);
  }

  reconcileTabs(
    liveTabs: ReadonlyMap<number, LiveTabState>,
    protectedTabIds: ReadonlySet<number> = new Set(),
  ): void {
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
    const state: RuntimeTabState | undefined = this.runtime.tabStates[tabId];
    if (state !== undefined && state.priorMuted !== null) state.muteUrl = url;
  }

  flushRuntime(): Promise<void> {
    return this.persistRuntime();
  }

  /** Purges a closed tab from mute, stopped, and debounce bookkeeping. */
  async dropTab(tabId: number): Promise<void> {
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
    const now: number = this.ports.now();
    this.catchUp(now);
    this.pruneDebounce(now);
    await this.maybePrune(now);
    await this.commit(now);
  }

  async updateSettings(s: Settings): Promise<Ack> {
    const now: number = this.ports.now();
    this.catchUp(now);
    const reason: string | null = settingsChangeAllowed(this.runtime.session, this.settings, s);
    if (reason !== null) return this.fail(now, reason);
    try {
      assertSyncItemWithinQuota(SYNC_SETTINGS, s);
    } catch (error: unknown) {
      if (!(error instanceof SyncQuotaError)) throw error;
      return this.fail(
        now,
        'Settings exceed the 8 KB Chrome Sync limit. Remove schedule entries or shorten intentions, then try again.',
      );
    }
    this.setSettingsAndClampBank(s);
    this.ports.queueSync(SYNC_SETTINGS, s);
    this.dirty = true;
    await this.commit(now);
    return { ok: true };
  }

  async updateLists(l: ListsConfig): Promise<Ack> {
    const now: number = this.ports.now();
    this.catchUp(now);
    const reason: string | null = listsChangeAllowed(
      this.runtime.session,
      this.runtime.session?.config.mode ?? null,
      this.lists,
      l,
    );
    if (reason !== null) return this.fail(now, reason);
    try {
      assertSyncItemWithinQuota(SYNC_LISTS, l);
    } catch (error: unknown) {
      if (!(error instanceof SyncQuotaError)) throw error;
      return this.fail(
        now,
        'Lists exceed the 8 KB Chrome Sync limit. Remove custom or whitelist rules, then try again.',
      );
    }
    this.lists = l;
    this.matcher = null;
    this.ports.queueSync(SYNC_LISTS, l);
    this.dirty = true;
    this.needsBlocking = this.runtime.session !== null;
    await this.commit(now);
    return { ok: true };
  }

  async applySyncedSettings(settings: Settings): Promise<Ack> {
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

  async applySyncedLists(lists: ListsConfig): Promise<Ack> {
    const now: number = this.ports.now();
    this.catchUp(now);
    const reason: string | null = listsChangeAllowed(
      this.runtime.session,
      this.runtime.session?.config.mode ?? null,
      this.lists,
      lists,
    );
    if (reason !== null) return this.fail(now, reason);
    this.lists = lists;
    this.matcher = null;
    this.dirty = true;
    this.needsBlocking = this.runtime.session !== null;
    await this.commit(now);
    return { ok: true };
  }

  async applySyncedBank(bank: BankState): Promise<Ack> {
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
    const sanitized: StreakState = rebaseStreakForDate(streak, localDateStr(this.ports.now()));
    const chosen: StreakState | null = chooseNewerStreak(sanitized, this.streak);
    this.streak = chosen;
    if (chosen === null) return;
    if (streaksEqual(chosen, streak)) {
      this.ports.supersedeSync(SYNC_STREAK, chosen);
    } else {
      this.ports.queueSync(SYNC_STREAK, chosen);
    }
    await this.ports.persistSyncJournal();
  }

  getSettings(): Settings {
    return this.settings;
  }

  private setSettingsAndClampBank(settings: Settings): void {
    const balanceMs: number = Math.min(this.bank.balanceMs, settings.pause.capMs);
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
    if (this.dirty) this.commitInBackground(now);
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
    this.scheduleCheck(now);
  }

  private rebaseDateBackward(today: string, now: number): void {
    const futureDate: string = this.runtime.date;
    const plan = planBackwardDateRebase(today, this.runtime.todayAgg ?? emptyDaily(futureDate));
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
    this.ports.queueSync(SYNC_STREAK, this.streak);
  }

  private settleSession(now: number): void {
    const session: SessionState | null = this.runtime.session;
    if (session === null) return;
    const { next, events } = advance(session, now);
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
      this.ports.notify('Focus session complete', 'The lock is off. Time for a real break.');
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
      this.startFromScheduleEntry(active, now);
      return;
    }
    // One session at a time. A hard window upgrades a running friction
    // session, never the other way around (spec section 5).
    if (active.strictness === 'hard' && session.config.strictness === 'friction') {
      this.runtime.session = {
        ...session,
        config: { ...session.config, strictness: 'hard' },
      };
      this.dirty = true;
    }
  }

  private startFromScheduleEntry(entry: ScheduleEntry, now: number): void {
    const endsAt: number = windowEnd(entry, new Date(now)).getTime();
    const config: SessionConfig = {
      mode: entry.mode,
      strictness: entry.strictness,
      durationMin: Math.max(0, (endsAt - now) / 60_000),
      cycling: entry.cycling,
      intention: entry.intention,
      source: 'schedule',
      scheduleEntryId: entry.id,
    };
    const sessionId: string = this.ports.newId();
    this.runtime.session = machineStart(config, now, sessionId);
    this.runtime.accruedFocusMs = 0;
    this.runtime.scheduleActiveEntryId = entry.id;
    this.matcher = compileMatcher(this.lists, ALL_CATEGORIES, config.mode);
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
    );
    this.ports.queueSync(syncAggKey(this.deviceId, plan.finished.date), plan.finished);
    this.streak = plan.streak;
    this.ports.queueSync(SYNC_STREAK, plan.streak);
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

  private persistDomainState(): Promise<void> {
    const queued: Promise<void> = this.domainPersistQueue.then(
      (): Promise<void> => this.performDomainPersist(),
    );
    this.domainPersistQueue = queued.catch((): void => {
      // Keep later domain persistence usable. The caller still receives the rejection.
    });
    return queued;
  }

  private async performDomainPersist(): Promise<void> {
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
    if (syncBank) this.ports.queueSync(SYNC_BANK, bank);
    await this.flushEvents(aggregate, date, events);
    await this.ports.persistSyncJournal();
    for (const event of events) {
      const index: number = this.pendingEvents.indexOf(event);
      if (index >= 0) this.pendingEvents.splice(index, 1);
    }
    if (this.bankRevision === bankRevision) this.bankDirty = false;
    this.runtime.commitCheckpoint = null;
    if (this.runtimePersistRevision === runtimePersistRevision) {
      checkpointRuntime.commitCheckpoint = null;
      this.ownedRuntimeSnapshot = structuredClone(checkpointRuntime);
      await this.persistRuntime(checkpointRuntime);
    }
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

  private ensureMatcher(mode: SessionConfig['mode']): CompiledMatcher {
    if (this.matcher === null || this.matcher.mode !== mode) {
      this.matcher = compileMatcher(this.lists, ALL_CATEGORIES, mode);
    }
    return this.matcher;
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
      phase: s === null ? 'idle' : s.phase,
      config: s?.config ?? null,
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
      activeUnlocks: this.runtime.unlocks,
      gate: this.runtime.gate,
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
