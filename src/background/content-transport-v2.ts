/**
 * Sends one frozen document command over an injected port and turns the document's answer into an
 * exact worker outcome. The worker owns the tab, so `tabId` is stripped before the send and added
 * back only when wrapping an acknowledgement. Nothing here reads a browser API, a clock, or
 * storage, and nothing retries: a caller owns the reissue policy for every outcome below.
 */

import type {
  ContentEnforcementResponse,
  DocumentContentCommand,
  DocumentEnforcementCommand,
  ResetEnforcementEpochCommand,
} from '../shared/enforcement-v2';
import { parseContentEnforcementResponse } from '../shared/enforcement-v2-validation';
import { exactDataEqual, snapshotExactData } from '../shared/exact-data';
import type {
  DocumentEnforcementAck,
  DocumentEpochResetAck,
  FrozenDocumentCommand,
  FrozenEpochResetCommand,
} from './enforcement-persistence-v2';
import {
  validateDetachedDocumentEnforcementAck,
  validateDetachedDocumentEpochResetAck,
} from './enforcement-persistence-v2-validation';

type AppliedResponse = Extract<ContentEnforcementResponse, { disposition: 'applied' }>;
type StaleCommandResponse = Extract<ContentEnforcementResponse, { disposition: 'stale-command' }>;
type EpochResetResponse = Extract<ContentEnforcementResponse, { disposition: 'epoch-reset' }>;
type EpochResetRejectedResponse = Extract<
  ContentEnforcementResponse,
  { disposition: 'epoch-reset-rejected' }
>;

export interface ContentTransportPortsV2 {
  sendToDocument(
    tabId: number,
    documentId: string,
    message: DocumentContentCommand,
  ): Promise<unknown>;
}

export type DocumentCommandOutcomeV2 =
  | { kind: 'applied'; ack: DocumentEnforcementAck }
  | { kind: 'stale'; response: StaleCommandResponse }
  | { kind: 'reset-required'; currentEpoch: string | null }
  | { kind: 'no-receiver' }
  | { kind: 'mismatch'; detail: string };

export type EpochResetOutcomeV2 =
  | { kind: 'reset'; ack: DocumentEpochResetAck }
  | { kind: 'rejected'; currentEpoch: string }
  | { kind: 'no-receiver' }
  | { kind: 'mismatch'; detail: string };

/** The runtime's answer when a document has no listener at all. */
const NO_RECEIVER_MESSAGES: readonly string[] = [
  'Could not establish connection',
  'Receiving end does not exist',
];
const REJECTED_DETAIL: string = 'the document rejected the command and answered nothing';
const UNPARSABLE_DETAIL: string = 'the answer is not an exact content enforcement response';

/**
 * True only for the runtime's missing-receiver family. Every other rejection, a closed tab
 * included, stays a reported mismatch so the caller can decide what it means for its target.
 */
export function isNoReceiverError(error: unknown): boolean {
  const message: string = errorText(error);
  return NO_RECEIVER_MESSAGES.some((fragment: string): boolean => message.includes(fragment));
}

/**
 * Applies one frozen enforcement command to its document. Only an answer that echoes every field
 * of the command, including the frozen verdict and view, becomes an acknowledgement. A stale or
 * reset answer is reported as itself and never wrapped.
 */
export async function sendDocumentEnforcementCommand(
  ports: ContentTransportPortsV2,
  command: FrozenDocumentCommand,
): Promise<DocumentCommandOutcomeV2> {
  let raw: unknown;
  try {
    raw = await ports.sendToDocument(command.tabId, command.documentId, wireCommand(command));
  } catch (error: unknown) {
    return isNoReceiverError(error)
      ? { kind: 'no-receiver' }
      : { kind: 'mismatch', detail: errorText(error) };
  }
  const response: ContentEnforcementResponse | null = parseContentEnforcementResponse(raw);
  if (response === null) {
    return { kind: 'mismatch', detail: raw === undefined ? REJECTED_DETAIL : UNPARSABLE_DETAIL };
  }
  if (response.disposition === 'applied') return appliedOutcome(command, response);
  if (response.disposition === 'stale-command') return staleOutcome(command, response);
  if (response.disposition === 'reset-required') {
    return response.requestedEpoch === command.enforcementEpoch
      ? { kind: 'reset-required', currentEpoch: response.currentEpoch }
      : fieldMismatch(response.disposition, 'requestedEpoch');
  }
  return unexpectedDisposition(response.disposition, 'apply-enforcement');
}

/**
 * Runs the epoch handshake for one document. Only an exact `epoch-reset` is wrapped. A retired
 * epoch is reported with the epoch the document keeps, so the caller can stop rolling it back.
 */
export async function sendEpochResetCommand(
  ports: ContentTransportPortsV2,
  command: FrozenEpochResetCommand,
): Promise<EpochResetOutcomeV2> {
  let raw: unknown;
  try {
    raw = await ports.sendToDocument(command.tabId, command.documentId, wireResetCommand(command));
  } catch (error: unknown) {
    return isNoReceiverError(error)
      ? { kind: 'no-receiver' }
      : { kind: 'mismatch', detail: errorText(error) };
  }
  const response: ContentEnforcementResponse | null = parseContentEnforcementResponse(raw);
  if (response === null) {
    return { kind: 'mismatch', detail: raw === undefined ? REJECTED_DETAIL : UNPARSABLE_DETAIL };
  }
  if (response.disposition === 'epoch-reset') return epochResetOutcome(command, response);
  if (response.disposition === 'epoch-reset-rejected') {
    return rejectedEpochOutcome(command, response);
  }
  return unexpectedDisposition(response.disposition, 'reset-enforcement-epoch');
}

