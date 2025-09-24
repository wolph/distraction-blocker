/**
 * Pure content-side enforcement state machine for one document. It owns the epoch handshake, the
 * same-epoch tuple ordering, and the exact response the worker validates. No DOM, no chrome API,
 * no side effect: the caller parses the command, applies the render, and sends the response.
 */
import type {
  ContentEnforcementResponse,
  ContentEnforcementState,
  ContentEnforcementTuple,
  DocumentContentCommand,
  DocumentEnforcementCommand,
  ResetEnforcementEpochCommand,
} from '../shared/enforcement-v2';
import { canonicalSessionIdentity } from '../shared/enforcement-v2-validation';
import { CoreError } from '../shared/errors';
import { type ExactDataSnapshot, exactDataEqual, snapshotExactData } from '../shared/exact-data';
import type { Verdict } from '../shared/types';
import { isNonBlankString, isRecord } from '../shared/v2-domain-intrinsics';

export interface ContentCommandResultV2 {
  state: ContentEnforcementState;
  /** null means rejected: the document answers undefined and the worker records a fatal mismatch */
  response: ContentEnforcementResponse | null;
  render: 'apply' | 'clear' | 'none';
}

export function createContentEnforcementState(): ContentEnforcementState {
  return {
    enforcementEpoch: null,
    retiredEnforcementEpochs: [],
    tuple: null,
    presentation: null,
    verdict: null,
    overlay: null,
  };
}

/**
 * Orders two tuples of one epoch by base policy revision first and runtime revision second. Epoch
 * UUIDs are an equality namespace, so ordering across epochs is a rule violation, not a result.
 * Session identity is deliberately absent here and is checked separately at an equal base revision.
 */
export function compareEnforcementTuplesV2(
  left: ContentEnforcementTuple,
  right: ContentEnforcementTuple,
): -1 | 0 | 1 {
  if (left.enforcementEpoch !== right.enforcementEpoch) {
    throw new CoreError(
      'invalid-rule',
      'enforcement tuples of different epochs have no order: epoch UUIDs compare only for equality',
    );
  }
  if (left.basePolicyRevision !== right.basePolicyRevision) {
    return left.basePolicyRevision < right.basePolicyRevision ? -1 : 1;
  }
  if (left.runtimeRevision === right.runtimeRevision) return 0;
  return left.runtimeRevision < right.runtimeRevision ? -1 : 1;
}

/**
 * Returns the canonical identity of a tuple: the single non-null identity string, whichever field
 * carries it. Durable activation promotes the reserved string to `sessionId`, so a reservation and
 * its promotion are one identity and differ only by tuple. The shared helper owns that rule and
 * answers null for the pair the command parser already excludes, which becomes the empty identity.
 */
export function canonicalSessionIdentityV2(tuple: ContentEnforcementTuple): string {
  return canonicalSessionIdentity(tuple.sessionId, tuple.reservedSessionId) ?? '';
}

export function handleContentCommandV2(
  state: ContentEnforcementState,
  command: DocumentContentCommand,
  observedUrl: string,
  handledAt: number,
): ContentCommandResultV2 {
  const detached: DocumentContentCommand | null = detachCommand(command);
  if (detached === null) return rejected(state);
  return detached.command === 'reset-enforcement-epoch'
    ? handleResetCommand(state, detached, observedUrl, handledAt)
    : handleEnforcementCommand(state, detached, observedUrl, handledAt);
}

/**
 * Detaches the command once. Every later read, comparison, response, and stored view uses this
 * snapshot, so a live object that answers differently between two reads cannot reach state. A
 * command that is not exact plain data has no snapshot and is rejected instead of thrown on: the
 * caller parses first, so an unparsed value is already a worker-side fault.
 */
function detachCommand(command: DocumentContentCommand): DocumentContentCommand | null {
  const snapshot: ExactDataSnapshot | null = snapshotExactData(command);
  if (snapshot === null || !hasContentCommandTag(snapshot.value)) return null;
  return snapshot.value;
}

