/**
 * The public command surface. Every popup command, alarm, navigation, and tick enters here, is
 * serialized against every other one, and answers with an exact result code from the spec's table.
 * Nothing in this file decides a stage: each command validates what it is allowed to do, delegates
 * to the runner that owns the work, and publishes the projection the runner left durable.
 *
 * Three properties the whole file serves. Every command answers a code and never throws across the
 * message boundary, except the two the spec says must fail loudly. Nothing is published before
 * `recover()` has resolved this profile's one runtime authority, so an unrecovered migrated
 * projection is never observed by a page. And the two runner entry points are serialized here,
 * which is the precondition the transition runner documents.
 */

import {
  advanceSessionV2,
  assertCanStartNextFocusEarlyV2,
  beginPauseV2,
  type SessionAdvanceResultV2,
} from '../core/session-v2';
import { cancelPhrase, pausePhrase } from '../shared/constants';
import type { DocumentContentCommand } from '../shared/enforcement-v2';
import { CoreError } from '../shared/errors';
import type {
  CommandResponseV2,
  RetryCleanupResultCodeV2,
  SessionCommandResultCodeV2,
  SoundId,
  StartSessionResponseV2,
} from '../shared/messages';
import { localDateStr, localMidnightAfter } from '../shared/time';
import type {
  BankState,
  GateKind,
  GateState,
  PauseEconomy,
  SessionConfigV2,
  SessionEventRecordV2,
  SessionSnapshotV2,
  SessionStateV2,
  SettingsV2,
  SiteUnlock,
  Verdict,
} from '../shared/types';
import { ensurePhaseAlarmV2, parseAlarmNameV2 } from './alarms-v2';
import { documentCommandKeyV2 } from './cleanup-progress-v2';
import { manualEndReasonV2 } from './closure-projection-v2';
import {
  closeSessionV2,
  prepareClosureV2,
  retryClosureCleanupV2,
  runClosureCleanupAttemptV2,
} from './closure-runner-v2';
import { sendDocumentEnforcementCommand, sendEpochResetCommand } from './content-transport-v2';
import type {
  DocumentEnforcementAck,
  EnforcementCheckpoint,
  FrozenDocumentCommand,
} from './enforcement-persistence-v2';
import { classifyEnforcementTargetV2, type TargetClassificationV2 } from './enforcement-targets-v2';
import { buildSessionSnapshotV2 } from './lifecycle-projection-v2';
import {
  buildActiveOverlayView,
  buildFrozenDocumentCommandV2,
  buildFrozenEpochResetCommandV2,
} from './overlay-view-v2';
import { recoverRuntimeV2 } from './recovery-v2';
import { projectRuntimeDomainV2 } from './runtime-checkpoint-v2';
import type { RuntimePortsV2 } from './runtime-ports-v2';
import type { RuntimeStateV2, SessionStartCandidate } from './runtime-v2-types';
import { parseRuntimeStateV2 } from './runtime-v2-validation';
import {
  nextScheduleInfoV2,
  pruneHandledOccurrencesOnTickV2,
  runScheduleCheckV2,
  type ScheduleRunnerPortsV2,
} from './schedule-runner-v2';
import {
  type CleanupEffectPortsV2,
  enterTransitionCleanupV2,
  handleCleanupNavigationV2,
  retryTransitionCleanupV2,
  runTransitionCleanupAttemptV2,
} from './transition-cleanup-v2';
import {
  driveTransitionV2,
  handleTransitionNavigationV2,
  type PreparedTransitionV2,
  prepareResumeTransitionV2,
  prepareStartTransitionV2,
  refreezeTransitionViewV2,
  type TransitionDriveResultV2,
  transitionMatcherV2,
} from './transition-runner-v2';

export interface SessionControllerEffectsV2 extends CleanupEffectPortsV2 {
  broadcast(snapshot: SessionSnapshotV2): void;
  updateBadge(snapshot: SessionSnapshotV2): void;
  playSound(sound: SoundId): void;
  notify(title: string, body: string): void;
  /** The existing serialized tab engine clear, for a phase that blocks nothing. */
  clearBlockingForNonBlockingPhase(): Promise<void>;
  /** The existing `Engine.recordAttempt`, which owns `ATTEMPT_DEBOUNCE_MS` and the attempt event. */
  recordAttempt(url: string, tabId: number, kind: 'navigation' | 'existing'): Promise<void>;
}

// Precondition the cutover must satisfy before any v2 producer runs: the retained Engine appends its
// events through appendEventsV2, never through the v1 stores.appendEvents path, because the v1
// writer re-parses the whole LOCAL_EVENTS log through parseEventRecord, which drops v2 records and
// rebuilds legacy records. The cutover deletes stores.appendEvents, performAppendEvents, and
// readEvents.

type CommandResultV2 = CommandResponseV2<SessionCommandResultCodeV2>;
type RetryResultV2 = CommandResponseV2<RetryCleanupResultCodeV2>;

const OK: { ok: true; code: 'ok' } = { ok: true, code: 'ok' };

export class SessionControllerV2 {
  private queue: Promise<unknown> = Promise.resolve();
  private recovered: boolean = false;
  /** Set when a prepared closure write failed, so projection reports the closure it owes. */
  private closurePending: boolean = false;
  private pendingReason: 'website-access-lost' | 'content-registration-failed' | null = null;

  constructor(
    private readonly ports: RuntimePortsV2,
    private readonly schedule: ScheduleRunnerPortsV2,
    private readonly effects: SessionControllerEffectsV2,
  ) {}

  /** The public read model at one instant. Pure: it writes nothing and publishes nothing. */
  snapshot(at: number): SessionSnapshotV2 {
    const runtime: RuntimeStateV2 = this.ports.runtime();
    const settings: SettingsV2 = this.schedule.settings();
    const base: SessionSnapshotV2 = buildSessionSnapshotV2({
      runtime,
      settings,
      bank: this.ports.bank(),
      at,
      nextSchedule: nextScheduleInfoV2(settings.schedule, runtime.handledScheduleOccurrences, at),
    });
    // A closure this worker owes but could not write yet is already the truth for the user, so it
    // is reported as the cleanup it will become rather than as the session that is still durable.
    const owed: string | null = this.closurePending ? (runtime.session?.sessionId ?? null) : null;
    return owed === null ? base : owedClosureSnapshot(base, owed);
  }

