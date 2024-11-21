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
import { planBackwardDateRebase, planRollover, type RolloverPlan } from './rollover';
import type { RuntimeState } from './stores';
import { chooseNewerStreak } from './streak-sync';

export interface EnginePorts {
  now(): number;
  saveRuntime(r: RuntimeState): Promise<void>;
  queueSync(key: string, value: unknown): void;
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

export interface EngineStatsOverlay {
  deviceId: string;
  todayAgg: DailyAgg;
  streak: StreakState | null;
  pendingEvents: EventRecord[];
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
  private applyingBlocking = false;

  constructor(
    private readonly ports: EnginePorts,
    private settings: Settings,
    private lists: ListsConfig,
    private bank: BankState,
    private streak: StreakState | null,
    private runtime: RuntimeState,
    private readonly deviceId: string,
  ) {}

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
    this.runtime.session = machineStart(config, now);
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
    this.recordEvent({ t: 'gateOpened', at: now, gate });
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
      this.runtime.session = beginPause(session, now, this.settings.pause.pauseMs);
      this.recordEvent({ t: 'phase', at: now, from: session.phase, to: 'paused' });
      this.recordEvent({ t: 'pauseTaken', at: now, ms: this.settings.pause.pauseMs });
    } else if (gate.kind === 'unlockSite') {
      const host: string = gate.host ?? '';
      this.bank = spend(this.bank, this.settings.pause.unlockMs);
      this.runtime.unlocks = [
        ...this.runtime.unlocks,
        { host, until: now + this.settings.pause.unlockMs },
      ];
      this.recordEvent({
        t: 'unlockTaken',
        at: now,
        host,
        ms: this.settings.pause.unlockMs,
      });
    } else {
      this.recordEvent({
        t: 'sessionCanceled',
        at: now,
        focusedMs: focusedMsAt(session, now),
      });
      this.runtime.session = null;
      this.runtime.gate = null;
      this.runtime.unlocks = [];
      this.runtime.accruedFocusMs = 0;
      this.runtime.scheduleActiveEntryId = null;
    }
    this.ports.queueSync(SYNC_BANK, this.bank);
  }

  async abandonGate(): Promise<Ack> {
    const now: number = this.ports.now();
    this.catchUp(now);
    if (this.runtime.gate !== null) {
      this.recordEvent({ t: 'gateResisted', at: now, gate: this.runtime.gate.kind });
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
    this.recordEvent({ t: 'phase', at: now, from: 'paused', to: restored.phase });
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
    this.recordEvent({ t: 'phase', at: now, from: 'break', to: 'focus' });
    this.dirty = true;
    this.needsBlocking = true;
    await this.commit(now);
    return { ok: true };
  }

  async recordAttempt(url: string, tabId: number, kind: 'navigation' | 'existing'): Promise<void> {
    const now: number = this.ports.now();
    const key = `${tabId}:${url}`;
    const last: number | undefined = this.runtime.attemptDebounce[key];
    if (last !== undefined && now - last < ATTEMPT_DEBOUNCE_MS) return;
    this.runtime.attemptDebounce[key] = now;
    this.recordEvent({ t: 'attempt', at: now, url, host: hostOf(url), tabId, kind });
    this.dirty = true;
    if (this.applyingBlocking) return;
    await this.commit(now);
  }

  async markStopped(tabId: number): Promise<void> {
    if (this.runtime.stoppedTabIds.includes(tabId)) return;
    this.runtime.stoppedTabIds = [...this.runtime.stoppedTabIds, tabId];
    await this.persistRuntime();
  }

  /** Mute and stopped-tab facts for one tab, for tabs.ts action planning. */
  tabFacts(tabId: number): { wasMutedByUs: boolean; priorMuted: boolean; wasStopped: boolean } {
    const prior: boolean | undefined = this.runtime.mutedTabs[tabId];
    return {
      wasMutedByUs: prior !== undefined,
      priorMuted: prior ?? false,
      wasStopped: this.runtime.stoppedTabIds.includes(tabId),
    };
  }

  /** In-memory bookkeeping mutators for tabs.ts, persisted by flushRuntime. */
  noteMuted(tabId: number, priorMuted: boolean): void {
    this.runtime.mutedTabs[tabId] = priorMuted;
  }

  noteMuteRestored(tabId: number): void {
    delete this.runtime.mutedTabs[tabId];
  }

  noteReloaded(tabId: number): void {
    this.runtime.stoppedTabIds = this.runtime.stoppedTabIds.filter(
      (id: number): boolean => id !== tabId,
    );
  }

  reconcileTabs(liveTabIds: ReadonlySet<number>): void {
    for (const tabId of Object.keys(this.runtime.mutedTabs).map(Number)) {
      if (!liveTabIds.has(tabId)) delete this.runtime.mutedTabs[tabId];
    }
    this.runtime.stoppedTabIds = this.runtime.stoppedTabIds.filter((tabId: number): boolean =>
      liveTabIds.has(tabId),
    );
  }

  flushRuntime(): Promise<void> {
    return this.persistRuntime();
  }

  /** Purges a closed tab from mute, stopped, and debounce bookkeeping. */
  async dropTab(tabId: number): Promise<void> {
    delete this.runtime.mutedTabs[tabId];
    this.runtime.stoppedTabIds = this.runtime.stoppedTabIds.filter(
      (id: number): boolean => id !== tabId,
    );
    for (const key of Object.keys(this.runtime.attemptDebounce)) {
      if (key.startsWith(`${tabId}:`)) delete this.runtime.attemptDebounce[key];
    }
    await this.persistRuntime();
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
    this.settings = s;
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
    this.settings = settings;
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
    this.dirty = true;
    await this.commit(now);
    return { ok: true };
  }

  async applySyncedStreak(streak: StreakState): Promise<void> {
    this.streak = chooseNewerStreak(streak, this.streak);
  }

  getSettings(): Settings {
    return this.settings;
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
    if (this.runtime.date > today) this.rebaseDateBackward(today);
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

  private rebaseDateBackward(today: string): void {
    const futureDate: string = this.runtime.date;
    const plan = planBackwardDateRebase(today, this.runtime.todayAgg ?? emptyDaily(futureDate));
    this.ports.queueSync(syncAggKey(this.deviceId, futureDate), plan.archive);
    this.runtime.date = today;
    this.runtime.todayAgg = plan.newAgg;
    this.runtime.attemptDebounce = {};
    this.runtime.lastPruneDate = null;
    if (this.streak !== null && this.streak.activeMonth !== today.slice(0, 7)) {
      this.streak = { ...this.streak, activeMonth: today.slice(0, 7), activeDays: [] };
      this.ports.queueSync(SYNC_STREAK, this.streak);
    }
    this.dirty = true;
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
      this.bank = accrue(this.bank, delta, this.settings.pause);
      this.runtime.accruedFocusMs = focusedNow;
      const aggregate: DailyAgg = this.runtime.todayAgg ?? emptyDaily(this.runtime.date);
      this.runtime.todayAgg = { ...aggregate, focusMs: aggregate.focusMs + delta };
      this.ports.queueSync(SYNC_BANK, this.bank);
      this.dirty = true;
    }
    if (next !== session) {
      this.runtime.session = next;
      this.dirty = true;
    }
    for (const ev of events) this.routeMachineEvent(ev);
  }

  private routeMachineEvent(ev: MachineEvent): void {
    if (ev.type === 'phaseChanged') {
      this.recordEvent({ t: 'phase', at: ev.at, from: ev.from, to: ev.to });
      if (ev.from === 'focus' && ev.to === 'break') this.ports.playSound('breakStart');
      if (ev.from === 'break' && ev.to === 'focus') this.ports.playSound('breakEnd');
    } else {
      this.recordEvent({ t: 'sessionCompleted', at: ev.at, focusedMs: ev.focusedMs });
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
    this.recordEvent({ t: 'gateResisted', at: now, gate: gate.kind });
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
    this.runtime.session = machineStart(config, now);
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

  private async flushEvents(): Promise<void> {
    const aggregate: DailyAgg | null = this.runtime.todayAgg;
    if (aggregate !== null) {
      this.ports.queueSync(
        syncAggKey(this.deviceId, this.runtime.date),
        capAttempts(aggregate, TOP_SITES_DAILY),
      );
    }
    if (this.pendingEvents.length === 0) return;
    const batch: EventRecord[] = [...this.pendingEvents];
    await this.ports.appendEvents(batch);
    this.pendingEvents.splice(0, batch.length);
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

  private async performCommit(now: number): Promise<void> {
    await this.flushEvents();
    this.dirty = false;
    const block: boolean = this.needsBlocking;
    this.needsBlocking = false;
    const snap: SessionSnapshot = this.buildSnapshot(now);
    await this.persistRuntime();
    this.ports.broadcast(snap);
    this.ports.updateIcon(snap);
    this.ports.scheduleWake(this.runtime.session?.phaseEndsAt ?? null);
    if (block) {
      this.applyingBlocking = true;
      try {
        await this.ports.applyBlocking();
      } finally {
        this.applyingBlocking = false;
      }
    }
    if (this.dirty) {
      await this.flushEvents();
      this.dirty = false;
      const updated: SessionSnapshot = this.buildSnapshot(this.ports.now());
      await this.persistRuntime();
      this.ports.broadcast(updated);
      this.ports.updateIcon(updated);
    }
  }

  private async persistRuntime(): Promise<void> {
    try {
      await this.ports.saveRuntime(this.runtime);
    } catch (error: unknown) {
      this.dirty = true;
      throw error;
    }
  }

  private ensureMatcher(mode: SessionConfig['mode']): CompiledMatcher {
    if (this.matcher === null || this.matcher.mode !== mode) {
      this.matcher = compileMatcher(this.lists, ALL_CATEGORIES, mode);
    }
    return this.matcher;
  }

  private pruneDebounce(now: number): void {
    for (const [key, at] of Object.entries(this.runtime.attemptDebounce)) {
      if (now - at >= ATTEMPT_DEBOUNCE_MS) delete this.runtime.attemptDebounce[key];
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

function localMidnightAfter(date: string): number {
  const midnight: Date = new Date(`${date}T00:00:00`);
  midnight.setDate(midnight.getDate() + 1);
  return midnight.getTime();
}