/**
 * The caller parses before dispatch, so an exact snapshot carrying a command tag is that command.
 * The three fields every response echoes are still checked, so no answer this module builds can be
 * a response the landed parser rejects.
 */
function hasContentCommandTag(value: unknown): value is DocumentContentCommand {
  if (!isRecord(value)) return false;
  if (value.command !== 'reset-enforcement-epoch' && value.command !== 'apply-enforcement') {
    return false;
  }
  return (
    isNonBlankString(value.operationId) &&
    isNonBlankString(value.enforcementEpoch) &&
    isNonBlankString(value.documentId)
  );
}

function handleResetCommand(
  state: ContentEnforcementState,
  command: ResetEnforcementEpochCommand,
  observedUrl: string,
  handledAt: number,
): ContentCommandResultV2 {
  const currentEpoch: string | null = state.enforcementEpoch;
  if (state.retiredEnforcementEpochs.includes(command.enforcementEpoch)) {
    return rejectRetiredReset(state, command, currentEpoch, observedUrl, handledAt);
  }
  const response: ContentEnforcementResponse = {
    version: 1,
    disposition: 'epoch-reset',
    operationId: command.operationId,
    enforcementEpoch: command.enforcementEpoch,
    documentId: command.documentId,
    observedUrl,
    handledAt,
  };
  if (currentEpoch === command.enforcementEpoch) {
    // Replaying a reset for the current epoch must not clear a newer same-epoch view.
    return { state: detachedState(state), response, render: 'none' };
  }
  return {
    state: {
      enforcementEpoch: command.enforcementEpoch,
      retiredEnforcementEpochs: retireEpoch(state.retiredEnforcementEpochs, currentEpoch),
      tuple: null,
      presentation: null,
      verdict: null,
      overlay: null,
    },
    response,
    render: 'clear',
  };
}

function handleEnforcementCommand(
  state: ContentEnforcementState,
  command: DocumentEnforcementCommand,
  observedUrl: string,
  handledAt: number,
): ContentCommandResultV2 {
  const currentEpoch: string | null = state.enforcementEpoch;
  if (currentEpoch !== command.enforcementEpoch) {
    return {
      state: detachedState(state),
      response: {
        version: 1,
        disposition: 'reset-required',
        operationId: command.operationId,
        enforcementEpoch: command.enforcementEpoch,
        documentId: command.documentId,
        observedUrl,
        requestedEpoch: command.enforcementEpoch,
        currentEpoch,
        handledAt,
      },
      render: 'none',
    };
  }
  const requested: ContentEnforcementTuple = commandTuple(command);
  const current: ContentEnforcementTuple | null = state.tuple;
  if (current === null) return applyCommand(state, command, requested, observedUrl, handledAt);
  if (
    requested.basePolicyRevision === current.basePolicyRevision &&
    canonicalSessionIdentityV2(requested) !== canonicalSessionIdentityV2(current)
  ) {
    return rejected(state);
  }
  const order: -1 | 0 | 1 = compareEnforcementTuplesV2(requested, current);
  if (order === 1) return applyCommand(state, command, requested, observedUrl, handledAt);
  if (order === -1) {
    return staleCommandResult(state, command, requested, current, observedUrl, handledAt);
  }
  if (!storedViewEqualsCommand(state, command)) return rejected(state);
  return {
    state: detachedState(state),
    response: appliedResponse(command, observedUrl, handledAt),
    render: renderForVerdict(command.verdict),
  };
}

/**
 * A retired epoch is never the current epoch, so a rejection always names a different current one.
 * A state that retired an epoch while holding none cannot name one, and answers nothing at all.
 */
function rejectRetiredReset(
  state: ContentEnforcementState,
  command: ResetEnforcementEpochCommand,
  currentEpoch: string | null,
  observedUrl: string,
  handledAt: number,
): ContentCommandResultV2 {
  if (currentEpoch === null || currentEpoch === command.enforcementEpoch) return rejected(state);
  return {
    state: detachedState(state),
    response: {
      version: 1,
      disposition: 'epoch-reset-rejected',
      operationId: command.operationId,
      enforcementEpoch: command.enforcementEpoch,
      currentEpoch,
      reason: 'retired-epoch',
      documentId: command.documentId,
      observedUrl,
      handledAt,
    },
    render: 'none',
  };
}

