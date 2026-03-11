/**
 * Legacy runtime work migration needs before any v2 code exists: replaying a stored v1 commit
 * checkpoint with v1 semantics, and settling the durable legacy focus phase once.
 *
 * The module is a leaf. It never imports `engine.ts`, never reads Settings, and never reinterprets a
 * legacy checkpoint as a v2 one. Its only v2 surface is the `LegacyMigrationFocusSettlement` record
 * it produces for the migration checkpoint.
 */

import { accrue } from '../core/budget';
import { capAttempts, emptyDaily, isDailyDate } from '../core/stats';
import { TOP_SITES_DAILY } from '../shared/constants';
import { CoreError } from '../shared/errors';
import { safeSum } from '../shared/numeric-validation';
import { syncAggKey } from '../shared/storage-keys';
import type {
  BankState,
  DailyAgg,
  LegacyEventRecord,
  NormalizedSessionStateV1,
  PauseEconomy,
} from '../shared/types';
import { isNonBlankString, isSafeTimestamp } from '../shared/v2-domain-intrinsics';
import { type FocusDateSplitV2, splitFocusByLocalDateV2 } from './closure-projection-v2';
import type { LegacyMigrationFocusSettlement } from './runtime-v2-types';
import type { LegacyRuntimeStateV1, RuntimeCommitCheckpoint } from './stores';

export interface LegacyReplayPortsV1 {
  saveLegacyRuntime(runtime: LegacyRuntimeStateV1): Promise<void>;
  appendLegacyEvents(events: readonly LegacyEventRecord[]): Promise<void>;
  saveBank(bank: BankState, syncBank: boolean): Promise<void>;
  saveAggregate(key: string, value: DailyAgg): Promise<void>;
  removeAggregate(key: string): Promise<void>;
  /** The v1 sync barrier. It is durable before the write that clears the checkpoint. */
  persistSyncJournal(): Promise<void>;
}

/** What one replay left durable, so the caller never has to guess which bank is current. */
export interface LegacyReplayResultV1 {
  runtime: LegacyRuntimeStateV1;
  /** The bank this replay stored, or null when the checkpoint had none to flush. */
  bank: BankState | null;
}

export interface LegacySettlementInputV1 {
  session: NormalizedSessionStateV1;
  bank: BankState;
  pauseEconomy: PauseEconomy;
  accruedFocusMs: number;
  todayAgg: DailyAgg | null;
  runtimeDate: string;
  deviceId: string;
  /** Stored aggregates keyed by `syncAggKey` for every date the settled split can touch. */
  priorAggregates: Record<string, DailyAgg>;
  migratedAt: number;
}

export interface LegacySettlementResultV1 {
  settlement: LegacyMigrationFocusSettlement;
  bankAfter: BankState;
  earnedMs: number;
  aggregateSets: Record<string, DailyAgg>;
  todayAgg: DailyAgg;
  /** The watermark the projected runtime adopts, so a migrated session is never rebanked. */
  accruedFocusMsAfter: number;
}

/** What the settlement owes the bank and the date-split aggregates, computed once. */
interface LegacySettlementBoundsV1 {
  settledThrough: number;
  creditedFocusMs: number;
  bankDeltaMs: number;
}

/**
 * Finishes a durable v1 commit with v1 semantics: the full event list, the bank only when the
 * checkpoint marked it dirty, every aggregate set and removal, the sync journal, and then the
 * runtime with the checkpoint cleared. Replaying twice issues the same calls, so a crash anywhere
 * repeats safely. The journal barrier sits before the clearing write for the same reason the whole
 * order does: after that write no checkpoint is left to replay the sync publication from.
 *
 * The caller passes a runtime `stores.loadRuntime` already parsed, because replay flushes what the
 * checkpoint holds without revalidating it.
 */
export async function replayLegacyRuntimeCheckpointV1(
  ports: LegacyReplayPortsV1,
  runtime: LegacyRuntimeStateV1,
): Promise<LegacyReplayResultV1> {
  const checkpoint: RuntimeCommitCheckpoint | null = runtime.commitCheckpoint;
  if (checkpoint === null) return { runtime, bank: null };
  await ports.appendLegacyEvents(checkpoint.events);
  const bank: BankState | null = checkpoint.syncBank ? checkpoint.bank : null;
  if (bank !== null) await ports.saveBank(bank, checkpoint.syncBank);
  for (const [key, value] of sortedLegacyAggregateSets(checkpoint.aggregateSets)) {
    await ports.saveAggregate(key, capAttempts(value, TOP_SITES_DAILY));
  }
  for (const key of checkpoint.aggregateRemoves ?? []) {
    await ports.removeAggregate(key);
  }
  await ports.persistSyncJournal();
  const cleared: LegacyRuntimeStateV1 = detachedLegacyRuntime({
    ...runtime,
    commitCheckpoint: null,
  });
  await ports.saveLegacyRuntime(cleared);
  return { runtime: cleared, bank };
}

