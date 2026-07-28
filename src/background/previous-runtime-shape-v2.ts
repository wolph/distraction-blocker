/**
 * Read-side normalisation of the one previous v2 runtime shape a shipped build stored.
 *
 * That build kept every epoch acknowledgement with the page address it was earned on, left the
 * last cleanup's clear commands in the map of an idle runtime, stored an allowed page's command
 * for the life of a session, and froze an allowed page in a transition view under the view's own
 * presentation. Every reader is strict about all four now, so a stored value in that shape is
 * rewritten here, on the way in, into what the current build would have written, and the boot
 * reader persists the result once. Nothing written is ever in the previous shape again.
 *
 * The input is detached exact plain data from `snapshotExactData`, so every read below is of an
 * own property of a plain record and nothing here can throw on a hostile graph. Only the known
 * keys are touched. Everything else is left for the strict parser to judge.
 */

import { CANONICAL_CLEAR_VERDICT } from '../shared/enforcement-v2-validation';
import { isRecord } from '../shared/v2-domain-intrinsics';

type UnknownRecord = Record<string, unknown>;

/** The stored value rewritten into the current shape, for the strict parser to accept or refuse. */
export function normalisePreviousRuntimeShapeV2(runtime: UnknownRecord): UnknownRecord {
  const next: UnknownRecord = normaliseDomain(runtime);
  const checkpoint: unknown = runtime.commitCheckpoint;
  // An outstanding commit checkpoint projects the same domain fields, and the parser requires the
  // stored runtime to equal that projection field by field, so both are normalised the same way.
  if (isRecord(checkpoint) && isRecord(checkpoint.projection)) {
    next.commitCheckpoint = { ...checkpoint, projection: normaliseDomain(checkpoint.projection) };
  }
  return next;
}

function normaliseDomain(record: UnknownRecord): UnknownRecord {
  const next: UnknownRecord = { ...record };
  if (isRecord(record.epochResetAcks)) {
    next.epochResetAcks = withoutAckAddresses(record.epochResetAcks);
  }
  const transition: unknown = record.pendingEnforcementTransition;
  const closure: unknown = record.pendingClosure;
  const commands: unknown = record.documentCommands;
  if (!isRecord(commands)) return next;
  if (transition === null && closure === null) {
    // An idle runtime holds no commands, and a session persists only the pages it blocks.
    next.documentCommands = record.session === null ? {} : blockedEntries(commands);
    return next;
  }
  if (isRecord(transition) && transition.stage !== 'cleanup') {
    // A pre-cleanup transition owns its views, and the map mirrors the current one. An allowed
    // page is read as the canonical clear the runner freezes for it today, in both places.
    next.pendingEnforcementTransition = {
      ...transition,
      startingView: viewWithClears(transition.startingView),
      activeView: viewWithClears(transition.activeView),
    };
    next.documentCommands = entriesWithClears(commands);
  }
  // A cleanup batch is left exactly as its journal froze it: the parser requires equality.
  return next;
}

/** Each acknowledgement without the `url` the previous build stored on it. */
function withoutAckAddresses(acks: UnknownRecord): UnknownRecord {
  const kept: UnknownRecord = {};
  for (const [key, ack] of Object.entries(acks)) {
    if (isRecord(ack) && Object.hasOwn(ack, 'url')) {
      const { url: _url, ...record } = ack;
      kept[key] = record;
    } else {
      kept[key] = ack;
    }
  }
  return kept;
}

/** Only the entries whose frozen verdict blocks the page. */
function blockedEntries(commands: UnknownRecord): UnknownRecord {
  const kept: UnknownRecord = {};
  for (const [key, command] of Object.entries(commands)) {
    if (isRecord(command) && isRecord(command.verdict) && command.verdict.blocked === true) {
      kept[key] = command;
    }
  }
  return kept;
}

/** A view whose allowed pages carry the canonical clear, or the value untouched when it is not a view. */
function viewWithClears(view: unknown): unknown {
  if (!isRecord(view) || !isRecord(view.documents)) return view;
  return { ...view, documents: entriesWithClears(view.documents) };
}

/** Each allowed entry as the canonical clear at its own tuple. Blocked entries are untouched. */
function entriesWithClears(commands: UnknownRecord): UnknownRecord {
  const next: UnknownRecord = {};
  for (const [key, command] of Object.entries(commands)) {
    next[key] = allowedUnderOwnPresentation(command)
      ? {
          ...command,
          presentation: 'clear',
          verdict: { ...CANONICAL_CLEAR_VERDICT },
          overlay: null,
        }
      : command;
  }
  return next;
}

function allowedUnderOwnPresentation(command: unknown): command is UnknownRecord {
  return (
    isRecord(command) &&
    isRecord(command.verdict) &&
    command.verdict.blocked === false &&
    command.presentation !== 'clear'
  );
}
