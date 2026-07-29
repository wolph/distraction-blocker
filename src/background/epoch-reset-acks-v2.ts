/**
 * The runtime's record of which documents acknowledged the current enforcement epoch.
 *
 * Every writer stores the same projection of the transport's acknowledgement, and every prune asks
 * the same question about a tab, so both live here rather than in each runner that needs them.
 */

import { documentCommandKeyV2 } from './cleanup-progress-v2';
import type { DocumentEpochResetAck, EpochResetAckRecord } from './enforcement-persistence-v2';

/** The record the runtime keeps: the acknowledgement without the page address it echoed. */
export function epochResetAckRecordV2(ack: DocumentEpochResetAck): EpochResetAckRecord {
  return {
    version: 1,
    operationId: ack.operationId,
    enforcementEpoch: ack.enforcementEpoch,
    tabId: ack.tabId,
    documentId: ack.documentId,
    handledAt: ack.handledAt,
  };
}

/** The map with one acknowledgement recorded under its document key. */
export function withEpochResetAckV2(
  acks: Record<string, EpochResetAckRecord>,
  ack: DocumentEpochResetAck,
): Record<string, EpochResetAckRecord> {
  return {
    ...structuredClone(acks),
    [documentCommandKeyV2(ack.tabId, ack.documentId)]: epochResetAckRecordV2(ack),
  };
}

/**
 * The map without the records of tabs the browser does not have. A closed tab's documents are gone,
 * the back-forward cache included, so nothing asks about them again. A document in a tab that is
 * still open keeps its record whatever URL the tab shows now, because the cache can hand that
 * document back and its record is what tells the idle runtime it already holds a clear.
 */
export function epochResetAcksForTabsV2(
  acks: Record<string, EpochResetAckRecord>,
  openTabIds: ReadonlySet<number>,
): Record<string, EpochResetAckRecord> {
  const kept: Record<string, EpochResetAckRecord> = {};
  for (const [key, record] of Object.entries(acks)) {
    if (openTabIds.has(record.tabId)) kept[key] = structuredClone(record);
  }
  return kept;
}

/** The map without one tab's records. */
export function withoutTabEpochResetAcksV2(
  acks: Record<string, EpochResetAckRecord>,
  tabId: number,
): Record<string, EpochResetAckRecord> {
  const kept: Record<string, EpochResetAckRecord> = {};
  for (const [key, record] of Object.entries(acks)) {
    if (record.tabId !== tabId) kept[key] = structuredClone(record);
  }
  return kept;
}