/**
 * Settles the one focus credit migration applies. Only a durable focus phase credits anything, the
 * credit stops at the earliest fixed boundary, and the bank and aggregates receive the focus the v1
 * watermark had not credited yet, so nothing is banked twice.
 *
 * A `migratedAt` behind the current phase start is a backward clock change, not invalid input. It
 * credits zero and settles nothing rather than refusing, because refusing would leave every boot
 * with no runtime at all until the clock caught up.
 */
export function settleLegacySessionV1(input: LegacySettlementInputV1): LegacySettlementResultV1 {
  assertLegacySettlementInput(input);
  const bounds: LegacySettlementBoundsV1 = legacySettlementBoundsV1(
    input.session,
    input.accruedFocusMs,
    input.migratedAt,
  );
  const focusedMsAfter: number = checkedAdd(
    input.session.focusedMs,
    bounds.creditedFocusMs,
    'settled focus',
  );
  const bankAfter: BankState = accrue(input.bank, bounds.bankDeltaMs, input.pauseEconomy);
  const aggregates: LegacyAggregateResultV1 = buildLegacySettlementAggregatesV1(input, bounds);
  return {
    settlement: {
      settledAt: input.migratedAt,
      settledThrough: bounds.settledThrough,
      phaseAtMigration: input.session.phase,
      focusedMsBefore: input.session.focusedMs,
      creditedFocusMs: bounds.creditedFocusMs,
      focusedMsAfter,
    },
    bankAfter,
    earnedMs: Math.max(0, bankAfter.balanceMs - input.bank.balanceMs),
    aggregateSets: aggregates.sets,
    todayAgg: aggregates.todayAgg,
    accruedFocusMsAfter: focusedMsAfter,
  };
}

// Spec erratum pending sign-off: settledThrough is capped at phaseEndsAt and bank credit uses the accruedFocusMs watermark. Reverse here.
function legacySettlementBoundsV1(
  session: NormalizedSessionStateV1,
  accruedFocusMs: number,
  migratedAt: number,
): LegacySettlementBoundsV1 {
  const settledThrough: number = Math.min(migratedAt, session.sessionEndsAt, session.phaseEndsAt);
  const creditedFocusMs: number =
    session.phase === 'focus' ? Math.max(0, settledThrough - session.phaseStartedAt) : 0;
  const focusedMsAfter: number = session.focusedMs + creditedFocusMs;
  return {
    settledThrough,
    creditedFocusMs,
    bankDeltaMs: Math.max(0, focusedMsAfter - accruedFocusMs),
  };
}

interface LegacyAggregateResultV1 {
  sets: Record<string, DailyAgg>;
  todayAgg: DailyAgg;
}

/**
 * The banked delta lands on every local date it covers, ending at the last focus instant. The
 * runtime date is always seeded so the caller has a current aggregate, but only a date the split
 * actually touched becomes a write.
 */
function buildLegacySettlementAggregatesV1(
  input: LegacySettlementInputV1,
  bounds: LegacySettlementBoundsV1,
): LegacyAggregateResultV1 {
  const aggregates: Map<string, DailyAgg> = new Map<string, DailyAgg>();
  const touched: Set<string> = new Set<string>();
  const windowEnd: number = legacySplitWindowEndV1(input.session, bounds.settledThrough);
  // A wall clock behind the phase start is tolerated rather than refused, exactly as spec 1629's
  // `max(0, ...)` and v1's own `focusedMsAt` tolerate it, so the window start is clamped too.
  const splits: FocusDateSplitV2[] = splitFocusByLocalDateV2(
    Math.max(0, windowEnd - bounds.bankDeltaMs),
    windowEnd,
  );
  for (const split of splits) {
    const aggregate: DailyAgg = seedLegacyAggregateV1(aggregates, input, split.date);
    aggregate.focusMs = checkedAdd(aggregate.focusMs, split.ms, 'aggregate focus');
    touched.add(syncAggKey(input.deviceId, split.date));
  }
  const runtimeKey: string = syncAggKey(input.deviceId, input.runtimeDate);
  const runtimeAggregate: DailyAgg = capAttempts(
    seedLegacyAggregateV1(aggregates, input, input.runtimeDate),
    TOP_SITES_DAILY,
  );
  const sets: Record<string, DailyAgg> = {};
  for (const [key, aggregate] of aggregates) {
    if (!touched.has(key)) continue;
    sets[key] = key === runtimeKey ? runtimeAggregate : capAttempts(aggregate, TOP_SITES_DAILY);
  }
  return { sets, todayAgg: structuredClone(runtimeAggregate) };
}

