import { describe, expect, it } from 'vitest';
import { validateDetachedClosureProjection } from '../../../src/background/cleanup-closure-v2-validation';
import {
  buildClosureProjectionV2,
  type ClosureOutcomeV2,
  type ClosureProjectionInputV2,
  type ClosureProjectionResultV2,
  closureHandledOccurrenceAdditionsV2,
  closureOutcomeForReasonV2,
  type FocusDateSplitV2,
  manualEndReasonV2,
  splitFocusByLocalDateV2,
} from '../../../src/background/closure-projection-v2';
import { accrue } from '../../../src/core/budget';
import { mergeHandledScheduleOccurrencesV2 } from '../../../src/core/schedule-v2';
import { emptyDaily } from '../../../src/core/stats';
import {
  HANDLED_SCHEDULE_OCCURRENCE_RETENTION_MS,
  MAX_HANDLED_SCHEDULE_OCCURRENCES,
} from '../../../src/shared/constants';
import { syncAggKey } from '../../../src/shared/storage-keys';
import type {
  BankState,
  DailyAgg,
  HandledScheduleOccurrence,
  PauseEconomy,
  ScheduleOccurrenceRef,
  SessionConfigV2,
  SessionEndedEventV2,
  SessionEndReasonV2,
  SessionStateV2,
} from '../../../src/shared/types';
import { isTimezoneChild, runSuiteInTimezone } from '../timezone-child';
import {
  canonicalRules,
  dailyAgg,
  handledOccurrence,
  LOCAL_DATE,
  SESSION_ID,
  scheduleOccurrence,
} from './runtime-v2-fixtures';

const AMSTERDAM_CHILD_FLAG: string = 'FOCUS_LOCK_V2_CLOSURE_AMSTERDAM_CHILD';
const isAmsterdamChild: boolean = isTimezoneChild(AMSTERDAM_CHILD_FLAG);

const DEVICE_ID: string = 'device-1';
const NEXT_DATE: string = '2026-09-03';
const START_AT: number = new Date(2026, 8, 2, 9, 0, 0, 0).getTime();
const EVENING_START_AT: number = new Date(2026, 8, 2, 23, 30, 0, 0).getTime();
const LOCAL_MIDNIGHT: number = new Date(2026, 8, 3, 0, 0, 0, 0).getTime();
const CROSSING_END_AT: number = new Date(2026, 8, 3, 0, 20, 0, 0).getTime();
const THIRTY_MINUTES_MS: number = 1_800_000;
const TWENTY_FIVE_MINUTES_MS: number = 1_500_000;
const ENDED_AT: number = START_AT + THIRTY_MINUTES_MS;
const PAUSE_ECONOMY: PauseEconomy = {
  earnRatio: 5 / 30,
  capMs: 3_600_000,
  pauseMs: 60_000,
  unlockMs: 120_000,
};
const ENFORCEMENT_REASONS: readonly SessionEndReasonV2[] = [
  'website-access-lost',
  'content-registration-failed',
  'alarm-failed',
  'tab-enforcement-failed',
  'invalid-active-state',
];
const CANCELED_REASONS: readonly SessionEndReasonV2[] = ['manual-canceled', ...ENFORCEMENT_REASONS];
const CAPTURE_REASONS: readonly SessionEndReasonV2[] = ['manual-completed', ...CANCELED_REASONS];

function sessionConfig(overrides: Partial<SessionConfigV2> = {}): SessionConfigV2 {
  return {
    mode: 'blacklist',
    strictness: 'flexible',
    duration: { kind: 'until-stopped' },
    cycling: null,
    intention: 'Finish the release notes',
    source: 'manual',
    scheduleOccurrence: null,
    rules: canonicalRules(),
    ...overrides,
  };
}

function timedConfig(overrides: Partial<SessionConfigV2> = {}): SessionConfigV2 {
  return sessionConfig({
    strictness: 'friction',
    duration: { kind: 'timed', minutes: 25 },
    ...overrides,
  });
}

function scheduledTimedConfig(overrides: Partial<SessionConfigV2> = {}): SessionConfigV2 {
  return timedConfig({
    source: 'schedule',
    scheduleOccurrence: scheduleOccurrence(),
    ...overrides,
  });
}