  hasActiveSession(): boolean {
    return this.ports.runtime().session !== null;
  }

  /** Resolves the durable authority once, then allows publication. */
  async recover(): Promise<void> {
    await this.enqueue(async (): Promise<void> => {
      await recoverRuntimeV2(this.ports, this.effects);
      this.recovered = true;
      this.publish();
    });
  }

  /**
   * Periodic maintenance. It settles the durable session through now, expires the gate and
   * unlocks, prunes handled records, retries a due cleanup, runs the schedule check, and publishes.
   * A `tick` is never proof that a retry alarm exists, so the due journal is read from storage.
   */
  async tick(): Promise<void> {
    await this.enqueue(async (): Promise<void> => {
      await this.retryOwedClosure();
      await this.rollLocalDate();
      await this.settleThroughNow();
      await this.runDueCleanup();
      await this.runScheduleCheck();
      this.publish();
    });
  }

  /** Routes one alarm to the owner named by its name. An unknown name is ignored. */
  async handleAlarm(name: string): Promise<void> {
    switch (parseAlarmNameV2(name)) {
      case 'tick':
        await this.tick();
        return;
      case 'phase':
        await this.enqueue(async (): Promise<void> => {
          await this.settleThroughNow();
          this.publish();
        });
        return;
      case 'transition-cleanup':
        await this.enqueue((): Promise<void> => this.runTransitionCleanupIfOwned());
        return;
      case 'closure-cleanup':
        await this.enqueue((): Promise<void> => this.runClosureCleanupIfOwned());
        return;
      default:
        return;
    }
  }

  /** Prepares and drives a manual start, answering the exact start code. */
  async startSession(config: SessionConfigV2): Promise<StartSessionResponseV2> {
    return this.enqueue(async (): Promise<StartSessionResponseV2> => {
      const journal: StartSessionResponseV2 | null = this.journalRejection();
      if (journal !== null) return journal;
      let prepared: PreparedTransitionV2;
      try {
        prepared = await prepareStartTransitionV2(this.ports, candidateFor(config), 'manual');
      } catch {
        return { ok: false, code: 'invalid-request', error: 'invalid-request' };
      }
      const driven: TransitionDriveResultV2 = await driveTransitionV2(this.ports, prepared.matcher);
      if (driven.kind === 'published') {
        this.publish();
        return OK;
      }
      return this.startFailure();
    });
  }

  /** A Flexible End, on a published session or a committed transition. */
  async requestSessionEnd(): Promise<CommandResultV2> {
    return this.command(async (): Promise<CommandResultV2> => {
      const runtime: RuntimeStateV2 = this.ports.runtime();
      const session: SessionStateV2 | null = runtime.session;
      if (runtime.pendingClosure !== null) return failure('no-active-session');
      if (session === null) return failure('no-active-session');
      if (this.inTransitionCleanup()) return failure('transition-cleanup-pending');
      if (session.config.strictness !== 'flexible') return failure('end-not-allowed');
      await this.closeActiveSession(session, this.ports.now());
      return OK;
    });
  }

  /** Friction only: opens and persists the cancel gate, then refreshes every live view. */
  async openEndGate(): Promise<CommandResultV2> {
    return this.command(async (): Promise<CommandResultV2> => {
      const session: SessionStateV2 | null = this.ports.runtime().session;
      const guard: CommandResultV2 | null = this.gateGuard(session);
      if (guard !== null) return guard;
      if (session === null || session.config.strictness !== 'friction') {
        return failure('end-not-allowed');
      }
      const gate: GateState | null = this.ports.runtime().gate;
      if (gate !== null) return gate.kind === 'cancel' ? OK : failure('end-not-allowed');
      await this.commitLiveGate(
        {
          kind: 'cancel',
          host: null,
          openedAt: this.ports.now(),
          readyAt: this.ports.now() + this.ports.gateSettings().delayMs,
          requiredPhrase: cancelPhrase(session.config.intention),
        },
        this.gateEvent('gateOpened', 'cancel', session),
      );
      return OK;
    });
  }

  /** Opens a pause or unlock gate, which the confirmation then spends the bank on. */
  async openGate(gate: 'pause' | 'unlockSite', host: string | null): Promise<CommandResultV2> {
    return this.command(async (): Promise<CommandResultV2> => {
      const session: SessionStateV2 | null = this.ports.runtime().session;
      const guard: CommandResultV2 | null = this.gateGuard(session);
      if (guard !== null) return guard;
      if (session === null || session.phase !== 'focus') return failure('no-active-session');
      // A pause changes the phase and an unlock changes the economy, both of which a running
      // transition owns until it publishes, so neither gate opens while one is durable.
      if (this.ports.runtime().pendingEnforcementTransition !== null) {
        return failure('end-not-allowed');
      }
      if (this.ports.runtime().gate !== null) return failure('end-not-allowed');
      if (gate === 'unlockSite' && (host === null || host.trim() === '')) {
        return failure('end-not-allowed');
      }
      await this.commitLiveGate(
        {
          kind: gate,
          host: gate === 'unlockSite' ? host : null,
          openedAt: this.ports.now(),
          readyAt: this.ports.now() + this.ports.gateSettings().delayMs,
          requiredPhrase:
            gate === 'pause' ? pausePhrase() : `I am allowing this site: ${host ?? ''}`,
        },
        this.gateEvent('gateOpened', gate, session),
      );
      return OK;
    });
  }

  /** Clears the gate, records the resistance, and refreshes the live views. */
  async abandonGate(): Promise<CommandResultV2> {
    return this.command(async (): Promise<CommandResultV2> => {
      const guard: CommandResultV2 | null = this.gateGuard(this.ports.runtime().session);
      if (guard !== null) return guard;
      const open: GateState | null = this.ports.runtime().gate;
      if (open === null) return failure('no-active-gate');
      await this.commitLiveGate(
        null,
        this.gateEvent('gateResisted', open.kind, this.ports.runtime().session),
      );
      return OK;
    });
  }