/**
 * Focus credit ends at the last focus instant, which is the settled bound during focus and the
 * instant the phase began otherwise. This matches `settlementEndV2` in `closure-projection-v2.ts`,
 * so the two modules agree about when unsettled focus happened. The banked amount is unaffected.
 */
function legacySplitWindowEndV1(session: NormalizedSessionStateV1, settledThrough: number): number {
  return session.phase === 'focus' ? settledThrough : session.phaseStartedAt;
}

/** One seeded aggregate per touched date, built once and then added to in place. */
function seedLegacyAggregateV1(
  aggregates: Map<string, DailyAgg>,
  input: LegacySettlementInputV1,
  date: string,
): DailyAgg {
  const key: string = syncAggKey(input.deviceId, date);
  const known: DailyAgg | undefined = aggregates.get(key);
  if (known !== undefined) return known;
  const seeded: DailyAgg = legacyAggregateSeedV1(input, key, date);
  aggregates.set(key, seeded);
  return seeded;
}

/**
 * The live runtime aggregate seeds its own date, a stored aggregate seeds any other date, and only a
 * date with nothing stored yet starts empty. A date earlier than the runtime date is already
 * finished and written, so the caller must supply it: seeding it empty would replace that day's
 * attempts, sessions, and earlier focus with this settlement's split alone.
 */
function legacyAggregateSeedV1(
  input: LegacySettlementInputV1,
  key: string,
  date: string,
): DailyAgg {
  if (date === input.runtimeDate && input.todayAgg !== null) {
    return structuredClone(input.todayAgg);
  }
  const prior: DailyAgg | undefined = input.priorAggregates[key];
  if (prior !== undefined) {
    if (prior.date !== date) invalidLegacy(`the stored aggregate ${key} belongs to another date`);
    return structuredClone(prior);
  }
  if (date < input.runtimeDate) {
    invalidLegacy(`settling focus on ${date} needs the stored aggregate ${key}`);
  }
  return emptyDaily(date);
}

/** Deterministic flush order, so two replays of one checkpoint write the same sequence. */
function sortedLegacyAggregateSets(
  aggregateSets: Record<string, DailyAgg> | undefined,
): Array<[string, DailyAgg]> {
  return Object.entries(aggregateSets ?? {}).sort(
    ([left]: [string, DailyAgg], [right]: [string, DailyAgg]): number =>
      left === right ? 0 : left < right ? -1 : 1,
  );
}

function detachedLegacyRuntime(runtime: LegacyRuntimeStateV1): LegacyRuntimeStateV1 {
  try {
    return structuredClone(runtime);
  } catch {
    return invalidLegacy('a legacy runtime must hold cloneable exact data');
  }
}

/**
 * The produced settlement is audited by the migration checkpoint parser, which accepts only
 * non-negative safe integers, so every value it is built from is checked here.
 */
function assertLegacySettlementInput(input: LegacySettlementInputV1): void {
  assertSafeTimestamp(input.migratedAt, 'migration time');
  assertSafeTimestamp(input.session.phaseStartedAt, 'legacy phase start');
  assertSafeTimestamp(input.session.phaseEndsAt, 'legacy phase end');
  assertSafeTimestamp(input.session.sessionEndsAt, 'legacy session end');
  assertSafeTimestamp(input.session.focusedMs, 'legacy settled focus');
  if (!Number.isFinite(input.accruedFocusMs) || input.accruedFocusMs < 0) {
    invalidLegacy('the accrued focus watermark must be a non-negative finite number');
  }
  if (!isNonBlankString(input.deviceId)) {
    invalidLegacy('a legacy settlement aggregate needs a device ID');
  }
  if (!isDailyDate(input.runtimeDate)) {
    invalidLegacy('the runtime date must be a local YYYY-MM-DD date');
  }
  if (!Number.isFinite(input.bank.balanceMs) || input.bank.balanceMs < 0) {
    invalidLegacy('the legacy bank balance must be a non-negative finite number');
  }
  if (input.todayAgg !== null && input.todayAgg.date !== input.runtimeDate) {
    invalidLegacy('the runtime aggregate must belong to the runtime date');
  }
}

function checkedAdd(left: number, right: number, label: string): number {
  const total: number | null = safeSum(left, right);
  if (total === null) invalidLegacy(`${label} must stay a non-negative safe integer`);
  return total;
}

function assertSafeTimestamp(value: number, label: string): void {
  if (!isSafeTimestamp(value)) invalidLegacy(`${label} must be a non-negative safe integer`);
}

function invalidLegacy(message: string): never {
  throw new CoreError('invalid-rule', message);
}