function sessionState(overrides: Partial<SessionStateV2> = {}): SessionStateV2 {
  return {
    version: 2,
    sessionId: SESSION_ID,
    config: sessionConfig(),
    startedAt: START_AT,
    sessionEndsAt: null,
    phase: 'focus',
    phaseStartedAt: START_AT,
    phaseEndsAt: null,
    cycleIndex: 0,
    pausedFrom: null,
    focusedMs: 0,
    ...overrides,
  };
}

function timedSessionState(overrides: Partial<SessionStateV2> = {}): SessionStateV2 {
  return sessionState({
    config: timedConfig(),
    sessionEndsAt: START_AT + TWENTY_FIVE_MINUTES_MS,
    phaseEndsAt: START_AT + TWENTY_FIVE_MINUTES_MS,
    ...overrides,
  });
}

function projectionInput(
  overrides: Partial<ClosureProjectionInputV2> = {},
): ClosureProjectionInputV2 {
  return {
    session: sessionState(),
    endedAt: ENDED_AT,
    reason: 'manual-completed',
    bank: { balanceMs: 0 },
    pauseEconomy: PAUSE_ECONOMY,
    accruedFocusMs: 0,
    todayAgg: null,
    priorAggregates: {},
    runtimeDate: LOCAL_DATE,
    deviceId: DEVICE_ID,
    currentHandledOccurrences: [],
    openOccurrences: [],
    ...overrides,
  };
}

function otherOccurrence(): ScheduleOccurrenceRef {
  return scheduleOccurrence({ token: `evening@${LOCAL_DATE}`, entryId: 'evening' });
}

function liveHandled(): HandledScheduleOccurrence {
  return handledOccurrence({
    handledAt: START_AT,
    expiresAt: START_AT + HANDLED_SCHEDULE_OCCURRENCE_RETENTION_MS,
  });
}

function capturedRecord(occurrence: ScheduleOccurrenceRef): HandledScheduleOccurrence {
  return {
    ...occurrence,
    handledAt: ENDED_AT,
    reason: 'closure-overlap',
    expiresAt: ENDED_AT + HANDLED_SCHEDULE_OCCURRENCE_RETENTION_MS,
  };
}

function entryIdOf(record: HandledScheduleOccurrence): string {
  return record.entryId;
}

function handledSeries(count: number, firstHandledAt: number): HandledScheduleOccurrence[] {
  return Array.from(
    { length: count },
    (_value: unknown, index: number): HandledScheduleOccurrence => {
      const entryId: string = `entry-${String(index).padStart(3, '0')}`;
      return handledOccurrence({
        token: `${entryId}@${LOCAL_DATE}`,
        entryId,
        handledAt: firstHandledAt + index,
        expiresAt: firstHandledAt + index + HANDLED_SCHEDULE_OCCURRENCE_RETENTION_MS,
      });
    },
  );
}

/** A closure whose focus crosses local midnight after the runtime already rolled its own date. */
function crossingInput(
  overrides: Partial<ClosureProjectionInputV2> = {},
): ClosureProjectionInputV2 {
  return projectionInput({
    session: sessionState({ startedAt: EVENING_START_AT, phaseStartedAt: EVENING_START_AT }),
    endedAt: CROSSING_END_AT,
    runtimeDate: NEXT_DATE,
    ...overrides,
  });
}

function earnedMsFor(bank: BankState, focusDeltaMs: number): number {
  return accrue(bank, focusDeltaMs, PAUSE_ECONOMY).balanceMs - bank.balanceMs;
}

describe('v2 closure reason and outcome mapping', (): void => {
  it.each<SessionEndReasonV2>(['timer-completed', 'manual-completed'])(
    'maps %s to a completed outcome that increments the completion counter',
    (reason: SessionEndReasonV2): void => {
      const mapped: ClosureOutcomeV2 = closureOutcomeForReasonV2(reason);

      expect(mapped).toEqual({ outcome: 'completed', completionIncrement: 1 });
    },
  );

  it.each<SessionEndReasonV2>([...CANCELED_REASONS])(
    'maps %s to a canceled outcome that leaves the completion counter unchanged',
    (reason: SessionEndReasonV2): void => {
      const mapped: ClosureOutcomeV2 = closureOutcomeForReasonV2(reason);

      expect(mapped).toEqual({ outcome: 'canceled', completionIncrement: 0 });
    },
  );

  it('maps a manual end to completed only for an indefinite session', (): void => {
    expect(manualEndReasonV2({ kind: 'until-stopped' })).toBe('manual-completed');
    expect(manualEndReasonV2({ kind: 'timed', minutes: 25 })).toBe('manual-canceled');
  });
});

