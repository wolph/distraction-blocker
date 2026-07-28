/**
 * The v2 runtime a build before the address-free records left in storage, modelled on a real
 * profile read through the devtools bridge: an idle runtime under the v2
 * schema marker whose 105 epoch acknowledgements each carry the page address they were earned
 * on, and whose command map still holds the 105 clear commands of the last cleanup batch. The
 * active variant is the same build mid-session, with one blocked page frozen under the active
 * overlay and one allowed page frozen under the active presentation with its own verdict, which
 * is the shape a start view held before allowed pages became canonical clears.
 *
 * The idle profile is written out as plain data so it stays the shape storage held, whatever the
 * unit fixtures do next. The active profile borrows the unit fixtures for the overlay a blocked
 * command has to carry, which no hand-written literal should repeat. Every builder returns fresh
 * objects, so a test may mutate what it gets without leaking into the next one.
 */

import type {
  EpochResetAckRecord,
  FrozenDocumentCommand,
} from '../../src/background/enforcement-persistence-v2';
import type { RuntimeStateV2 } from '../../src/background/runtime-v2-types';
import type { DailyAgg } from '../../src/shared/types';
import {
  ACTIVE_OPERATION_ID,
  activeCommand,
  allowedVerdict,
  PUBLISHED_REVISION,
  publishedFocusRuntime,
  untilStoppedFocusSession,
} from '../unit/background/runtime-v2-fixtures';

/** The acknowledgement the previous build stored: the record plus the address the reset named. */
export interface PreviousEpochResetAckV2 extends EpochResetAckRecord {
  url: string;
}

/** A v2 runtime whose acknowledgements are the previous build's, address included. */
export type PreviousRuntimeProfileV2 = Omit<RuntimeStateV2, 'epochResetAcks'> & {
  epochResetAcks: Record<string, PreviousEpochResetAckV2>;
};

export const PREVIOUS_V2_EPOCH: string = '30000000-0000-4000-8000-0000000000aa';
export const PREVIOUS_V2_SESSION_ID: string = '10000000-0000-4000-8000-0000000000aa';
export const PREVIOUS_V2_CLEANUP_OPERATION: string = '20000000-0000-4000-8000-0000000000aa';
export const PREVIOUS_V2_RESET_OPERATION: string = '20000000-0000-4000-8000-0000000000ab';
export const PREVIOUS_V2_TAB_COUNT: number = 105;
export const PREVIOUS_V2_BASE_REVISION: number = 7;
export const PREVIOUS_V2_CLEAR_REVISION: number = 21;
export const PREVIOUS_V2_LOCAL_DATE: string = '2026-09-10';
/** Fixed local clock for the captured profile. */
export const PREVIOUS_V2_READ_AT: number = new Date(2026, 8, 10, 21, 40, 0, 0).getTime();
/** The first tab id of the profile. The tabs run upwards from here, one document each. */
export const PREVIOUS_V2_FIRST_TAB_ID: number = 100;

/** The page the profile's tab at `index` was on when the last cleanup cleared it. */
export function previousV2TabUrl(index: number): string {
  return `https://site-${String(index)}.example/read/${String(index)}`;
}

export function previousV2TabId(index: number): number {
  return PREVIOUS_V2_FIRST_TAB_ID + index;
}

export function previousV2DocumentId(index: number): string {
  return `previous-document-${String(index)}`;
}

/** The map key the profile stored an entry under, which is the tab and document pair. */
export function previousV2DocumentKey(index: number): string {
  return `${String(previousV2TabId(index))}:${previousV2DocumentId(index)}`;
}

/** The day the profile was read, with the attempts the owner's blocked pages counted. */
export function previousV2TodayAgg(date: string = PREVIOUS_V2_LOCAL_DATE): DailyAgg {
  return {
    date,
    focusMs: 5_400_000,
    sessionsStarted: 3,
    sessionsCompleted: 2,
    attempts: { 'site-1.example': 4, 'site-2.example': 1 },
    attemptsOther: 0,
    pausesTaken: 1,
    pauseMsSpent: 300_000,
    pauseMsEarned: 900_000,
    unlocksTaken: 0,
    unlockMsSpent: 0,
    resisted: 2,
  };
}

/** One acknowledgement of the previous shape, for the profile's tab at `index`. */
export function previousV2EpochResetAck(
  index: number,
  epoch: string = PREVIOUS_V2_EPOCH,
): PreviousEpochResetAckV2 {
  return {
    version: 1,
    operationId: PREVIOUS_V2_RESET_OPERATION,
    enforcementEpoch: epoch,
    tabId: previousV2TabId(index),
    documentId: previousV2DocumentId(index),
    url: previousV2TabUrl(index),
    handledAt: PREVIOUS_V2_READ_AT - 3_600_000 + index * 1_000,
  };
}

/** The clear command the last cleanup batch left for the profile's tab at `index`. */
export function previousV2ClearCommand(
  index: number,
  epoch: string = PREVIOUS_V2_EPOCH,
): FrozenDocumentCommand {
  return {
    version: 1,
    command: 'apply-enforcement',
    operationId: PREVIOUS_V2_CLEANUP_OPERATION,
    enforcementEpoch: epoch,
    sessionId: PREVIOUS_V2_SESSION_ID,
    reservedSessionId: null,
    basePolicyRevision: PREVIOUS_V2_BASE_REVISION,
    runtimeRevision: PREVIOUS_V2_CLEAR_REVISION,
    documentId: previousV2DocumentId(index),
    expectedUrl: previousV2TabUrl(index),
    presentation: 'clear',
    verdict: { blocked: false, reason: 'no-session', categoryId: null, matchedPattern: null },
    overlay: null,
    tabId: previousV2TabId(index),
  };
}