  /** Spends a ready gate. The cancel gate closes the session, the others buy their relief. */
  async confirmGate(typedPhrase: string | null): Promise<CommandResultV2> {
    return this.command(async (): Promise<CommandResultV2> => {
      const runtime: RuntimeStateV2 = this.ports.runtime();
      const gate: GateState | null = runtime.gate;
      const session: SessionStateV2 | null = runtime.session;
      if (this.inTransitionCleanup()) return failure('transition-cleanup-pending');
      if (runtime.pendingClosure !== null) return failure('closure-cleanup-pending');
      if (gate === null || session === null) return failure('no-active-gate');
      if (this.ports.now() < gate.readyAt) return failure('gate-not-ready');
      if (gate.requiredPhrase !== null && typedPhrase !== gate.requiredPhrase) {
        return failure('confirmation-mismatch');
      }
      if (gate.kind === 'cancel') {
        await this.closeActiveSession(session, this.ports.now());
        return OK;
      }
      return this.spendGate(gate, session);
    });
  }

  /** A manual resume of a durable pause. */
  async resumeFromPause(): Promise<CommandResultV2> {
    return this.command((): Promise<CommandResultV2> => this.driveResume('manual', 'paused'));
  }

  /** An early end to a break, which the core validates before the transition is prepared. */
  async startNextFocusEarly(): Promise<CommandResultV2> {
    return this.command(async (): Promise<CommandResultV2> => {
      const session: SessionStateV2 | null = this.ports.runtime().session;
      // A live journal answers before the core rule does, so the popup reports the cleanup that is
      // actually blocking the command rather than the break rule underneath it.
      const guard: CommandResultV2 | null = this.gateGuard(session);
      if (guard !== null) return guard;
      if (session === null) return failure('no-active-session');
      try {
        assertCanStartNextFocusEarlyV2(session, this.ports.now());
      } catch {
        return failure('end-not-allowed');
      }
      return this.driveResume('break-expired', 'break');
    });
  }

  async retryTransitionCleanup(): Promise<RetryResultV2> {
    return this.enqueue(async (): Promise<RetryResultV2> => {
      const { code }: { code: RetryCleanupResultCodeV2 } = await retryTransitionCleanupV2(
        this.ports,
      );
      if (code !== 'ok') return { ok: false, code, error: code };
      await this.runTransitionCleanupIfOwned();
      return OK;
    });
  }

  async retryClosureCleanup(): Promise<RetryResultV2> {
    return this.enqueue(async (): Promise<RetryResultV2> => {
      const { code }: { code: RetryCleanupResultCodeV2 } = await retryClosureCleanupV2(this.ports);
      if (code !== 'ok') return { ok: false, code, error: code };
      await this.runClosureCleanupIfOwned();
      return OK;
    });
  }

  /**
   * Enforcement was lost under a live session, so it closes with that reason. A failed prepared
   * write leaves the session durable and raises the pending flag, which projection then reports.
   */
  async endForEnforcementLoss(
    reason: 'website-access-lost' | 'content-registration-failed',
  ): Promise<void> {
    await this.enqueue(async (): Promise<void> => {
      const session: SessionStateV2 | null = this.ports.runtime().session;
      if (session === null) return;
      try {
        await prepareClosureV2(this.ports, { endedAt: this.ports.now(), reason });
        this.closurePending = false;
        await this.finishOwedClosure();
      } catch (error: unknown) {
        // The prepared write is the one that must be durable. Until it is, the session stays
        // durable, the projection reports the closure, and every tick and command tries again.
        this.closurePending = true;
        this.pendingReason = reason;
        this.ports.reportError(error);
        await this.clearReachableDocuments();
      }
      this.publish();
    });
  }

  /** One navigation, routed by whatever durable authority currently owns the target. */
  async handleNavigation(
    target: { tabId: number; documentId: string; url: string },
    attemptKind: 'navigation' | 'existing' | null,
  ): Promise<void> {
    await this.enqueue(async (): Promise<void> => {
      const enforceable: TargetClassificationV2 = classifyEnforcementTargetV2(
        target.tabId,
        target.url,
        target.documentId,
      );
      if (enforceable.kind !== 'enforceable') return;
      const runtime: RuntimeStateV2 = this.ports.runtime();
      if (runtime.pendingEnforcementTransition !== null) {
        await handleTransitionNavigationV2(this.ports, transitionMatcherV2(this.ports), target);
      } else if (runtime.pendingClosure !== null) {
        await handleCleanupNavigationV2(this.ports, target);
      } else {
        await this.sendCurrentCommands(target);
      }
      await this.recordAttemptIfBlocked(target, attemptKind);
    });
  }

  /**
   * The commands one document must apply, newest persisted values only. The reset comes first when
   * the document has not acknowledged the current epoch, so it can accept what follows.
   */
  async documentCommandsFor(
    target: { tabId: number; documentId: string; url: string },
    attemptKind: 'navigation' | 'existing' | null,
  ): Promise<DocumentContentCommand[]> {
    return this.enqueue(async (): Promise<DocumentContentCommand[]> => {
      const enforceable: TargetClassificationV2 = classifyEnforcementTargetV2(
        target.tabId,
        target.url,
        target.documentId,
      );
      if (enforceable.kind !== 'enforceable') return [];
      const command: FrozenDocumentCommand = await this.currentCommandFor(target);
      const commands: DocumentContentCommand[] = [];
      if (!this.hasCurrentEpochAck(target.tabId, target.documentId)) {
        commands.push(wireOf(this.resetCommandFor(target)));
      }
      commands.push(wireOf(command));
      await this.recordAttemptIfBlocked(target, attemptKind);
      return commands;
    });
  }

  /**
   * Re-freezes every current document under a new operation and a higher runtime revision, then
   * sends them. It never touches the base-policy checkpoint, so a live change is invisible to
   * verification identity.
   */
  async refreshLiveViews(): Promise<void> {
    await this.enqueue(async (): Promise<void> => {
      await this.commitLiveViews(this.ports.runtime());
    });
  }