/** Reports the tuple the worker asked for and the higher tuple this document keeps. */
function staleCommandResult(
  state: ContentEnforcementState,
  command: DocumentEnforcementCommand,
  requested: ContentEnforcementTuple,
  current: ContentEnforcementTuple,
  observedUrl: string,
  handledAt: number,
): ContentCommandResultV2 {
  return {
    state: detachedState(state),
    response: {
      version: 1,
      disposition: 'stale-command',
      operationId: command.operationId,
      enforcementEpoch: command.enforcementEpoch,
      documentId: command.documentId,
      observedUrl,
      requested,
      current: { ...current },
      handledAt,
    },
    render: 'none',
  };
}

/** Atomically stores the tuple, presentation, verdict, and frozen view of an accepted command. */
function applyCommand(
  state: ContentEnforcementState,
  command: DocumentEnforcementCommand,
  tuple: ContentEnforcementTuple,
  observedUrl: string,
  handledAt: number,
): ContentCommandResultV2 {
  return {
    state: {
      enforcementEpoch: command.enforcementEpoch,
      retiredEnforcementEpochs: [...state.retiredEnforcementEpochs],
      tuple,
      presentation: command.presentation,
      verdict: command.verdict,
      overlay: command.overlay,
    },
    response: appliedResponse(command, observedUrl, handledAt),
    render: renderForVerdict(command.verdict),
  };
}

function appliedResponse(
  command: DocumentEnforcementCommand,
  observedUrl: string,
  handledAt: number,
): ContentEnforcementResponse {
  return {
    version: 1,
    disposition: 'applied',
    operationId: command.operationId,
    enforcementEpoch: command.enforcementEpoch,
    sessionId: command.sessionId,
    reservedSessionId: command.reservedSessionId,
    basePolicyRevision: command.basePolicyRevision,
    runtimeRevision: command.runtimeRevision,
    documentId: command.documentId,
    observedUrl,
    presentation: command.presentation,
    verdict: command.verdict,
    overlay: command.overlay,
    handledAt,
  };
}

function rejected(state: ContentEnforcementState): ContentCommandResultV2 {
  return { state: detachedState(state), response: null, render: 'none' };
}

/**
 * Returns a new state container with its own retired-epoch array and tuple. The presentation,
 * verdict, and view are exact-data snapshots this module never mutates and the renderer only
 * reads, so a result that changes nothing shares those three values with the previous state.
 */
function detachedState(state: ContentEnforcementState): ContentEnforcementState {
  return {
    enforcementEpoch: state.enforcementEpoch,
    retiredEnforcementEpochs: [...state.retiredEnforcementEpochs],
    tuple: state.tuple === null ? null : { ...state.tuple },
    presentation: state.presentation,
    verdict: state.verdict,
    overlay: state.overlay,
  };
}

function retireEpoch(retired: readonly string[], epoch: string | null): string[] {
  return epoch === null || retired.includes(epoch) ? [...retired] : [...retired, epoch];
}

function commandTuple(command: DocumentEnforcementCommand): ContentEnforcementTuple {
  return {
    enforcementEpoch: command.enforcementEpoch,
    sessionId: command.sessionId,
    reservedSessionId: command.reservedSessionId,
    basePolicyRevision: command.basePolicyRevision,
    runtimeRevision: command.runtimeRevision,
  };
}

function storedViewEqualsCommand(
  state: ContentEnforcementState,
  command: DocumentEnforcementCommand,
): boolean {
  return (
    state.presentation === command.presentation &&
    exactDataEqual(state.verdict, command.verdict) &&
    exactDataEqual(state.overlay, command.overlay)
  );
}

function renderForVerdict(verdict: Verdict): 'apply' | 'clear' {
  return verdict.blocked ? 'apply' : 'clear';
}
