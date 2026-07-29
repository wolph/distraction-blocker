/**
 * Read-side normalisation of the one previous v2 runtime shape a shipped build stored.
 *
 * That build kept every epoch acknowledgement and every checkpoint record with the page address
 * it was earned on, left the last cleanup's clear commands in the map of an idle runtime, stored
 * an allowed page's command for the life of a session, and froze an allowed page in a transition
 * view under the view's own presentation. Every reader is strict about all of it now, so a stored
 * value in that shape is rewritten here, on the way in, into what the current build would have
 * written, and the boot reader persists the result once. Nothing written is ever in the previous
 * shape again.
 *
 * The input is detached exact plain data from `snapshotExactData`, so every read below is of an
 * own property of a plain record and nothing here can throw on a hostile graph. Only the known
 * keys are touched, and only where the entry is exactly the previous shape: an entry the strict
 * parser would refuse on its own is left as it is, so a corrupt runtime reaches the parser and is
 * parked and reported rather than made valid on the way in.
 */

import { CANONICAL_CLEAR_VERDICT } from '../shared/enforcement-v2-validation';
import { isRecord } from '../shared/v2-domain-intrinsics';
import { validateDetachedFrozenDocumentCommand } from './enforcement-persistence-v2-validation';

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
  const epoch: unknown = record.enforcementEpoch;
  if (isRecord(record.epochResetAcks)) {
    next.epochResetAcks = withoutAddresses(record.epochResetAcks);
  }
  next.enforcementCheckpoint = checkpointWithoutAddresses(record.enforcementCheckpoint);
  const transition: unknown = record.pendingEnforcementTransition;
  const closure: unknown = record.pendingClosure;
  const commands: unknown = record.documentCommands;
  if (isRecord(transition)) {
    // The validator checks the views at every stage, cleanup included, so an allowed page is read
    // as the canonical clear the runner freezes for it today wherever a view holds it. The map
    // mirrors the current view before cleanup and equals the clear batch during it, so it is
    // rewritten with the views before cleanup and left exactly as frozen during it.
    next.pendingEnforcementTransition = {
      ...transition,
      startingView: viewWithClears(transition.startingView, epoch),
      activeView: viewWithClears(transition.activeView, epoch),
      startingCheckpoint: checkpointWithoutAddresses(transition.startingCheckpoint),
      checkpoint: checkpointWithoutAddresses(transition.checkpoint),
    };
    if (transition.stage !== 'cleanup' && isRecord(commands)) {
      next.documentCommands = entriesWithClears(commands, epoch);
    }
    return next;
  }
  if (closure === null && isRecord(commands)) {
    // An idle runtime holds no commands, and a session persists only the pages it blocks.
    next.documentCommands =
      record.session === null ? withoutEntries(commands, epoch) : blockedEntries(commands, epoch);
  }
  return next;
}

/** Each entry without the string `url` the previous build stored on it. Anything else is kept. */
function withoutAddresses(entries: UnknownRecord): UnknownRecord {
  const kept: UnknownRecord = {};
  for (const [key, entry] of Object.entries(entries)) {
    kept[key] = withoutAddress(entry);
  }
  return kept;
}

function withoutAddress(entry: unknown): unknown {
  if (!isRecord(entry) || typeof entry.url !== 'string') return entry;
  const { url: _url, ...record } = entry;
  return record;
}

/** A checkpoint whose records lose their string `url`, or the value untouched when it is not one. */
function checkpointWithoutAddresses(checkpoint: unknown): unknown {
  if (!isRecord(checkpoint) || !Array.isArray(checkpoint.documents)) return checkpoint;
  return { ...checkpoint, documents: checkpoint.documents.map(withoutAddress) };
}

/** The map with every valid current-epoch entry removed, so only what the parser refuses stays. */
function withoutEntries(commands: UnknownRecord, epoch: unknown): UnknownRecord {
  const kept: UnknownRecord = {};
  for (const [key, command] of Object.entries(commands)) {
    if (!isCurrentCommand(command, epoch)) kept[key] = command;
  }
  return kept;
}

/** The map with every valid current-epoch allowed entry removed. Blocked and refused entries stay. */
function blockedEntries(commands: UnknownRecord, epoch: unknown): UnknownRecord {
  const kept: UnknownRecord = {};
  for (const [key, command] of Object.entries(commands)) {
    if (!isCurrentCommand(command, epoch) || command.verdict.blocked) kept[key] = command;
  }
  return kept;
}

/** A view whose allowed pages carry the canonical clear, or the value untouched when it is not a view. */
function viewWithClears(view: unknown, epoch: unknown): unknown {
  if (!isRecord(view) || !isRecord(view.documents)) return view;
  return { ...view, documents: entriesWithClears(view.documents, epoch) };
}

/**
 * Each entry that is exactly the previous allowed shape, a valid current-epoch command with an
 * allowed verdict, no overlay, and the view's own presentation, as the canonical clear at its own
 * tuple. Every other entry, blocked or refused, is untouched.
 */
function entriesWithClears(commands: UnknownRecord, epoch: unknown): UnknownRecord {
  const next: UnknownRecord = {};
  for (const [key, command] of Object.entries(commands)) {
    next[key] = isPreviousAllowedShape(command, epoch)
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

function isPreviousAllowedShape(command: unknown, epoch: unknown): command is UnknownRecord {
  return (
    isCurrentCommand(command, epoch) &&
    !command.verdict.blocked &&
    command.overlay === null &&
    (command.presentation === 'starting' || command.presentation === 'active')
  );
}

/** A frozen command the strict parser accepts on its own, under the runtime's own epoch. */
function isCurrentCommand(
  command: unknown,
  epoch: unknown,
): command is UnknownRecord & { verdict: { blocked: boolean } } {
  return validateDetachedFrozenDocumentCommand(command) && command.enforcementEpoch === epoch;
}