  /**
   * Records one exact applied acknowledgement. Only the enforcement checkpoint carries per-target
   * records (spec 734: the applied response, wrapped with the worker-owned tab ID, is what enters
   * it), so a matching ack updates that target's record in place through a checkpoint-preserving
   * write. An ack for another epoch, another operation, another revision, or a document the
   * checkpoint does not name is dropped: the runners own operation-time acknowledgement, and this
   * path never invents a record the checkpoint did not already have.
   */
  async recordDocumentAck(ack: DocumentEnforcementAck): Promise<void> {
    await this.enqueue(async (): Promise<void> => {
      const runtime: RuntimeStateV2 = this.ports.runtime();
      const checkpoint: EnforcementCheckpoint | null = runtime.enforcementCheckpoint;
      const key: string = documentCommandKeyV2(ack.tabId, ack.documentId);
      const command: FrozenDocumentCommand | undefined = runtime.documentCommands[key];
      if (
        checkpoint === null ||
        command === undefined ||
        ack.enforcementEpoch !== runtime.enforcementEpoch ||
        command.operationId !== ack.operationId ||
        command.runtimeRevision !== ack.runtimeRevision ||
        checkpoint.operationId !== ack.operationId
      ) {
        return;
      }
      // A target the checkpoint never verified gains no record here: the runners own which
      // documents one operation acknowledged, and this path only refreshes what they wrote.
      const named: boolean = checkpoint.documents.some(
        (stored: DocumentEnforcementAck): boolean =>
          stored.tabId === ack.tabId && stored.documentId === ack.documentId,
      );
      if (!named) return;
      const documents: DocumentEnforcementAck[] = checkpoint.documents.map(
        (stored: DocumentEnforcementAck): DocumentEnforcementAck =>
          stored.tabId === ack.tabId && stored.documentId === ack.documentId
            ? structuredClone(ack)
            : structuredClone(stored),
      );
      await this.write({
        ...structuredClone(runtime),
        enforcementCheckpoint: { ...structuredClone(checkpoint), documents },
      });
    });
  }

  /** One queue for every entry point, which is what serializes the runners against each other. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next: Promise<T> = this.queue.then(work, work);
    this.queue = next.then(
      (): void => undefined,
      (): void => undefined,
    );
    return next;
  }

  /** Wraps one command so a runner error becomes a code rather than a rejected message. */
  private command(work: () => Promise<CommandResultV2>): Promise<CommandResultV2> {
    return this.enqueue(async (): Promise<CommandResultV2> => {
      try {
        await this.retryOwedClosure();
        return await work();
      } catch (error: unknown) {
        // Only a genuine missing session becomes a code. Everything else propagates, because the
        // brief requires a failed durable closure write to keep the session active and throw, so
        // the router rejects the message and the popup can offer the retry.
        if (error instanceof CoreError && this.ports.runtime().session === null) {
          this.ports.reportError(error);
          return failure('no-active-session');
        }
        throw error;
      }
    });
  }

  private publish(): void {
    if (!this.recovered) return;
    const snapshot: SessionSnapshotV2 = this.snapshot(this.ports.now());
    this.effects.broadcast(snapshot);
    this.effects.updateBadge(snapshot);
  }

  /** The start rejection a journal forces, before anything is reserved. */
  private journalRejection(): StartSessionResponseV2 | null {
    const runtime: RuntimeStateV2 = this.ports.runtime();
    if (runtime.pendingEnforcementTransition !== null) {
      return {
        ok: false,
        code: 'transition-cleanup-pending',
        error: 'transition-cleanup-pending',
      };
    }
    if (runtime.pendingClosure !== null) {
      return { ok: false, code: 'closure-cleanup-pending', error: 'closure-cleanup-pending' };
    }
    return null;
  }

  /**
   * A start that entered cleanup answers the failure that caused it. Cleanup runs to its resolution
   * inside the command whenever it can, so `cleanupPending` is true only for a journal that is
   * still durable once the attempt has had its turn.
   */
  private async startFailure(): Promise<StartSessionResponseV2> {
    const failed: string | null =
      this.ports.runtime().pendingEnforcementTransition?.failure ?? null;
    await this.runTransitionCleanupIfOwned();
    const pending: boolean = this.ports.runtime().pendingEnforcementTransition !== null;
    const code: StartSessionResponseV2['code'] = isFailureReason(failed)
      ? failed
      : 'tab-enforcement-failed';
    this.publish();
    return pending
      ? { ok: false, code, error: code, cleanupPending: true }
      : { ok: false, code, error: code };
  }

  private inTransitionCleanup(): boolean {
    return this.ports.runtime().pendingEnforcementTransition?.stage === 'cleanup';
  }

  /** The journal guards every gate command shares. Only Hard refuses End (spec 1021). */
  private gateGuard(session: SessionStateV2 | null): CommandResultV2 | null {
    if (this.inTransitionCleanup()) return failure('transition-cleanup-pending');
    if (this.ports.runtime().pendingClosure !== null) return failure('closure-cleanup-pending');
    if (session === null) return failure('no-active-session');
    return null;
  }

  /** Closes a published session, or hands a committed transition its manual end. */
  private async closeActiveSession(session: SessionStateV2, endedAt: number): Promise<void> {
    if (this.ports.runtime().pendingEnforcementTransition !== null) {
      await enterTransitionCleanupV2(this.ports, { cause: 'manual-end', failure: null, endedAt });
      await this.runTransitionCleanupIfOwned();
    } else {
      await closeSessionV2(this.ports, this.effects, {
        endedAt,
        reason: manualEndReasonV2(session.config.duration),
      });
    }
    this.publish();
  }

  /** Persists one gate value and refreshes every live view under a fresh operation. */
  private async commitLiveGate(
    gate: GateState | null,
    events: SessionEventRecordV2[],
    bank?: BankState,
  ): Promise<void> {
    const runtime: RuntimeStateV2 = this.ports.runtime();
    await this.commitLiveViews(
      { ...structuredClone(runtime), gate: structuredClone(gate) },
      events,
      bank,
    );
  }

