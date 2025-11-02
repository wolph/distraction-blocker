/**
 * The one seam between the v2 runtime runners and everything they are not allowed to own. Storage,
 * the clock, UUID allocation, the matcher, browser tabs, content messaging, alarms, settings, the
 * bank, and aggregate reads all arrive through this interface, so a runner is a pure state machine
 * over durable values and a test drives it with an in-memory fake.
 *
 * Two rules the shape encodes. `runtime()` is the current durable value and never a cached copy a
 * caller may mutate, and every write goes through `writeRuntime` or `commit`, which validate at the
 * storage boundary. And `loadAggregates` exists because a closure that crosses a local midnight
 * lands focus on a date the runtime already finished, and `aggregateSets` is an absolute value, so
 * the caller must read those days before it can add to them.
 */

import type { CompiledMatcher } from '../core/matcher';
import type {
  BankState,
  DailyAgg,
  GateSettings,
  PauseEconomy,
  ScheduleOccurrenceRef,
  SessionMode,
  SessionRuleSnapshot,
  SiteUnlock,
  ThemeMode,
  Verdict,
} from '../shared/types';
import type { AlarmPortsV2 } from './alarms-v2';
import type { ContentTransportPortsV2 } from './content-transport-v2';
import type { EnforcementTargetPortsV2 } from './enforcement-targets-v2';
import type { RuntimeCommitInputV2 } from './runtime-checkpoint-v2';
import type { RuntimeStateV2 } from './runtime-v2-types';

export interface RuntimePortsV2 {
  now(): number;
  newId(): string;
  /** The current durable runtime. Callers treat it as read-only and write through the two ports. */
  runtime(): RuntimeStateV2;
  writeRuntime(next: RuntimeStateV2): Promise<void>;
  /** One durable checkpoint: runtime, events, bank, and aggregates, replayed until they agree. */
  commit(input: RuntimeCommitInputV2): Promise<RuntimeStateV2>;
  auditEnforcement(): Promise<'ready' | 'website-access-lost' | 'content-registration-failed'>;
  compileMatcher(rules: SessionRuleSnapshot, mode: SessionMode): CompiledMatcher;
  verdictFor(matcher: CompiledMatcher, url: string, unlocks: readonly SiteUnlock[]): Verdict;
  targets: EnforcementTargetPortsV2;
  transport: ContentTransportPortsV2;
  alarms: AlarmPortsV2;
  theme(): ThemeMode;
  economy(): PauseEconomy;
  gateSettings(): GateSettings;
  bank(): BankState;
  deviceId(): string;
  attemptsToday(): number;
  /** The schedule windows open at `at`, which a closure suppresses so it cannot relock at once. */
  openOccurrencesAt(at: number): ScheduleOccurrenceRef[];
  /** Stored daily aggregates by `syncAggKey`. A key with no stored value is omitted. */
  loadAggregates(keys: readonly string[]): Promise<Record<string, DailyAgg>>;
  reportError(error: unknown): void;
}