describe('v2 closure handled occurrence capture', (): void => {
  it('adds nothing on natural timed completion of a scheduled window session', (): void => {
    const additions: HandledScheduleOccurrence[] = closureHandledOccurrenceAdditionsV2(
      scheduledTimedConfig(),
      'timer-completed',
      [scheduleOccurrence(), otherOccurrence()],
      ENDED_AT,
    );

    expect(additions).toEqual([]);
  });

  it.each<SessionEndReasonV2>([...CAPTURE_REASONS])(
    'captures every open occurrence of an indefinite session on %s',
    (reason: SessionEndReasonV2): void => {
      const additions: HandledScheduleOccurrence[] = closureHandledOccurrenceAdditionsV2(
        sessionConfig(),
        reason,
        [scheduleOccurrence(), otherOccurrence()],
        ENDED_AT,
      );

      expect(additions).toEqual([
        capturedRecord(scheduleOccurrence()),
        capturedRecord(otherOccurrence()),
      ]);
    },
  );

  it.each<SessionEndReasonV2>([...CANCELED_REASONS])(
    'captures every open occurrence of a scheduled timed session on %s',
    (reason: SessionEndReasonV2): void => {
      const additions: HandledScheduleOccurrence[] = closureHandledOccurrenceAdditionsV2(
        scheduledTimedConfig(),
        reason,
        [otherOccurrence()],
        ENDED_AT,
      );

      expect(additions).toEqual([capturedRecord(otherOccurrence())]);
    },
  );

  it.each<SessionEndReasonV2>(['timer-completed', ...CAPTURE_REASONS])(
    'adds nothing for a manual timed session on %s',
    (reason: SessionEndReasonV2): void => {
      const additions: HandledScheduleOccurrence[] = closureHandledOccurrenceAdditionsV2(
        timedConfig(),
        reason,
        [scheduleOccurrence(), otherOccurrence()],
        ENDED_AT,
      );

      expect(additions).toEqual([]);
    },
  );

  it('merges captures with the live current records and holds the 256 record cap', (): void => {
    const current: HandledScheduleOccurrence[] = [
      ...handledSeries(MAX_HANDLED_SCHEDULE_OCCURRENCES, ENDED_AT - 400_000),
      handledOccurrence({ token: `stale@${LOCAL_DATE}`, entryId: 'stale', expiresAt: ENDED_AT }),
    ];
    const result: ClosureProjectionResultV2 = buildClosureProjectionV2(
      projectionInput({ currentHandledOccurrences: current, openOccurrences: [otherOccurrence()] }),
    );
    const expected: HandledScheduleOccurrence[] = mergeHandledScheduleOccurrencesV2(
      current,
      [capturedRecord(otherOccurrence())],
      ENDED_AT,
    );

    expect(result.projection.handledOccurrences).toEqual(expected);
    expect(result.projection.handledOccurrences).toHaveLength(MAX_HANDLED_SCHEDULE_OCCURRENCES);
    expect(result.projection.handledOccurrences.map(entryIdOf)).not.toContain('stale');
    expect(result.projection.handledOccurrences.map(entryIdOf)).toContain('evening');
  });
});