  /** The legacy gate event one gate command records, tagged with the session that owns it. */
  private gateEvent(
    t: 'gateOpened' | 'gateResisted',
    gate: GateKind,
    session: SessionStateV2 | null,
  ): SessionEventRecordV2[] {
    return [
      {
        t,
        at: this.ports.now(),
        gate,
        ...(session === null ? {} : { sessionId: session.sessionId }),
      },
    ];
  }

  /**
   * One durable live update: a higher runtime revision, a complete replacement command for every
   * current document under one fresh operation, and then the sends. The base-policy checkpoint is
   * carried through untouched.
   */
  private async commitLiveViews(
    base: RuntimeStateV2,
    events: SessionEventRecordV2[] = [],
    bank?: BankState,
  ): Promise<void> {
    if (base.pendingEnforcementTransition !== null) {
      // A running transition owns its frozen view, so the runner refreezes it under the new tuple
      // and the verification budget is left exactly as it was.
      await refreezeTransitionViewV2(this.ports, transitionMatcherV2(this.ports), base);
      // The refreeze writes the runtime, not the journal, so a gate event or a spend needs its own
      // checkpoint over the row the refreeze just left. It replays that row unchanged.
      if (events.length > 0 || bank !== undefined) await this.commitLive(events, bank);
      // Spec 1021: the restarted pass reissues the replacement view. The runner already stepped the
      // stage back off any checkpoint the refreeze invalidated and carried the attempt count and
      // the ten-second deadline through, so the pass that reads this row resumes on what is left of
      // the original budget rather than a fresh one.
      for (const command of Object.values(this.ports.runtime().documentCommands)) {
        await sendDocumentEnforcementCommand(this.ports.transport, command);
      }
      this.publish();
      return;
    }
    const session: SessionStateV2 | null = base.session;
    const runtimeRevision: number = base.runtimeRevision + 1;
    const operationId: string = this.ports.newId();
    const documentCommands: Record<string, FrozenDocumentCommand> = {};
    for (const [key, command] of Object.entries(base.documentCommands)) {
      documentCommands[key] = this.freezeLiveCommand(base, session, command, {
        operationId,
        runtimeRevision,
      });
    }
    const next: RuntimeStateV2 = validRuntime({
      ...base,
      runtimeRevision,
      documentCommands,
    });
    await this.ports.commit({
      checkpointId: `${next.enforcementEpoch}:live-${runtimeRevision}`,
      projection: projectRuntimeDomainV2(next),
      bank: bank ?? this.ports.bank(),
      events: structuredClone(events),
      syncBank: bank !== undefined,
      aggregateSets: {},
      aggregateRemoves: [],
    });
    for (const command of Object.values(documentCommands)) {
      await sendDocumentEnforcementCommand(this.ports.transport, command);
    }
    this.publish();
  }

  /** One checkpoint over the current durable row, for the events and the charge it carries. */
  private async commitLive(events: SessionEventRecordV2[], bank?: BankState): Promise<void> {
    const current: RuntimeStateV2 = this.ports.runtime();
    await this.ports.commit({
      checkpointId: `${current.enforcementEpoch}:live-${current.runtimeRevision}`,
      projection: projectRuntimeDomainV2(current),
      bank: bank ?? this.ports.bank(),
      events: structuredClone(events),
      syncBank: bank !== undefined,
      aggregateSets: {},
      aggregateRemoves: [],
    });
  }

  /** One replacement command for a live update, at the same target and the new tuple. */
  private freezeLiveCommand(
    runtime: RuntimeStateV2,
    session: SessionStateV2 | null,
    previous: FrozenDocumentCommand,
    tuple: { operationId: string; runtimeRevision: number },
  ): FrozenDocumentCommand {
    const verdict: Verdict = structuredClone(previous.verdict);
    const blocked: boolean = verdict.blocked && session !== null && session.phase === 'focus';
    return buildFrozenDocumentCommandV2({
      tabId: previous.tabId,
      documentId: previous.documentId,
      expectedUrl: previous.expectedUrl,
      operationId: tuple.operationId,
      enforcementEpoch: runtime.enforcementEpoch,
      sessionId: session === null ? previous.sessionId : session.sessionId,
      reservedSessionId: session === null ? previous.reservedSessionId : null,
      basePolicyRevision: runtime.basePolicyRevision,
      runtimeRevision: tuple.runtimeRevision,
      verdict: blocked ? verdict : clearVerdictOf(previous),
      presentation: blocked ? 'active' : 'clear',
      overlay:
        blocked && session !== null ? this.activeOverlayFor(runtime, session, previous) : null,
    });
  }

  private activeOverlayFor(
    runtime: RuntimeStateV2,
    session: SessionStateV2,
    previous: FrozenDocumentCommand,
  ): ReturnType<typeof buildActiveOverlayView> {
    const economy = this.ports.economy();
    return buildActiveOverlayView({
      capturedAt: this.ports.now(),
      theme: this.ports.theme(),
      session,
      economy: {
        bankMs: Math.min(this.ports.bank().balanceMs, economy.capMs),
        bankAccrualPerMs: economy.earnRatio,
        bankCapMs: economy.capMs,
        pauseCostMs: economy.pauseMs,
        unlockCostMs: economy.unlockMs,
      },
      gate: runtime.gate,
      activeUnlocks: runtime.unlocks.filter(
        (unlock: SiteUnlock): boolean => unlock.until > this.ports.now(),
      ),
      attemptsToday: this.ports.attemptsToday(),
      stoppedPage: runtime.tabStates[previous.tabId]?.stoppedDocumentId === previous.documentId,
      verdict: structuredClone(previous.verdict),
    });
  }