export interface PreviousIdleProfileOptionsV2 {
  /** How many tabs the last cleanup cleared, one acknowledgement and one clear each. */
  count?: number;
  /** The runtime's local date, so a test can keep the profile on the day its clock says. */
  date?: string;
  epoch?: string;
}

/**
 * The owner's storage: an idle runtime, no journal, one acknowledgement with an address and one
 * clear command for every tab the last session's cleanup reached, and the day's aggregate.
 */
export function previousIdleRuntimeProfileV2(
  options: PreviousIdleProfileOptionsV2 = {},
): PreviousRuntimeProfileV2 {
  const count: number = options.count ?? PREVIOUS_V2_TAB_COUNT;
  const date: string = options.date ?? PREVIOUS_V2_LOCAL_DATE;
  const epoch: string = options.epoch ?? PREVIOUS_V2_EPOCH;
  const epochResetAcks: Record<string, PreviousEpochResetAckV2> = {};
  const documentCommands: Record<string, FrozenDocumentCommand> = {};
  for (let index: number = 0; index < count; index += 1) {
    epochResetAcks[previousV2DocumentKey(index)] = previousV2EpochResetAck(index, epoch);
    documentCommands[previousV2DocumentKey(index)] = previousV2ClearCommand(index, epoch);
  }
  return {
    runtimeSchemaVersion: 2,
    session: null,
    gate: null,
    unlocks: [],
    tabStates: {},
    accruedFocusMs: 0,
    attemptDebounce: {},
    deferredBlockClaims: {},
    removedTabTombstones: {},
    scheduleUnavailableNoticeToken: null,
    handledScheduleOccurrences: [],
    enforcementEpoch: epoch,
    epochResetAcks,
    basePolicyRevision: PREVIOUS_V2_BASE_REVISION,
    runtimeRevision: PREVIOUS_V2_CLEAR_REVISION,
    documentCommands,
    enforcementCheckpoint: null,
    pendingEnforcementTransition: null,
    pendingClosure: null,
    date,
    todayAgg: previousV2TodayAgg(date),
    lastPruneDate: date,
    commitCheckpoint: null,
  };
}

/** The blocked page of the active profile, which the real matcher blocks under the social category. */
export const PREVIOUS_V2_BLOCKED_URL: string = 'https://facebook.com/feed';
/** The allowed page of the active profile, which no rule of the session's config names. */
export const PREVIOUS_V2_ALLOWED_URL: string = 'https://example.org/reading';
export const PREVIOUS_V2_BLOCKED_TAB_ID: number = 11;
export const PREVIOUS_V2_BLOCKED_DOCUMENT_ID: string = 'document-1';
export const PREVIOUS_V2_ALLOWED_TAB_ID: number = 12;
export const PREVIOUS_V2_ALLOWED_DOCUMENT_ID: string = 'document-2';

/**
 * The same build mid-session: the published focus runtime the unit fixtures describe, running
 * until stopped so it is still live at whatever clock a boot reads it, with the blocked page
 * frozen under the active overlay and the allowed page frozen under the active presentation with
 * its own verdict, and both acknowledgements carrying their address.
 */
export function previousActiveRuntimeProfileV2(
  overrides: Partial<RuntimeStateV2> = {},
): PreviousRuntimeProfileV2 {
  const base: RuntimeStateV2 = publishedFocusRuntime({
    session: untilStoppedFocusSession(),
    ...overrides,
  });
  const blockedKey: string = `${String(PREVIOUS_V2_BLOCKED_TAB_ID)}:${PREVIOUS_V2_BLOCKED_DOCUMENT_ID}`;
  const allowedKey: string = `${String(PREVIOUS_V2_ALLOWED_TAB_ID)}:${PREVIOUS_V2_ALLOWED_DOCUMENT_ID}`;
  const blocked: FrozenDocumentCommand | undefined = base.documentCommands[blockedKey];
  if (blocked === undefined) throw new Error('the published fixture lost its blocked command');
  const acks: Record<string, PreviousEpochResetAckV2> = {};
  for (const [key, tabId, documentId, url] of [
    [
      blockedKey,
      PREVIOUS_V2_BLOCKED_TAB_ID,
      PREVIOUS_V2_BLOCKED_DOCUMENT_ID,
      PREVIOUS_V2_BLOCKED_URL,
    ],
    [
      allowedKey,
      PREVIOUS_V2_ALLOWED_TAB_ID,
      PREVIOUS_V2_ALLOWED_DOCUMENT_ID,
      PREVIOUS_V2_ALLOWED_URL,
    ],
  ] as ReadonlyArray<[string, number, string, string]>) {
    acks[key] = {
      version: 1,
      operationId: ACTIVE_OPERATION_ID,
      enforcementEpoch: base.enforcementEpoch,
      tabId,
      documentId,
      url,
      handledAt: base.session?.startedAt ?? PREVIOUS_V2_READ_AT,
    };
  }
  return {
    ...base,
    epochResetAcks: acks,
    documentCommands: {
      [blockedKey]: { ...structuredClone(blocked), expectedUrl: PREVIOUS_V2_BLOCKED_URL },
      [allowedKey]: activeCommand({
        tabId: PREVIOUS_V2_ALLOWED_TAB_ID,
        documentId: PREVIOUS_V2_ALLOWED_DOCUMENT_ID,
        expectedUrl: PREVIOUS_V2_ALLOWED_URL,
        operationId: ACTIVE_OPERATION_ID,
        runtimeRevision: PUBLISHED_REVISION,
        verdict: allowedVerdict(),
        overlay: null,
      }),
    },
  };
}