describe('v2 closure focus settlement', (): void => {
  it('settles indefinite focus through the immutable end', (): void => {
    const result: ClosureProjectionResultV2 = buildClosureProjectionV2(projectionInput());

    expect(result.projection.focusedMs).toBe(THIRTY_MINUTES_MS);
    expect(result.projection.endEvent.focusedMs).toBe(THIRTY_MINUTES_MS);
    expect(result.accruedFocusMs).toBe(THIRTY_MINUTES_MS);
  });

  it('never credits focus past the fixed end of a timed session', (): void => {
    const beyond: ClosureProjectionResultV2 = buildClosureProjectionV2(
      projectionInput({
        session: timedSessionState(),
        endedAt: START_AT + TWENTY_FIVE_MINUTES_MS + 600_000,
        reason: 'timer-completed',
      }),
    );
    const atFixedEnd: ClosureProjectionResultV2 = buildClosureProjectionV2(
      projectionInput({
        session: timedSessionState(),
        endedAt: START_AT + TWENTY_FIVE_MINUTES_MS,
        reason: 'timer-completed',
      }),
    );

    expect(beyond.projection.focusedMs).toBe(TWENTY_FIVE_MINUTES_MS);
    expect(atFixedEnd.projection.focusedMs).toBe(TWENTY_FIVE_MINUTES_MS);
    expect(beyond.projection.endedAt).toBe(START_AT + TWENTY_FIVE_MINUTES_MS + 600_000);
  });

  it.each<'paused' | 'break'>(['paused', 'break'])(
    'credits no additional focus while %s',
    (phase: 'paused' | 'break'): void => {
      const result: ClosureProjectionResultV2 = buildClosureProjectionV2(
        projectionInput({
          session: timedSessionState({
            phase,
            phaseStartedAt: START_AT + 600_000,
            phaseEndsAt: START_AT + 900_000,
            focusedMs: 600_000,
            pausedFrom: phase === 'paused' ? { phase: 'focus', phaseEndsAt: null } : null,
          }),
          endedAt: START_AT + 800_000,
          reason: 'manual-canceled',
          accruedFocusMs: 600_000,
        }),
      );

      expect(result.projection.focusedMs).toBe(600_000);
      expect(result.projection.events).toEqual([result.projection.endEvent]);
    },
  );

  it('accrues the unsettled focus delta and records one legacy budget event', (): void => {
    const bank: BankState = { balanceMs: 60_000 };
    const result: ClosureProjectionResultV2 = buildClosureProjectionV2(
      projectionInput({ bank, accruedFocusMs: 600_000 }),
    );

    expect(result.projection.bankAfter).toEqual(
      accrue(bank, THIRTY_MINUTES_MS - 600_000, PAUSE_ECONOMY),
    );
    expect(result.projection.events).toEqual([
      {
        t: 'budgetEarned',
        at: ENDED_AT,
        ms: earnedMsFor(bank, THIRTY_MINUTES_MS - 600_000),
        sessionId: SESSION_ID,
      },
      result.projection.endEvent,
    ]);
  });

  it('appends no settlement event when the closure earns nothing', (): void => {
    const result: ClosureProjectionResultV2 = buildClosureProjectionV2(
      projectionInput({ accruedFocusMs: THIRTY_MINUTES_MS + 1_000 }),
    );

    expect(result.projection.bankAfter).toEqual(accrue({ balanceMs: 0 }, 0, PAUSE_ECONOMY));
    expect(result.projection.events).toEqual([result.projection.endEvent]);
  });

  it('closes the event list with the immutable end event exactly once', (): void => {
    const result: ClosureProjectionResultV2 = buildClosureProjectionV2(projectionInput());
    const endEvent: SessionEndedEventV2 = result.projection.endEvent;

    expect(result.projection.closureId).toBe(`${SESSION_ID}:close`);
    expect(endEvent.eventId).toBe(`${SESSION_ID}:end`);
    expect(endEvent.at).toBe(ENDED_AT);
    expect(result.projection.events.at(-1)).toEqual(endEvent);
    expect(
      result.projection.events.filter((event: unknown): boolean => event === endEvent),
    ).toHaveLength(1);
  });
});