  /**
   * Spends a ready pause or unlock gate. A pause creates and reads back its replacement boundary
   * before the paused state is durable, so a refused alarm leaves the focus phase untouched.
   */
  private async spendGate(gate: GateState, session: SessionStateV2): Promise<CommandResultV2> {
    const economy: PauseEconomy = this.ports.economy();
    const now: number = this.ports.now();
    const cost: number = gate.kind === 'pause' ? economy.pauseMs : economy.unlockMs;
    const balance: number = this.ports.bank().balanceMs;
    if (balance < cost) return failure('end-not-allowed');
    const spent: BankState = { balanceMs: balance - cost };
    if (gate.kind === 'pause') return this.spendPause(session, spent, cost, now);
    const host: string | null = gate.host;
    if (host === null) return failure('end-not-allowed');
    const runtime: RuntimeStateV2 = this.ports.runtime();
    await this.commitLiveViews(
      {
        ...structuredClone(runtime),
        gate: null,
        unlocks: [...structuredClone(runtime.unlocks), { host, until: now + cost }],
      },
      [{ t: 'unlockTaken', at: now, host, ms: cost, sessionId: session.sessionId }],
      spent,
    );
    return OK;
  }

  /**
   * Buys one pause. The replacement boundary is created and read back before the spend becomes
   * durable, so a refused alarm costs the user nothing and leaves the focus phase untouched. The
   * paused state, the cleared checkpoint, the charge, and the `pauseTaken` event are one checkpoint.
   */
  private async spendPause(
    session: SessionStateV2,
    spent: BankState,
    cost: number,
    now: number,
  ): Promise<CommandResultV2> {
    const paused: SessionStateV2 = beginPauseV2(session, now, cost);
    if ((await this.ensurePhaseAlarm(paused)) === 'alarm-failed') {
      await this.restoreFocusAlarm(session);
      return failure('end-not-allowed');
    }
    const runtime: RuntimeStateV2 = this.ports.runtime();
    const next: RuntimeStateV2 = validRuntime({
      ...structuredClone(runtime),
      session: structuredClone(paused),
      gate: null,
      enforcementCheckpoint: null,
    });
    await this.ports.commit({
      checkpointId: `${paused.sessionId}:pause-${paused.phaseStartedAt}`,
      projection: projectRuntimeDomainV2(next),
      bank: spent,
      events: [{ t: 'pauseTaken', at: now, ms: cost, sessionId: paused.sessionId }],
      syncBank: true,
      aggregateSets: {},
      aggregateRemoves: [],
    });
    await this.effects.clearBlockingForNonBlockingPhase();
    this.publish();
    return OK;
  }

  private async ensurePhaseAlarm(session: SessionStateV2): Promise<'ready' | 'alarm-failed'> {
    return ensurePhaseAlarmV2(this.ports.alarms, session);
  }

  /** A refused pause alarm restores the prior focus boundary, or closes with `alarm-failed`. */
  private async restoreFocusAlarm(session: SessionStateV2): Promise<void> {
    if ((await this.ensurePhaseAlarm(session)) === 'ready') return;
    await closeSessionV2(this.ports, this.effects, {
      endedAt: this.ports.now(),
      reason: 'alarm-failed',
    });
    this.publish();
  }

  /** Prepares and drives a resume from the phase the trigger expires. */
  private async driveResume(
    trigger: 'manual' | 'break-expired',
    phase: 'paused' | 'break',
  ): Promise<CommandResultV2> {
    const runtime: RuntimeStateV2 = this.ports.runtime();
    if (this.inTransitionCleanup()) return failure('transition-cleanup-pending');
    if (runtime.pendingClosure !== null) return failure('closure-cleanup-pending');
    if (runtime.session?.phase !== phase) return failure('no-active-session');
    const prepared: PreparedTransitionV2 = await prepareResumeTransitionV2(this.ports, trigger);
    const driven: TransitionDriveResultV2 = await driveTransitionV2(this.ports, prepared.matcher);
    if (driven.kind === 'cleanup') await this.runTransitionCleanupIfOwned();
    this.publish();
    return driven.kind === 'published' ? OK : failure('no-active-session');
  }

  /**
   * Walks every finished local day before the current instant is settled, exactly as the v1
   * catch-up loop does. Focus is settled through each midnight first, so a closure delta can never
   * land on a day this loop has already closed, and then the Engine's own bookkeeping closes that
   * day through `rolloverCheck`. A `date` in the future rebases backward, which the Engine also
   * owns, so one call at today's boundary hands it that work.
   */
  private async rollLocalDate(): Promise<void> {
    const now: number = this.ports.now();
    const today: string = localDateStr(now);
    if (this.ports.runtime().date > today) {
      await this.ports.rolloverCheck(now);
      return;
    }
    for (let day: number = 0; day < MAX_ROLLOVER_DAYS; day++) {
      const runtime: RuntimeStateV2 = this.ports.runtime();
      if (runtime.date >= today) return;
      const boundary: number = localMidnightAfter(runtime.date);
      await this.settleThrough(boundary);
      await this.ports.rolloverCheck(boundary);
      if (this.ports.runtime().date === runtime.date) return;
    }
  }

  /**
   * Settles the durable session through now and expires what the instant expires. The daily
   * aggregate and bank bookkeeping stay with the retained Engine, which `rolloverCheck` drives.
   */
  private async settleThroughNow(): Promise<void> {
    await this.settleThrough(this.ports.now());
  }

  /** Settles the durable session and expiries through one instant. */
  private async settleThrough(now: number): Promise<void> {
    const runtime: RuntimeStateV2 = pruneHandledOccurrencesOnTickV2(this.ports.runtime(), now);
    const session: SessionStateV2 | null = runtime.session;
    const expired: RuntimeStateV2 = {
      ...structuredClone(runtime),
      gate:
        runtime.gate !== null && runtime.gate.readyAt < now - GATE_EXPIRY_MS ? null : runtime.gate,
      unlocks: runtime.unlocks.filter((unlock: SiteUnlock): boolean => unlock.until > now),
    };
    if (session === null) {
      await this.writeIfChanged(expired);
      return;
    }
    const advanced: SessionAdvanceResultV2 = advanceSessionV2(session, now);
    if (advanced.kind === 'timer-completed') {
      await this.writeIfChanged(expired);
      await closeSessionV2(this.ports, this.effects, {
        endedAt: advanced.endedAt,
        reason: 'timer-completed',
      });
      this.completionEffects();
      return;
    }
    if (advanced.kind === 'resume-required') {
      await this.writeIfChanged({ ...expired, session: structuredClone(advanced.state) });
      const onBreak: boolean = advanced.trigger === 'break-expired';
      await this.driveResume(onBreak ? 'break-expired' : 'manual', onBreak ? 'break' : 'paused');
      return;
    }
    await this.writeIfChanged({ ...expired, session: structuredClone(advanced.state) });
  }

