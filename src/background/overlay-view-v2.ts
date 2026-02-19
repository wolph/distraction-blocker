/**
 * Pure builders for the worker's frozen content payloads: the two `DocumentOverlayView` shapes and
 * the document commands that carry them. Every builder validates what it produces with the landed
 * detached validators and raises `CoreError('invalid-rule', ...)` instead of returning a value the
 * content parser would reject, so a command that leaves this module is a command a document can
 * apply. Nothing here reads storage, a browser API, or a clock.
 */

import type {
  ActiveOverlayCopy,
  DocumentOverlayView,
  EnforcementPresentation,
  StartingOverlayCopy,
} from '../shared/enforcement-v2';
import {
  canonicalSessionIdentity,
  validateDetachedDocumentOverlayView,
} from '../shared/enforcement-v2-validation';
import { CoreError } from '../shared/errors';
import { snapshotExactData } from '../shared/exact-data';
import type {
  GateKind,
  GateState,
  SessionDuration,
  SessionStateV2,
  SiteUnlock,
  Strictness,
  ThemeMode,
  Verdict,
} from '../shared/types';
import { isNonBlankString, isSafeTimestamp } from '../shared/v2-domain-intrinsics';
import { verdictLabel } from '../shared/verdict-label';
import type { FrozenDocumentCommand, FrozenEpochResetCommand } from './enforcement-persistence-v2';
import {
  validateDetachedFrozenDocumentCommand,
  validateDetachedFrozenEpochResetCommand,
} from './enforcement-persistence-v2-validation';

type ActiveOverlayView = Extract<DocumentOverlayView, { presentation: 'active' }>;
type ActiveStatusCopy = ActiveOverlayCopy['status'];

/** The status sentence and the bare wall clock behind it always travel together. */
interface ActiveLeadCopy {
  status: ActiveStatusCopy;
  lockedUntil: string | null;
}

const STARTING_TITLE: StartingOverlayCopy['title'] = 'Focus Lock is starting';
const STARTING_DETAIL: StartingOverlayCopy['detail'] = 'Applying your selected rules.';
const STOPPED_PAGE_COPY: NonNullable<StartingOverlayCopy['stoppedPage']> =
  'This page did not load. It will load by itself when the session ends.';
const UNTIL_STOPPED_STATUS: Extract<ActiveStatusCopy, { kind: 'until-stopped' }>['text'] =
  'Focus Lock is active until you end it from the popup.';

/** The copy every active view repeats word for word. The view type pins each literal. */
const FIXED_ACTIVE_COPY: Readonly<
  Pick<
    ActiveOverlayCopy,
    | 'bankUnit'
    | 'endAction'
    | 'bankWaitFallback'
    | 'bankWaitPrefix'
    | 'gateBack'
    | 'gatePhraseLabel'
    | 'transportError'
  >
> = {
  bankUnit: 'pause banked',
  endAction: 'End session',
  bankWaitFallback: 'earn pause time by focusing',
  bankWaitPrefix: 'ready in',
  gateBack: 'Never mind, back to work',
  gatePhraseLabel: 'Type this to confirm:',
  transportError: 'Focus Lock could not update this action. Try again.',
};

const GATE_CONFIRM_COPY: Readonly<Record<GateKind, string>> = {
  pause: 'Take the pause',
  unlockSite: 'Unlock this site',
  cancel: 'End the session',
};

export interface StartingViewInputV2 {
  capturedAt: number;
  theme: ThemeMode;
  stoppedPage: boolean;
  verdict: Verdict;
}

export interface ActiveViewInputV2 {
  capturedAt: number;
  theme: ThemeMode;
  /** phase must be focus: pause and break are non-blocking and receive no active view */
  session: SessionStateV2;
  economy: {
    bankMs: number;
    bankAccrualPerMs: number;
    bankCapMs: number;
    pauseCostMs: number;
    unlockCostMs: number;
  };
  gate: GateState | null;
  activeUnlocks: SiteUnlock[];
  attemptsToday: number;
  stoppedPage: boolean;
  verdict: Verdict;
}

export interface DocumentCommandInputV2 {
  tabId: number;
  documentId: string;
  expectedUrl: string;
  operationId: string;
  enforcementEpoch: string;
  sessionId: string | null;
  reservedSessionId: string | null;
  basePolicyRevision: number;
  runtimeRevision: number;
  verdict: Verdict;
  presentation: EnforcementPresentation;
  overlay: DocumentOverlayView | null;
}

