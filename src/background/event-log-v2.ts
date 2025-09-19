/**
 * The version 2 event log. It keeps the complete legacy history beside the version 2 session
 * events, deduplicates version 2 records by `eventId` so a replayed batch is a no-op, and pushes
 * every append through one queue. Leaf module: it never imports `stores.ts`.
 */

import { EVENT_LOG_CAP } from '../shared/constants';
import { type ExactDataSnapshot, snapshotExactData } from '../shared/exact-data';
import { isSessionEventRecordV2 } from '../shared/runtime-validation';
import { LOCAL_EVENTS } from '../shared/storage-keys';
import type { SessionEventRecordV2 } from '../shared/types';
import { canonicalStorageValue } from './storage-value-equality';

let eventAppendQueueV2: Promise<void> = Promise.resolve();

/**
 * Version 2 events own an `eventId`, so identity is that ID. Legacy records carry no identity, so
 * identity is their content with object keys sorted, which makes two equal records one record.
 */
export function eventIdentityKeyV2(event: SessionEventRecordV2): string {
  if ('version' in event && event.version === 2 && typeof event.eventId === 'string') {
    return `v2:${event.eventId}`;
  }
  return `legacy:${canonicalEventJson(event)}`;
}

/** Validates and detaches a stored log. Invalid, hostile, and missing elements are dropped. */
export function parseStoredEventLogV2(value: unknown): SessionEventRecordV2[] {
  if (!Array.isArray(value)) return [];
  const events: SessionEventRecordV2[] = [];
  for (const candidate of value) {
    const event: SessionEventRecordV2 | null = parseStoredEventV2(candidate);
    if (event !== null) events.push(event);
  }
  return events;
}

/**
 * Appends `incoming` after `log`, keeps the first record of every identity, and caps the result by
 * dropping the oldest records. First write wins, so a later replay never rewrites stored history.
 */
export function mergeEventLogV2(
  log: readonly SessionEventRecordV2[],
  incoming: readonly SessionEventRecordV2[],
): SessionEventRecordV2[] {
  const seen: Set<string> = new Set<string>();
  const merged: SessionEventRecordV2[] = [];
  for (const event of [...log, ...incoming]) {
    const key: string = eventIdentityKeyV2(event);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  return merged.slice(-EVENT_LOG_CAP);
}

/** Queues one read-merge-write cycle. An empty batch touches no storage. */
export function appendEventsV2(events: readonly SessionEventRecordV2[]): Promise<void> {
  if (events.length === 0) return Promise.resolve();
  const requested: Promise<void> = eventAppendQueueV2.then(
    (): Promise<void> => performAppendEventsV2(events),
  );
  eventAppendQueueV2 = requested.catch((): void => {});
  return requested;
}

export async function readEventsV2(): Promise<SessionEventRecordV2[]> {
  const raw: unknown = (await chrome.storage.local.get(LOCAL_EVENTS))[LOCAL_EVENTS];
  return parseStoredEventLogV2(raw);
}

async function performAppendEventsV2(events: readonly SessionEventRecordV2[]): Promise<void> {
  const raw: unknown = (await chrome.storage.local.get(LOCAL_EVENTS))[LOCAL_EVENTS];
  const log: SessionEventRecordV2[] = parseStoredEventLogV2(raw);
  const incoming: SessionEventRecordV2[] = parseStoredEventLogV2(events);
  const next: SessionEventRecordV2[] = mergeEventLogV2(log, incoming);
  await chrome.storage.local.set({ [LOCAL_EVENTS]: next });
}

/**
 * Detaching first is what makes the guard's verdict survive the write: accessors, Proxy traps, and
 * cycles never reach storage, and the identity key never serializes a graph it cannot serialize.
 */
function parseStoredEventV2(value: unknown): SessionEventRecordV2 | null {
  const snapshot: ExactDataSnapshot | null = snapshotExactData(value);
  if (snapshot === null) return null;
  return isSessionEventRecordV2(snapshot.value) ? snapshot.value : null;
}

function canonicalEventJson(value: unknown): string {
  return JSON.stringify(canonicalStorageValue(value));
}