  /** Timer completion is the one end that announces itself, and only when enabled. */
  private completionEffects(): void {
    const settings: SettingsV2 = this.schedule.settings();
    if (settings.sounds.sessionComplete) this.effects.playSound('sessionComplete');
    if (settings.sessionCompleteNotification) {
      this.effects.notify('Focus session complete', 'Your focus session finished.');
    }
    this.publish();
  }

  /** Retries the prepared write this worker owes, on every tick and every command. */
  private async retryOwedClosure(): Promise<void> {
    const reason: 'website-access-lost' | 'content-registration-failed' | null = this.pendingReason;
    if (!this.closurePending || reason === null) return;
    if (this.ports.runtime().session === null) {
      this.closurePending = false;
      return;
    }
    try {
      await prepareClosureV2(this.ports, { endedAt: this.ports.now(), reason });
      this.closurePending = false;
      this.pendingReason = null;
      await this.finishOwedClosure();
    } catch (error: unknown) {
      this.ports.reportError(error);
    }
  }

  /** Commits and cleans the closure whose prepared write just became durable. */
  private async finishOwedClosure(): Promise<void> {
    const { commitClosureV2 } = await import('./closure-runner-v2');
    await commitClosureV2(this.ports);
    await runClosureCleanupAttemptV2(this.ports, this.effects);
  }

  /** Best-effort clears while a closure is owed, so blocking stops even before it is durable. */
  private async clearReachableDocuments(): Promise<void> {
    for (const command of Object.values(this.ports.runtime().documentCommands)) {
      if (command.presentation === 'clear') continue;
      await sendDocumentEnforcementCommand(this.ports.transport, command);
    }
  }

  private async runDueCleanup(): Promise<void> {
    await this.runTransitionCleanupIfOwned();
    await this.runClosureCleanupIfOwned();
  }

  private async runTransitionCleanupIfOwned(): Promise<void> {
    if (!this.inTransitionCleanup()) return;
    await runTransitionCleanupAttemptV2(this.ports, this.effects);
    this.publish();
  }

  private async runClosureCleanupIfOwned(): Promise<void> {
    if (this.ports.runtime().pendingClosure?.stage !== 'cleanup') return;
    await runClosureCleanupAttemptV2(this.ports, this.effects);
    this.publish();
  }

  private async runScheduleCheck(): Promise<void> {
    const { started }: { started: boolean } = await runScheduleCheckV2(this.ports, this.schedule);
    if (started) this.publish();
  }

  /** Sends the newest persisted command for one target, resetting its epoch first when needed. */
  private async sendCurrentCommands(target: {
    tabId: number;
    documentId: string;
    url: string;
  }): Promise<void> {
    const command: FrozenDocumentCommand = await this.currentCommandFor(target);
    if (!this.hasCurrentEpochAck(target.tabId, target.documentId)) {
      const outcome = await sendEpochResetCommand(
        this.ports.transport,
        this.resetCommandFor(target),
      );
      if (outcome.kind !== 'reset') return;
      await this.write({
        ...structuredClone(this.ports.runtime()),
        epochResetAcks: {
          ...structuredClone(this.ports.runtime().epochResetAcks),
          [documentCommandKeyV2(outcome.ack.tabId, outcome.ack.documentId)]: structuredClone(
            outcome.ack,
          ),
        },
      });
    }
    await sendDocumentEnforcementCommand(this.ports.transport, command);
  }

  /**
   * The newest persisted command for one document, freezing one first when the map has none. The
   * frozen value is durable before it is returned, so no caller ever sees a volatile view.
   */
  private async currentCommandFor(target: {
    tabId: number;
    documentId: string;
    url: string;
  }): Promise<FrozenDocumentCommand> {
    const runtime: RuntimeStateV2 = this.ports.runtime();
    const key: string = documentCommandKeyV2(target.tabId, target.documentId);
    const stored: FrozenDocumentCommand | undefined = runtime.documentCommands[key];
    if (stored !== undefined) return structuredClone(stored);
    const session: SessionStateV2 | null = runtime.session;
    const runtimeRevision: number = runtime.runtimeRevision + 1;
    const operationId: string = this.ports.newId();
    const blocked: boolean =
      evaluatedVerdictOf(this.ports, runtime, session, target.url)?.blocked === true;
    const verdict: Verdict =
      evaluatedVerdictOf(this.ports, runtime, session, target.url) ?? CLEAR_VERDICT;
    const focused: SessionStateV2 | null =
      session !== null && session.phase === 'focus' ? session : null;
    const command: FrozenDocumentCommand = buildFrozenDocumentCommandV2({
      tabId: target.tabId,
      documentId: target.documentId,
      expectedUrl: target.url,
      operationId,
      enforcementEpoch: runtime.enforcementEpoch,
      sessionId: session === null ? null : session.sessionId,
      reservedSessionId: session === null ? runtime.enforcementEpoch : null,
      basePolicyRevision: runtime.basePolicyRevision,
      runtimeRevision,
      verdict,
      presentation: blocked ? 'active' : 'clear',
      overlay:
        blocked && focused !== null
          ? this.activeOverlayFor(runtime, focused, {
              ...structuredClone(runtime.documentCommands[key] ?? EMPTY_COMMAND),
              tabId: target.tabId,
              documentId: target.documentId,
              expectedUrl: target.url,
              verdict,
            })
          : null,
    });
    await this.write({
      ...structuredClone(runtime),
      runtimeRevision,
      documentCommands: { ...structuredClone(runtime.documentCommands), [key]: command },
    });
    return command;
  }