export interface EpochResetCommandInputV2 {
  tabId: number;
  documentId: string;
  expectedUrl: string;
  operationId: string;
  enforcementEpoch: string;
}

/** The starting page states what is happening and offers nothing to press. */
export function buildStartingOverlayView(input: StartingViewInputV2): DocumentOverlayView {
  return validatedView({
    version: 1,
    presentation: 'starting',
    capturedAt: input.capturedAt,
    theme: input.theme,
    stoppedPage: input.stoppedPage,
    copy: {
      title: STARTING_TITLE,
      detail: STARTING_DETAIL,
      verdictProvenance: verdictLabel(input.verdict),
      stoppedPage: stoppedPageCopy(input.stoppedPage),
    },
    actions: { end: 'hidden' },
  });
}

/**
 * The active page for one focus phase. A timed session counts down to its own end and may offer
 * the End action. An indefinite session says so in words, because the popup owns its ending.
 */
export function buildActiveOverlayView(input: ActiveViewInputV2): DocumentOverlayView {
  const session: SessionStateV2 = input.session;
  if (session.phase !== 'focus') {
    invalidView(`an active overlay view needs a focus phase, not ${session.phase}`);
  }
  const duration: SessionDuration = session.config.duration;
  const gate: GateState | null = input.gate;
  return validatedView({
    version: 1,
    presentation: 'active',
    theme: input.theme,
    sessionId: session.sessionId,
    phase: 'focus',
    mode: session.config.mode,
    strictness: session.config.strictness,
    duration,
    timing: {
      capturedAt: input.capturedAt,
      phaseStartedAt: session.phaseStartedAt,
      phaseEndsAt: session.phaseEndsAt,
      sessionEndsAt: session.sessionEndsAt,
    },
    economy: { ...input.economy },
    gate,
    activeUnlocks: input.activeUnlocks,
    attemptsToday: input.attemptsToday,
    stoppedPage: input.stoppedPage,
    actions: activeActions(session.config.strictness, duration, gate),
    copy: activeCopy(input, duration, gate),
  });
}

/**
 * The local wall clock a timed session is locked until, such as `14:35`, and `9:05` before ten.
 *
 * The hour is deliberately unpadded: this is a sentence on a blocked page, where a wall-clock time
 * reads the way it is spoken, and a leading zero adds nothing. The minute is padded, which is the
 * half that changes how the time reads.
 */
