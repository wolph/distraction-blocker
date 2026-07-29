/**
 * The checkpoint's record of an enforcement acknowledgement. Every checkpoint writer stores the
 * same projection of the transport's answer, so it lives here rather than in each runner.
 */

import type {
  DocumentEnforcementAck,
  DocumentEnforcementAckRecord,
} from './enforcement-persistence-v2';

/** The record a checkpoint keeps: the acknowledgement without the page address it echoed. */
export function documentEnforcementAckRecordV2(
  ack: DocumentEnforcementAck,
): DocumentEnforcementAckRecord {
  return {
    version: 1,
    operationId: ack.operationId,
    enforcementEpoch: ack.enforcementEpoch,
    sessionId: ack.sessionId,
    reservedSessionId: ack.reservedSessionId,
    basePolicyRevision: ack.basePolicyRevision,
    runtimeRevision: ack.runtimeRevision,
    tabId: ack.tabId,
    documentId: ack.documentId,
    verdict: structuredClone(ack.verdict),
    handledAt: ack.handledAt,
  };
}

/** The records of one verified sweep, in the sweep's order. */
export function checkpointDocumentsV2(
  documents: readonly DocumentEnforcementAck[],
): DocumentEnforcementAckRecord[] {
  return documents.map(documentEnforcementAckRecordV2);
}