  private resetCommandFor(target: {
    tabId: number;
    documentId: string;
    url: string;
  }): ReturnType<typeof buildFrozenEpochResetCommandV2> {
    return buildFrozenEpochResetCommandV2({
      tabId: target.tabId,
      documentId: target.documentId,
      expectedUrl: target.url,
      operationId: this.ports.newId(),
      enforcementEpoch: this.ports.runtime().enforcementEpoch,
    });
  }

  private hasCurrentEpochAck(tabId: number, documentId: string): boolean {
    const runtime: RuntimeStateV2 = this.ports.runtime();
    const ack = runtime.epochResetAcks[documentCommandKeyV2(tabId, documentId)];
    return ack !== undefined && ack.enforcementEpoch === runtime.enforcementEpoch;
  }

  /** A blocked frozen verdict is what makes one navigation an attempt. Sweeps pass null. */
  private async recordAttemptIfBlocked(
    target: { tabId: number; documentId: string; url: string },
    attemptKind: 'navigation' | 'existing' | null,
  ): Promise<void> {
    if (attemptKind === null) return;
    const key: string = documentCommandKeyV2(target.tabId, target.documentId);
    const command: FrozenDocumentCommand | undefined = this.ports.runtime().documentCommands[key];
    if (command?.verdict.blocked !== true) return;
    await this.effects.recordAttempt(target.url, target.tabId, attemptKind);
  }

  private async write(runtime: RuntimeStateV2): Promise<void> {
    await this.ports.writeRuntime(validRuntime(runtime));
  }

  private async writeIfChanged(runtime: RuntimeStateV2): Promise<void> {
    const current: RuntimeStateV2 = this.ports.runtime();
    if (JSON.stringify(current) === JSON.stringify(runtime)) return;
    await this.write(runtime);
  }
}

/**
 * The snapshot for a closure this worker owes but has not made durable. Only an active lifecycle
 * may carry a phase or a clock, so the owed projection reports the idle shape with the closure
 * cleanup the popup should render.
 */
function owedClosureSnapshot(base: SessionSnapshotV2, sessionId: string): SessionSnapshotV2 {
  return {
    ...base,
    lifecycle: {
      kind: 'cleanup',
      journal: 'closure',
      id: `${sessionId}:close`,
      endAuthority: { kind: 'hidden' },
    },
    phase: 'idle',
    config: null,
    startedAt: null,
    phaseStartedAt: null,
    phaseEndsAt: null,
    sessionEndsAt: null,
    sessionFocusedMs: 0,
    cycleIndex: 0,
    bankAccrualPerMs: 0,
    activeUnlocks: [],
    gate: null,
    scheduleActive: false,
  };
}

/** The verdict a focus session's captured policy gives one URL, or null outside focus. */
function evaluatedVerdictOf(
  ports: RuntimePortsV2,
  runtime: RuntimeStateV2,
  session: SessionStateV2 | null,
  url: string,
): Verdict | null {
  if (session === null || session.phase !== 'focus') return null;
  return ports.verdictFor(
    ports.compileMatcher(session.config.rules, session.config.mode),
    url,
    runtime.unlocks,
  );
}

/** Nothing this controller hands a port is allowed to be a runtime the boundary would reject. */
function validRuntime(runtime: RuntimeStateV2): RuntimeStateV2 {
  const parsed: RuntimeStateV2 | null = parseRuntimeStateV2(runtime);
  if (parsed === null) {
    throw new CoreError('invalid-rule', 'the session controller built an invalid runtime');
  }
  return parsed;
}

/** A tick never walks more finished days than this, so a broken clock cannot spin the loop. */
const MAX_ROLLOVER_DAYS: number = 400;
/** A gate the user walked away from expires after this long, matching the v1 engine. */
const GATE_EXPIRY_MS: number = 10 * 60_000;
const CLEAR_VERDICT: Verdict = {
  blocked: false,
  reason: 'no-session',
  categoryId: null,
  matchedPattern: null,
};
const EMPTY_COMMAND: FrozenDocumentCommand = {
  version: 1,
  command: 'apply-enforcement',
  operationId: '00000000-0000-4000-8000-000000000000',
  enforcementEpoch: '00000000-0000-4000-8000-000000000000',
  sessionId: null,
  reservedSessionId: '00000000-0000-4000-8000-000000000000',
  basePolicyRevision: 0,
  runtimeRevision: 0,
  documentId: 'placeholder',
  expectedUrl: 'https://placeholder.invalid/',
  presentation: 'clear',
  verdict: CLEAR_VERDICT,
  overlay: null,
  tabId: 0,
};

/** The v2 session config a manual start turns into the candidate the runner prepares. */
function candidateFor(config: SessionConfigV2): SessionStartCandidate {
  return {
    mode: config.mode,
    strictness: config.strictness,
    duration:
      config.duration.kind === 'until-stopped'
        ? { kind: 'until-stopped' }
        : { kind: 'manual-timed', minutes: config.duration.minutes },
    cycling: structuredClone(config.cycling),
    intention: config.intention,
    source: 'manual',
    scheduleOccurrence: null,
    scheduleWindow: null,
    rules: structuredClone(config.rules),
  };
}

function clearVerdictOf(previous: FrozenDocumentCommand): Verdict {
  return previous.presentation === 'clear' ? structuredClone(previous.verdict) : CLEAR_VERDICT;
}

function failure(code: Exclude<SessionCommandResultCodeV2, 'ok'>): CommandResultV2 {
  return { ok: false, code, error: code };
}

function isFailureReason(
  value: string | null,
): value is
  | 'website-access-lost'
  | 'content-registration-failed'
  | 'alarm-failed'
  | 'tab-enforcement-failed' {
  return (
    value === 'website-access-lost' ||
    value === 'content-registration-failed' ||
    value === 'alarm-failed' ||
    value === 'tab-enforcement-failed'
  );
}

/** The worker owns the tab target, so the wire command never carries it. */
function wireOf(
  command: FrozenDocumentCommand | ReturnType<typeof buildFrozenEpochResetCommandV2>,
): DocumentContentCommand {
  const { tabId: _tabId, ...wire } = command;
  return wire as DocumentContentCommand;
}