describe('v2 closure aggregate projection', (): void => {
  it('splits the settled focus across every local date it covers', (): void => {
    const result: ClosureProjectionResultV2 = buildClosureProjectionV2(
      projectionInput({
        session: sessionState({ startedAt: EVENING_START_AT, phaseStartedAt: EVENING_START_AT }),
        endedAt: CROSSING_END_AT,
        todayAgg: dailyAgg(),
      }),
    );

    expect(result.projection.aggregateSets).toEqual({
      [syncAggKey(DEVICE_ID, LOCAL_DATE)]: {
        ...dailyAgg(),
        focusMs: dailyAgg().focusMs + (LOCAL_MIDNIGHT - EVENING_START_AT),
      },
      [syncAggKey(DEVICE_ID, NEXT_DATE)]: {
        ...emptyDaily(NEXT_DATE),
        focusMs: CROSSING_END_AT - LOCAL_MIDNIGHT,
        sessionsCompleted: 1,
      },
    });
    expect(result.projection.aggregateRemoves).toEqual([]);
    expect(result.todayAgg).toEqual(
      result.projection.aggregateSets[syncAggKey(DEVICE_ID, NEXT_DATE)],
    );
  });

  it('seeds an empty aggregate when the runtime carries none', (): void => {
    const result: ClosureProjectionResultV2 = buildClosureProjectionV2(projectionInput());

    expect(result.projection.aggregateSets).toEqual({
      [syncAggKey(DEVICE_ID, LOCAL_DATE)]: {
        ...emptyDaily(LOCAL_DATE),
        focusMs: THIRTY_MINUTES_MS,
        sessionsCompleted: 1,
      },
    });
  });

  it('adds the split focus to the stored aggregate of an earlier local date', (): void => {
    const priorKey: string = syncAggKey(DEVICE_ID, LOCAL_DATE);
    const prior: DailyAgg = dailyAgg();
    const result: ClosureProjectionResultV2 = buildClosureProjectionV2(
      crossingInput({ priorAggregates: { [priorKey]: prior } }),
    );

    // The runtime rolled its date at the local midnight this closure crosses, so the earlier day is
    // already stored and must keep every counter it finished with.
    expect(result.projection.aggregateSets[priorKey]).toEqual({
      ...dailyAgg(),
      focusMs: dailyAgg().focusMs + (LOCAL_MIDNIGHT - EVENING_START_AT),
    });
    expect(result.projection.aggregateSets[syncAggKey(DEVICE_ID, NEXT_DATE)]).toEqual({
      ...emptyDaily(NEXT_DATE),
      focusMs: CROSSING_END_AT - LOCAL_MIDNIGHT,
      sessionsCompleted: 1,
    });

    prior.focusMs = 999;
    expect(result.projection.aggregateSets[priorKey]?.focusMs).toBe(
      dailyAgg().focusMs + (LOCAL_MIDNIGHT - EVENING_START_AT),
    );
  });

  it('refuses to settle focus on an earlier local date with no stored aggregate', (): void => {
    expect((): unknown => buildClosureProjectionV2(crossingInput())).toThrowError(
      expect.objectContaining({ code: 'invalid-rule' }),
    );
  });

  it('refuses a stored aggregate filed under another date', (): void => {
    const priorKey: string = syncAggKey(DEVICE_ID, LOCAL_DATE);

    expect((): unknown =>
      buildClosureProjectionV2(
        crossingInput({ priorAggregates: { [priorKey]: dailyAgg({ date: NEXT_DATE }) } }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-rule' }));
  });

  it('leaves the completion counter unchanged on a canceled closure', (): void => {
    const result: ClosureProjectionResultV2 = buildClosureProjectionV2(
      projectionInput({
        session: timedSessionState(),
        reason: 'manual-canceled',
        todayAgg: dailyAgg(),
      }),
    );

    expect(result.projection.completionIncrement).toBe(0);
    expect(result.todayAgg).toEqual({
      ...dailyAgg(),
      focusMs: dailyAgg().focusMs + TWENTY_FIVE_MINUTES_MS,
    });
  });

  it('attributes unsettled focus to the interval ending at the last focus instant', (): void => {
    const result: ClosureProjectionResultV2 = buildClosureProjectionV2(
      projectionInput({
        session: timedSessionState({
          phase: 'break',
          phaseStartedAt: START_AT + 600_000,
          phaseEndsAt: START_AT + 900_000,
          focusedMs: 600_000,
        }),
        endedAt: START_AT + 800_000,
        reason: 'manual-canceled',
      }),
    );

    expect(result.projection.focusedMs).toBe(600_000);
    expect(result.projection.aggregateSets[syncAggKey(DEVICE_ID, LOCAL_DATE)]?.focusMs).toBe(
      600_000,
    );
  });
});

describe('v2 closure local date splitting', (): void => {
  it('returns one entry for an interval inside a single local day', (): void => {
    expect(splitFocusByLocalDateV2(START_AT, ENDED_AT)).toEqual([
      { date: LOCAL_DATE, ms: THIRTY_MINUTES_MS },
    ]);
  });

  it('returns one entry per local day at a midnight crossing', (): void => {
    const splits: FocusDateSplitV2[] = splitFocusByLocalDateV2(EVENING_START_AT, CROSSING_END_AT);
    const total: number = splits.reduce(
      (sum: number, split: FocusDateSplitV2): number => sum + split.ms,
      0,
    );

    expect(splits).toEqual([
      { date: LOCAL_DATE, ms: LOCAL_MIDNIGHT - EVENING_START_AT },
      { date: NEXT_DATE, ms: CROSSING_END_AT - LOCAL_MIDNIGHT },
    ]);
    expect(total).toBe(CROSSING_END_AT - EVENING_START_AT);
  });

  it.each([
    [ENDED_AT, ENDED_AT],
    [ENDED_AT, START_AT],
  ])(
    'returns no entries for the non-positive interval %s to %s',
    (fromAt: number, toAt: number): void => {
      expect(splitFocusByLocalDateV2(fromAt, toAt)).toEqual([]);
    },
  );

  it('rejects a boundary without a four-digit local year', (): void => {
    expect((): unknown =>
      splitFocusByLocalDateV2(
        new Date(10_000, 0, 1, 12, 0, 0, 0).getTime(),
        new Date(10_000, 0, 1, 13, 0, 0, 0).getTime(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-rule' }));
  });
});

describe('v2 closure projection contract', (): void => {
  it('repeats the session config on the end event and satisfies the stored contract', (): void => {
    const result: ClosureProjectionResultV2 = buildClosureProjectionV2(
      projectionInput({
        session: timedSessionState({ config: scheduledTimedConfig() }),
        reason: 'manual-canceled',
        openOccurrences: [scheduleOccurrence()],
      }),
    );

    expect(validateDetachedClosureProjection(result.projection)).toBe(true);
    expect(result.projection.sessionId).toBe(SESSION_ID);
    expect(result.projection.reason).toBe('manual-canceled');
    expect(result.projection.outcome).toBe('canceled');
    expect(result.projection.focusedMs).toBe(TWENTY_FIVE_MINUTES_MS);
    expect(result.projection.endEvent.duration).toEqual({ kind: 'timed', minutes: 25 });
    expect(result.projection.endEvent.source).toBe('schedule');
    expect(result.projection.endEvent.scheduleOccurrence).toEqual(scheduleOccurrence());
    expect(result.projection.handledOccurrences).toEqual([capturedRecord(scheduleOccurrence())]);
  });

  it('accepts the migration invalid-active close with a null occurrence', (): void => {
    const result: ClosureProjectionResultV2 = buildClosureProjectionV2(
      projectionInput({
        session: timedSessionState({
          config: timedConfig({ source: 'schedule', scheduleOccurrence: null }),
        }),
        reason: 'invalid-active-state',
      }),
    );

    expect(validateDetachedClosureProjection(result.projection)).toBe(true);
    expect(result.projection.endEvent.scheduleOccurrence).toBeNull();
    expect(result.projection.handledOccurrences).toEqual([]);
  });

  it('rebuilds structurally equal output from the same input', (): void => {
    const input: ClosureProjectionInputV2 = projectionInput({
      session: timedSessionState({ config: scheduledTimedConfig() }),
      reason: 'manual-canceled',
      todayAgg: dailyAgg(),
      currentHandledOccurrences: [liveHandled()],
      openOccurrences: [otherOccurrence()],
    });

    expect(buildClosureProjectionV2(input)).toEqual(buildClosureProjectionV2(input));
  });

  it('detaches the projection from later mutation of its inputs', (): void => {
    const session: SessionStateV2 = timedSessionState({ config: scheduledTimedConfig() });
    const todayAggregate: DailyAgg = dailyAgg();
    const current: HandledScheduleOccurrence[] = [liveHandled()];
    const open: ScheduleOccurrenceRef[] = [otherOccurrence()];
    const result: ClosureProjectionResultV2 = buildClosureProjectionV2(
      projectionInput({
        session,
        reason: 'manual-canceled',
        todayAgg: todayAggregate,
        currentHandledOccurrences: current,
        openOccurrences: open,
      }),
    );

    session.config.scheduleOccurrence = scheduleOccurrence({ token: 'mutated-input' });
    todayAggregate.focusMs = 999;
    const firstCurrent: HandledScheduleOccurrence | undefined = current[0];
    if (firstCurrent !== undefined) firstCurrent.entryId = 'mutated-input';
    const firstOpen: ScheduleOccurrenceRef | undefined = open[0];
    if (firstOpen !== undefined) firstOpen.entryId = 'mutated-input';

    expect(result.projection.endEvent.scheduleOccurrence).toEqual(scheduleOccurrence());
    expect(result.projection.aggregateSets[syncAggKey(DEVICE_ID, LOCAL_DATE)]).toEqual({
      ...dailyAgg(),
      focusMs: dailyAgg().focusMs + TWENTY_FIVE_MINUTES_MS,
    });
    expect(result.projection.handledOccurrences.map(entryIdOf)).toEqual(['weekday', 'evening']);
  });

  it('detaches every input from later mutation of the projection', (): void => {
    const session: SessionStateV2 = timedSessionState({ config: scheduledTimedConfig() });
    const todayAggregate: DailyAgg = dailyAgg();
    const current: HandledScheduleOccurrence[] = [liveHandled()];
    const open: ScheduleOccurrenceRef[] = [otherOccurrence()];
    const result: ClosureProjectionResultV2 = buildClosureProjectionV2(
      projectionInput({
        session,
        reason: 'manual-canceled',
        todayAgg: todayAggregate,
        currentHandledOccurrences: current,
        openOccurrences: open,
      }),
    );
    const aggregateKey: string = syncAggKey(DEVICE_ID, LOCAL_DATE);

    const endOccurrence: ScheduleOccurrenceRef | null =
      result.projection.endEvent.scheduleOccurrence;
    if (endOccurrence !== null) endOccurrence.entryId = 'mutated-output';
    const firstHandled: HandledScheduleOccurrence | undefined =
      result.projection.handledOccurrences[0];
    if (firstHandled !== undefined) firstHandled.entryId = 'mutated-output';
    result.todayAgg.focusMs = 1;

    expect(result.projection.aggregateSets[aggregateKey]?.focusMs).toBe(
      dailyAgg().focusMs + TWENTY_FIVE_MINUTES_MS,
    );
    expect(session.config.scheduleOccurrence).toEqual(scheduleOccurrence());
    expect(todayAggregate).toEqual(dailyAgg());
    expect(current).toEqual([liveHandled()]);
    expect(open).toEqual([otherOccurrence()]);
  });
});

describe('v2 closure hostile input', (): void => {
  it('rejects a closure end earlier than the current phase start', (): void => {
    expect((): unknown =>
      buildClosureProjectionV2(projectionInput({ endedAt: START_AT - 1_000 })),
    ).toThrowError(expect.objectContaining({ code: 'invalid-rule' }));
  });

  it('rejects settled focus that leaves the safe integer range', (): void => {
    expect((): unknown =>
      buildClosureProjectionV2(
        projectionInput({
          session: sessionState({ focusedMs: Number.MAX_SAFE_INTEGER - 1_000 }),
          endedAt: START_AT + 5_000,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-rule' }));
  });

  it('rejects a blank device ID', (): void => {
    expect((): unknown =>
      buildClosureProjectionV2(projectionInput({ deviceId: '   ' })),
    ).toThrowError(expect.objectContaining({ code: 'invalid-rule' }));
  });
});

describe.runIf(!isAmsterdamChild)('v2 closure timezone isolation', (): void => {
  it('passes the exact DST split case in a Europe/Amsterdam child process', (): void => {
    expect((): string =>
      runSuiteInTimezone('Europe/Amsterdam', AMSTERDAM_CHILD_FLAG, import.meta.url),
    ).not.toThrow();
  });
});

describe.runIf(isAmsterdamChild)('Europe/Amsterdam v2 closure focus splitting', (): void => {
  it('splits the spring-forward local day by platform Date arithmetic', (): void => {
    const fromAt: number = new Date(2026, 2, 28, 23, 0, 0, 0).getTime();
    const toAt: number = new Date(2026, 2, 29, 4, 0, 0, 0).getTime();

    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Europe/Amsterdam');
    expect(new Date(fromAt).toISOString()).toBe('2026-03-28T22:00:00.000Z');
    expect(new Date(toAt).toISOString()).toBe('2026-03-29T02:00:00.000Z');
    expect(splitFocusByLocalDateV2(fromAt, toAt)).toEqual([
      { date: '2026-03-28', ms: 3_600_000 },
      { date: '2026-03-29', ms: 10_800_000 },
    ]);
  });
});