export function formatLockedUntilV2(sessionEndsAt: number): string {
  if (!isSafeTimestamp(sessionEndsAt)) {
    invalidView('a locked-until time must be a safe timestamp');
  }
  const at: Date = new Date(sessionEndsAt);
  return `${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/**
 * The End action belongs to timed Flexible and Friction sessions. Hard sessions refuse it and the
 * popup owns every indefinite ending, so those two answer `hidden` on the blocked page.
 */
export function overlayEndActionV2(
  strictness: Strictness,
  duration: SessionDuration,
): 'hidden' | 'request-end' {
  if (strictness === 'hard' || duration.kind === 'until-stopped') return 'hidden';
  return 'request-end';
}

/** One frozen command for one document. The worker owns the tab, so the command carries it. */
export function buildFrozenDocumentCommandV2(input: DocumentCommandInputV2): FrozenDocumentCommand {
  if (canonicalSessionIdentity(input.sessionId, input.reservedSessionId) === null) {
    invalidView('a document command carries exactly one of sessionId and reservedSessionId');
  }
  const command: FrozenDocumentCommand = {
    version: 1,
    command: 'apply-enforcement',
    operationId: input.operationId,
    enforcementEpoch: input.enforcementEpoch,
    sessionId: input.sessionId,
    reservedSessionId: input.reservedSessionId,
    basePolicyRevision: input.basePolicyRevision,
    runtimeRevision: input.runtimeRevision,
    documentId: input.documentId,
    expectedUrl: input.expectedUrl,
    presentation: input.presentation,
    verdict: input.verdict,
    overlay: input.overlay,
    tabId: input.tabId,
  };
  const detached: unknown = snapshotExactData(command)?.value;
  if (!validateDetachedFrozenDocumentCommand(detached)) {
    invalidView(
      `a ${input.presentation} document command does not satisfy the frozen command contract`,
    );
  }
  return detached;
}

/** The epoch handshake one document answers before it accepts any enforcement command. */
export function buildFrozenEpochResetCommandV2(
  input: EpochResetCommandInputV2,
): FrozenEpochResetCommand {
  const command: FrozenEpochResetCommand = {
    version: 1,
    command: 'reset-enforcement-epoch',
    operationId: input.operationId,
    enforcementEpoch: input.enforcementEpoch,
    documentId: input.documentId,
    expectedUrl: input.expectedUrl,
    tabId: input.tabId,
  };
  const detached: unknown = snapshotExactData(command)?.value;
  if (!validateDetachedFrozenEpochResetCommand(detached)) {
    invalidView('an epoch reset command does not satisfy the frozen command contract');
  }
  return detached;
}

function activeActions(
  strictness: Strictness,
  duration: SessionDuration,
  gate: GateState | null,
): ActiveOverlayView['actions'] {
  if (gate !== null) return { state: 'gate', end: 'hidden', pause: 'hidden', unlock: 'hidden' };
  return {
    state: 'ready',
    end: overlayEndActionV2(strictness, duration),
    pause: 'request-gate',
    unlock: 'request-gate',
  };
}

function activeCopy(
  input: ActiveViewInputV2,
  duration: SessionDuration,
  gate: GateState | null,
): ActiveOverlayCopy {
  const lead: ActiveLeadCopy = leadCopy(duration, input.session.sessionEndsAt);
  return {
    ...FIXED_ACTIVE_COPY,
    status: lead.status,
    lockedUntil: lead.lockedUntil,
    intention: trimmedIntention(input.session.config.intention),
    attempts: attemptsCopy(input.attemptsToday),
    verdictProvenance: verdictLabel(input.verdict),
    stoppedPage: stoppedPageCopy(input.stoppedPage),
    pauseAction: `Pause blocking for ${costMinutes(input.economy.pauseCostMs)} min`,
    unlockAction: `Unlock this site for ${costMinutes(input.economy.unlockCostMs)} min`,
    gateTitle: gate === null ? null : gateTitleCopy(gate),
    gateConfirm: gate === null ? null : GATE_CONFIRM_COPY[gate.kind],
  };
}

/**
 * The status sentence the page leads with, and the bare wall clock behind a timed one. A timed
 * session with no end has no honest sentence, so it raises instead of borrowing the indefinite one.
 */
function leadCopy(duration: SessionDuration, sessionEndsAt: number | null): ActiveLeadCopy {
  if (duration.kind === 'until-stopped') {
    return { status: { kind: 'until-stopped', text: UNTIL_STOPPED_STATUS }, lockedUntil: null };
  }
  const lockedUntil: string = formatLockedUntilV2(sessionEndsAt ?? Number.NaN);
  return { status: { kind: 'timed', text: `Locked until ${lockedUntil}` }, lockedUntil };
}

function gateTitleCopy(gate: GateState): string {
  if (gate.kind === 'pause') return 'Take a pause?';
  if (gate.kind === 'unlockSite') {
    // The gate contract already binds a non-blank host to this kind, in `isGate` and in the
    // detached predicate the runtime uses, so borrowing "this site" would paper over a gate no
    // validator produced. This module raises for an unrenderable input rather than inventing copy.
    if (!isNonBlankString(gate.host)) invalidView('an unlock gate names the host it unlocks');
    return `Unlock ${gate.host}?`;
  }
  return 'End this session';
}

/** A sentence, not a form field, so none of them reads as a word rather than a zero. */
function attemptsCopy(attemptsToday: number): string {
  if (attemptsToday === 0) return 'No attempts blocked today';
  return attemptsToday === 1
    ? '1 attempt blocked today'
    : `${attemptsToday} attempts blocked today`;
}

function trimmedIntention(intention: string): string | null {
  const goal: string = intention.trim();
  return goal === '' ? null : goal;
}

function stoppedPageCopy(stoppedPage: boolean): StartingOverlayCopy['stoppedPage'] {
  return stoppedPage ? STOPPED_PAGE_COPY : null;
}

function costMinutes(costMs: number): number {
  return Math.round(costMs / 60_000);
}

/** Detaches the built view and refuses anything the content parser would reject. */
function validatedView(view: DocumentOverlayView): DocumentOverlayView {
  const detached: unknown = snapshotExactData(view)?.value;
  if (!validateDetachedDocumentOverlayView(detached)) {
    invalidView(`a ${view.presentation} overlay view does not satisfy the render contract`);
  }
  return detached;
}

function invalidView(message: string): never {
  throw new CoreError('invalid-rule', message);
}