/** The worker owns the tab target, so the wire command never carries it. */
function wireCommand(command: FrozenDocumentCommand): DocumentEnforcementCommand {
  const { tabId: _tabId, ...wire }: FrozenDocumentCommand = command;
  return wire;
}

function wireResetCommand(command: FrozenEpochResetCommand): ResetEnforcementEpochCommand {
  const { tabId: _tabId, ...wire }: FrozenEpochResetCommand = command;
  return wire;
}

function appliedOutcome(
  command: FrozenDocumentCommand,
  response: AppliedResponse,
): DocumentCommandOutcomeV2 {
  const field: string | null = appliedMismatchField(command, response);
  if (field !== null) return fieldMismatch(response.disposition, field);
  const ack: unknown = snapshotExactData({
    version: 1,
    operationId: command.operationId,
    enforcementEpoch: command.enforcementEpoch,
    sessionId: command.sessionId,
    reservedSessionId: command.reservedSessionId,
    basePolicyRevision: command.basePolicyRevision,
    runtimeRevision: command.runtimeRevision,
    tabId: command.tabId,
    documentId: command.documentId,
    url: command.expectedUrl,
    verdict: command.verdict,
    handledAt: response.handledAt,
  })?.value;
  if (!validateDetachedDocumentEnforcementAck(ack)) {
    return { kind: 'mismatch', detail: ackContractDetail('applied') };
  }
  return { kind: 'applied', ack };
}

/**
 * The first field of the command the response failed to echo, or null when the answer is exact.
 * Verdict and view are compared structurally against the frozen operation-time values.
 */
function appliedMismatchField(
  command: FrozenDocumentCommand,
  response: AppliedResponse,
): string | null {
  if (response.operationId !== command.operationId) return 'operationId';
  if (response.enforcementEpoch !== command.enforcementEpoch) return 'enforcementEpoch';
  if (response.sessionId !== command.sessionId) return 'sessionId';
  if (response.reservedSessionId !== command.reservedSessionId) return 'reservedSessionId';
  if (response.basePolicyRevision !== command.basePolicyRevision) return 'basePolicyRevision';
  if (response.runtimeRevision !== command.runtimeRevision) return 'runtimeRevision';
  if (response.documentId !== command.documentId) return 'documentId';
  if (response.observedUrl !== command.expectedUrl) return 'observedUrl';
  if (response.presentation !== command.presentation) return 'presentation';
  if (!exactDataEqual(response.verdict, command.verdict)) return 'verdict';
  if (!exactDataEqual(response.overlay, command.overlay)) return 'overlay';
  return null;
}

/** A stale answer is drift, never an acknowledgement, but it must still be about what was sent. */
function staleOutcome(
  command: FrozenDocumentCommand,
  response: StaleCommandResponse,
): DocumentCommandOutcomeV2 {
  const sent: StaleCommandResponse['requested'] = {
    enforcementEpoch: command.enforcementEpoch,
    sessionId: command.sessionId,
    reservedSessionId: command.reservedSessionId,
    basePolicyRevision: command.basePolicyRevision,
    runtimeRevision: command.runtimeRevision,
  };
  return exactDataEqual(response.requested, sent)
    ? { kind: 'stale', response }
    : fieldMismatch(response.disposition, 'requested tuple');
}

function epochResetOutcome(
  command: FrozenEpochResetCommand,
  response: EpochResetResponse,
): EpochResetOutcomeV2 {
  const field: string | null = resetMismatchField(command, response);
  if (field !== null) return fieldMismatch(response.disposition, field);
  const ack: unknown = snapshotExactData({
    version: 1,
    operationId: command.operationId,
    enforcementEpoch: command.enforcementEpoch,
    tabId: command.tabId,
    documentId: command.documentId,
    url: command.expectedUrl,
    handledAt: response.handledAt,
  })?.value;
  if (!validateDetachedDocumentEpochResetAck(ack)) {
    return { kind: 'mismatch', detail: ackContractDetail('epoch-reset') };
  }
  return { kind: 'reset', ack };
}

function rejectedEpochOutcome(
  command: FrozenEpochResetCommand,
  response: EpochResetRejectedResponse,
): EpochResetOutcomeV2 {
  const field: string | null = resetMismatchField(command, response);
  if (field !== null) return fieldMismatch(response.disposition, field);
  return { kind: 'rejected', currentEpoch: response.currentEpoch };
}

/** The fields a document can only know from the reset command it was handed. */
function resetMismatchField(
  command: FrozenEpochResetCommand,
  response: EpochResetResponse | EpochResetRejectedResponse,
): string | null {
  if (response.operationId !== command.operationId) return 'operationId';
  if (response.enforcementEpoch !== command.enforcementEpoch) return 'enforcementEpoch';
  if (response.documentId !== command.documentId) return 'documentId';
  if (response.observedUrl !== command.expectedUrl) return 'observedUrl';
  return null;
}

function fieldMismatch(disposition: string, field: string): { kind: 'mismatch'; detail: string } {
  return {
    kind: 'mismatch',
    detail: `${disposition} answer: ${field} does not match the sent command`,
  };
}

function unexpectedDisposition(
  disposition: string,
  command: string,
): { kind: 'mismatch'; detail: string } {
  return {
    kind: 'mismatch',
    detail: `unexpected ${disposition} answer to the ${command} command`,
  };
}

function ackContractDetail(disposition: string): string {
  return `${disposition} answer does not wrap into an exact acknowledgement`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
