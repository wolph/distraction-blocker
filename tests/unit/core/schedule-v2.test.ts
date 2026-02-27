import { describe, expect, it } from 'vitest';
import {
  capturedScheduleWindowContainsV2,
  createHandledScheduleOccurrenceV2,
  localStartDateForV2,
  mergeHandledScheduleOccurrencesV2,
  nextScheduleWindowStartV2,
  pruneHandledScheduleOccurrencesV2,
  type ResolvedScheduleOccurrenceV2,
  resolveOpenScheduleOccurrencesV2,
  scheduleOccurrenceTokenV2,
  selectScheduleCandidateV2,
} from '../../../src/core/schedule-v2';
import {
  HANDLED_SCHEDULE_OCCURRENCE_RETENTION_MS,
  MAX_HANDLED_SCHEDULE_OCCURRENCES,
} from '../../../src/shared/constants';
import type {
  HandledScheduleOccurrence,
  ScheduleEntryV2,
  ScheduleOccurrenceRef,
} from '../../../src/shared/types';
import { isTimezoneChild, runSuiteInTimezone } from '../timezone-child';

const DST_CHILD_FLAG: string = 'FOCUS_LOCK_V2_AMSTERDAM_DST_CHILD';
const isAmsterdamChild: boolean = isTimezoneChild(DST_CHILD_FLAG);

function entry(partial: Partial<ScheduleEntryV2> = {}): ScheduleEntryV2 {
  return {
    id: 'weekday',
    days: [1, 2, 3, 4, 5],
    start: '09:00',
    end: '12:30',
    duration: { kind: 'window' },
    mode: 'blacklist',
    strictness: 'hard',
    cycling: null,
    intention: 'morning deep work',
    enabled: true,
    ...partial,
  };
}

function handled(token: string, at: number, expiresAt: number = at + 1): HandledScheduleOccurrence {
  const separator: number = token.lastIndexOf('@');
  return {
    version: 1,
    token,
    entryId: token.slice(0, separator),
    localStartDate: token.slice(separator + 1),
    handledAt: at - 1,
    reason: 'started',
    expiresAt,
  };
}

function occurrence(entryId: string, localStartDate: string = '2026-08-28'): ScheduleOccurrenceRef {
  return {
    version: 1,
    token: `${entryId}@${localStartDate}`,
    entryId,
    localStartDate,
  };
}

function handledRecord(
  entryId: string,
  handledAt: number,
  expiresAt: number,
  reason: HandledScheduleOccurrence['reason'] = 'started',
): HandledScheduleOccurrence {
  return {
    ...occurrence(entryId),
    handledAt,
    reason,
    expiresAt,
  };
}

describe('v2 occurrence identity', (): void => {
  it('builds the token every producer and the stored-value validator spell the same way', (): void => {
    const startsAt: number = new Date(2026, 7, 28, 9, 0).getTime();

    expect(localStartDateForV2(startsAt)).toBe('2026-08-28');
    expect(scheduleOccurrenceTokenV2('weekday', localStartDateForV2(startsAt))).toBe(
      'weekday@2026-08-28',
    );
  });

  it('is the identity the resolver stores for the window it opened', (): void => {
    const fridayStart: number = new Date(2026, 7, 28, 9, 0).getTime();
    const resolved: ResolvedScheduleOccurrenceV2[] = resolveOpenScheduleOccurrencesV2(
      [entry()],
      fridayStart,
    );
    const first: ResolvedScheduleOccurrenceV2 | undefined = resolved[0];

    expect(first).toBeDefined();
    expect(first?.occurrence.token).toBe(
      scheduleOccurrenceTokenV2(
        first?.occurrence.entryId ?? '',
        localStartDateForV2(first?.windowStartsAt ?? 0),
      ),
    );
  });
});

describe('v2 schedule occurrence resolution', (): void => {
  it('uses an inclusive local start and exclusive local end', (): void => {
    const fridayStart: number = new Date(2026, 7, 28, 9, 0).getTime();
    const fridayEnd: number = new Date(2026, 7, 28, 12, 30).getTime();

    expect(resolveOpenScheduleOccurrencesV2([entry()], fridayStart)).toHaveLength(1);
    expect(resolveOpenScheduleOccurrencesV2([entry()], fridayEnd)).toEqual([]);
  });

  it('omits disabled entries and entries for another local weekday', (): void => {
    const friday: number = new Date(2026, 7, 28, 10, 0).getTime();

    expect(resolveOpenScheduleOccurrencesV2([entry({ enabled: false })], friday)).toEqual([]);
    expect(resolveOpenScheduleOccurrencesV2([entry({ days: [0] })], friday)).toEqual([]);
  });

  it('builds the exact occurrence token and local Date-constructor bounds', (): void => {
    const friday: number = new Date(2026, 7, 28, 10, 0).getTime();
    const [resolved] = resolveOpenScheduleOccurrencesV2([entry({ id: 'release' })], friday);

    expect(resolved).toEqual({
      entry: entry({ id: 'release' }),
      occurrence: {
        version: 1,
        token: 'release@2026-08-28',
        entryId: 'release',
        localStartDate: '2026-08-28',
      },
      windowStartsAt: new Date(2026, 7, 28, 9, 0).getTime(),
      windowEndsAt: new Date(2026, 7, 28, 12, 30).getTime(),
    });
  });

  it.each([Number.MAX_SAFE_INTEGER, Number.NaN, new Date(10_000, 0, 1, 12, 0).getTime()])(
    'rejects a non-platform or non-four-digit local observation time: %s',
    (at: number): void => {
      expect((): unknown => resolveOpenScheduleOccurrencesV2([entry()], at)).toThrowError(
        expect.objectContaining({ code: 'invalid-schedule' }),
      );
    },
  );

  it('returns all open occurrences while candidate selection suppresses only live handled tokens', (): void => {
    const friday: number = new Date(2026, 7, 28, 10, 30).getTime();
    const first: ScheduleEntryV2 = entry({ id: 'first', start: '09:00' });
    const second: ScheduleEntryV2 = entry({ id: 'second', start: '10:00' });
    const firstToken: string = 'first@2026-08-28';
    const liveFirst: HandledScheduleOccurrence = handled(firstToken, friday, friday + 1);

    expect(resolveOpenScheduleOccurrencesV2([second, first], friday)).toHaveLength(2);
    expect(selectScheduleCandidateV2([second, first], [liveFirst], friday)?.entry.id).toBe(
      'second',
    );
    expect(
      selectScheduleCandidateV2([second, first], [handled(firstToken, friday, friday)], friday)
        ?.entry.id,
    ).toBe('first');
  });

  it('orders defensive candidates by start, end, and Unicode code-point token order', (): void => {
    const friday: number = new Date(2026, 7, 28, 10, 30).getTime();
    const laterStart: ScheduleEntryV2 = entry({ id: 'later', start: '10:00' });
    const earlierStart: ScheduleEntryV2 = entry({ id: 'earlier', start: '09:00' });
    const longer: ScheduleEntryV2 = entry({ id: 'longer', end: '12:30' });
    const shorter: ScheduleEntryV2 = entry({ id: 'shorter', end: '11:30' });
    const astral: ScheduleEntryV2 = entry({ id: '\u{10000}' });
    const privateUse: ScheduleEntryV2 = entry({ id: '\uE000' });

    expect(selectScheduleCandidateV2([laterStart, earlierStart], [], friday)?.entry.id).toBe(
      'earlier',
    );
    expect(selectScheduleCandidateV2([longer, shorter], [], friday)?.entry.id).toBe('shorter');
    expect(selectScheduleCandidateV2([astral, privateUse], [], friday)?.entry.id).toBe('\uE000');
  });

  it('detaches resolver and candidate entries from caller-owned nested values', (): void => {
    const friday: number = new Date(2026, 7, 28, 10, 0).getTime();
    const source: ScheduleEntryV2 = entry({
      days: [5],
      duration: { kind: 'window' },
      cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
    });
    const resolved = resolveOpenScheduleOccurrencesV2([source], friday)[0];
    const candidate = selectScheduleCandidateV2([source], [], friday);

    expect(resolved).toBeDefined();
    expect(candidate).not.toBeNull();
    source.days[0] = 0;
    source.duration.kind = 'until-stopped';
    if (source.cycling !== null) source.cycling.focusMin = 99;
    expect(resolved?.entry.days).toEqual([5]);
    expect(resolved?.entry.duration).toEqual({ kind: 'window' });
    expect(resolved?.entry.cycling?.focusMin).toBe(25);
    expect(candidate?.entry.days).toEqual([5]);

    if (resolved !== undefined) {
      resolved.entry.days[0] = 1;
      resolved.entry.duration.kind = 'until-stopped';
      if (resolved.entry.cycling !== null) resolved.entry.cycling.focusMin = 1;
    }
    if (candidate !== null) candidate.entry.days[0] = 2;
    expect(source.days).toEqual([0]);
    expect(source.duration).toEqual({ kind: 'until-stopped' });
    expect(source.cycling?.focusMin).toBe(99);
  });
});

describe('captured schedule window membership', (): void => {
  it('uses only the captured half-open absolute interval', (): void => {
    const window = { windowStartsAt: 100, windowEndsAt: 200 };

    expect(capturedScheduleWindowContainsV2(window, 100)).toBe(true);
    expect(capturedScheduleWindowContainsV2(window, 199)).toBe(true);
    expect(capturedScheduleWindowContainsV2(window, 200)).toBe(false);
  });

  it.each([
    [{ windowStartsAt: -1, windowEndsAt: 200 }, 100],
    [{ windowStartsAt: 100, windowEndsAt: 100 }, 100],
    [{ windowStartsAt: 200, windowEndsAt: 100 }, 100],
    [{ windowStartsAt: 100, windowEndsAt: Number.MAX_VALUE }, 100],
    [{ windowStartsAt: 100, windowEndsAt: 200 }, -1],
    [{ windowStartsAt: 100, windowEndsAt: 200 }, Number.NaN],
  ])('rejects invalid bounds or observation time %#', (window, at): void => {
    expect((): boolean => capturedScheduleWindowContainsV2(window, at)).toThrowError(
      expect.objectContaining({ code: 'invalid-schedule' }),
    );
  });
});

describe('v2 handled schedule occurrence retention', (): void => {
  it('creates the exact handled identity, reason, timestamp, and 14-day expiry', (): void => {
    const source: ScheduleOccurrenceRef = occurrence('release');
    const handledAt: number = 1_800_000_000_000;
    const created: HandledScheduleOccurrence = createHandledScheduleOccurrenceV2(
      source,
      handledAt,
      'closure-overlap',
    );

    expect(created).toEqual({
      ...source,
      handledAt,
      reason: 'closure-overlap',
      expiresAt: handledAt + HANDLED_SCHEDULE_OCCURRENCE_RETENTION_MS,
    });
    source.token = 'source-changed@2026-08-28';
    expect(created.token).toBe('release@2026-08-28');
    created.token = 'changed@2026-08-28';
    expect(source.token).toBe('source-changed@2026-08-28');
  });

  it.each([-1, Number.NaN, Number.MAX_SAFE_INTEGER - HANDLED_SCHEDULE_OCCURRENCE_RETENTION_MS + 1])(
    'rejects unsafe handled timestamp or expiry arithmetic: %s',
    (handledAt: number): void => {
      expect(
        (): HandledScheduleOccurrence =>
          createHandledScheduleOccurrenceV2(occurrence('release'), handledAt, 'started'),
      ).toThrowError(expect.objectContaining({ code: 'invalid-schedule' }));
    },
  );

  it('retains a record one millisecond before expiry and removes it at expiry', (): void => {
    const record: HandledScheduleOccurrence = handledRecord('release', 100, 200);

    expect(pruneHandledScheduleOccurrencesV2([record], 199)).toEqual([record]);
    expect(pruneHandledScheduleOccurrencesV2([record], 200)).toEqual([]);
  });

  it('removes expired records before applying the 256-record cap', (): void => {
    const at: number = 10_000;
    const expired: HandledScheduleOccurrence = handledRecord('expired', 0, at);
    const live: HandledScheduleOccurrence[] = Array.from(
      { length: MAX_HANDLED_SCHEDULE_OCCURRENCES },
      (_unused: unknown, index: number): HandledScheduleOccurrence =>
        handledRecord(`live-${index}`, index + 1, at + 1),
    );

    const pruned: HandledScheduleOccurrence[] = pruneHandledScheduleOccurrencesV2(
      [expired, ...live],
      at,
    );

    expect(pruned).toHaveLength(MAX_HANDLED_SCHEDULE_OCCURRENCES);
    expect(pruned.map((record: HandledScheduleOccurrence): string => record.token)).not.toContain(
      expired.token,
    );
  });

  it('preserves an existing live durable record when additions duplicate its token', (): void => {
    const at: number = 1_000;
    const current: HandledScheduleOccurrence = handledRecord('same', 100, 2_000, 'started');
    const addition: HandledScheduleOccurrence = handledRecord(
      'same',
      200,
      3_000,
      'closure-overlap',
    );

    expect(mergeHandledScheduleOccurrencesV2([current], [addition], at)).toEqual([current]);
  });

  it('allows a fresh same-token addition after the current record expires', (): void => {
    const at: number = 1_000;
    const expired: HandledScheduleOccurrence = handledRecord('same', 100, at, 'started');
    const fresh: HandledScheduleOccurrence = handledRecord('same', at, 3_000, 'closure-overlap');

    expect(mergeHandledScheduleOccurrencesV2([expired], [fresh], at)).toEqual([fresh]);
  });

  it('removes expired additions before deduplicating their tokens', (): void => {
    const at: number = 1_000;
    const expired: HandledScheduleOccurrence = handledRecord('same', 100, at, 'started');
    const fresh: HandledScheduleOccurrence = handledRecord('same', at, 3_000, 'closure-overlap');

    expect(mergeHandledScheduleOccurrencesV2([], [expired, fresh], at)).toEqual([fresh]);
  });

  it('deduplicates tokens and produces an idempotent canonical merge', (): void => {
    const at: number = 1_000;
    const first: HandledScheduleOccurrence = handledRecord('first', 200, 3_000);
    const second: HandledScheduleOccurrence = handledRecord('second', 100, 3_000);
    const duplicate: HandledScheduleOccurrence = handledRecord(
      'first',
      300,
      4_000,
      'closure-overlap',
    );
    const merged: HandledScheduleOccurrence[] = mergeHandledScheduleOccurrencesV2(
      [first],
      [second, duplicate],
      at,
    );

    expect(merged).toEqual([second, first]);
    expect(
      new Set(merged.map((record: HandledScheduleOccurrence): string => record.token)).size,
    ).toBe(merged.length);
    expect(mergeHandledScheduleOccurrencesV2(merged, [second, duplicate], at)).toEqual(merged);
  });

  it('retains exactly 256 records and removes the oldest handled timestamp first', (): void => {
    const at: number = 1_000;
    const records: HandledScheduleOccurrence[] = Array.from(
      { length: MAX_HANDLED_SCHEDULE_OCCURRENCES + 1 },
      (_unused: unknown, index: number): HandledScheduleOccurrence =>
        handledRecord(`record-${index}`, index, 10_000),
    );
    const pruned: HandledScheduleOccurrence[] = pruneHandledScheduleOccurrencesV2(records, at);

    expect(pruned).toHaveLength(MAX_HANDLED_SCHEDULE_OCCURRENCES);
    expect(
      pruned.some((record: HandledScheduleOccurrence): boolean => record.handledAt === 0),
    ).toBe(false);
    expect(pruned[0]?.handledAt).toBe(1);
  });

  it('prunes equal timestamps by Unicode code-point token order', (): void => {
    const at: number = 1_000;
    const laterCodePoints: HandledScheduleOccurrence[] = Array.from(
      { length: MAX_HANDLED_SCHEDULE_OCCURRENCES - 1 },
      (_unused: unknown, index: number): HandledScheduleOccurrence =>
        handledRecord(`\u{10001}-${index}`, 100, 10_000),
    );
    const privateUse: HandledScheduleOccurrence = handledRecord('\uE000', 100, 10_000);
    const astral: HandledScheduleOccurrence = handledRecord('\u{10000}', 100, 10_000);

    const pruned: HandledScheduleOccurrence[] = pruneHandledScheduleOccurrencesV2(
      [astral, ...laterCodePoints, privateUse],
      at,
    );

    expect(pruned).toHaveLength(MAX_HANDLED_SCHEDULE_OCCURRENCES);
    expect(pruned.map((record: HandledScheduleOccurrence): string => record.token)).not.toContain(
      privateUse.token,
    );
    expect(pruned.map((record: HandledScheduleOccurrence): string => record.token)).toContain(
      astral.token,
    );
  });

  it('keeps prune and merge inputs and outputs detached in both mutation directions', (): void => {
    const at: number = 1_000;
    const current: HandledScheduleOccurrence = handledRecord('current', 100, 3_000);
    const addition: HandledScheduleOccurrence = handledRecord('addition', 200, 3_000);
    const pruned: HandledScheduleOccurrence[] = pruneHandledScheduleOccurrencesV2([current], at);
    const merged: HandledScheduleOccurrence[] = mergeHandledScheduleOccurrencesV2(
      [current],
      [addition],
      at,
    );

    expect(current).toEqual(handledRecord('current', 100, 3_000));
    expect(addition).toEqual(handledRecord('addition', 200, 3_000));
    current.reason = 'closure-overlap';
    addition.reason = 'closure-overlap';
    expect(pruned[0]?.reason).toBe('started');
    expect(merged.map((record: HandledScheduleOccurrence): string => record.reason)).toEqual([
      'started',
      'started',
    ]);

    if (pruned[0] !== undefined) pruned[0].entryId = 'changed-pruned';
    if (merged[0] !== undefined) merged[0].entryId = 'changed-merged';
    expect(current.entryId).toBe('current');
    expect(addition.entryId).toBe('addition');
  });
});

describe('nextScheduleWindowStartV2', (): void => {
  const FRIDAY_0800: number = new Date(2026, 7, 28, 8, 0).getTime();
  const FRIDAY_1300: number = new Date(2026, 7, 28, 13, 0).getTime();

  it('finds later today, then the next matching day, and nothing when disabled', (): void => {
    expect(nextScheduleWindowStartV2([entry()], FRIDAY_0800)?.startsAt).toBe(
      new Date(2026, 7, 28, 9, 0).getTime(),
    );
    expect(nextScheduleWindowStartV2([entry()], FRIDAY_1300)?.startsAt).toBe(
      new Date(2026, 7, 31, 9, 0).getTime(),
    );
    expect(nextScheduleWindowStartV2([entry({ enabled: false })], FRIDAY_0800)).toBeNull();
  });

  it('takes the earliest of several entries and answers with a detached copy', (): void => {
    const later: ScheduleEntryV2 = entry({ id: 'later', start: '11:00', end: '12:00' });
    const earlier: ScheduleEntryV2 = entry({ id: 'earlier', start: '10:00', end: '10:30' });

    const next: { entry: ScheduleEntryV2; startsAt: number } | null = nextScheduleWindowStartV2(
      [later, earlier],
      new Date(2026, 7, 28, 9, 30).getTime(),
    );

    expect(next?.entry.id).toBe('earlier');
    expect(next?.entry).not.toBe(earlier);
    expect(next?.startsAt).toBe(new Date(2026, 7, 28, 10, 0).getTime());
  });

  it('agrees with the open-window resolver about when a window starts', (): void => {
    // The whole point of one resolver: the instant the read model predicts is the instant the
    // check reports once that window is open. A drift here is a start the popup announced and the
    // schedule check declined.
    const weekday: ScheduleEntryV2 = entry();
    const predicted: number =
      nextScheduleWindowStartV2([weekday], FRIDAY_0800)?.startsAt ?? Number.NaN;
    const open: ResolvedScheduleOccurrenceV2 | undefined = resolveOpenScheduleOccurrencesV2(
      [weekday],
      predicted + 60_000,
    )[0];

    expect(open?.windowStartsAt).toBe(predicted);
    expect(open?.occurrence.token).toBe(
      scheduleOccurrenceTokenV2(weekday.id, localStartDateForV2(predicted)),
    );
  });
});

describe.runIf(!isAmsterdamChild)('v2 schedule timezone isolation', (): void => {
  it('passes the exact DST cases in a Europe/Amsterdam child process', (): void => {
    expect((): string =>
      runSuiteInTimezone('Europe/Amsterdam', DST_CHILD_FLAG, import.meta.url),
    ).not.toThrow();
  });
});

describe.runIf(isAmsterdamChild)('Europe/Amsterdam v2 schedule occurrences', (): void => {
  it('uses the local date rather than UTC formatting for occurrence identity', (): void => {
    const localAfterMidnight: number = new Date(2026, 2, 29, 0, 30).getTime();
    const sundayEntry: ScheduleEntryV2 = entry({ days: [0], start: '00:00', end: '01:00' });

    expect(new Date(localAfterMidnight).toISOString().slice(0, 10)).toBe('2026-03-28');
    expect(
      resolveOpenScheduleOccurrencesV2([sundayEntry], localAfterMidnight)[0]?.occurrence.token,
    ).toBe('weekday@2026-03-29');
  });

  it('keeps the next spring and autumn starts on their configured wall-clock times', (): void => {
    // Ported from the v1 `nextStart` cases when this resolver took over the question, so the DST
    // coverage stays with the code that answers it.
    const spring: ScheduleEntryV2 = entry({ days: [0], start: '03:30', end: '04:30' });
    const autumn: ScheduleEntryV2 = entry({ days: [0], start: '09:00', end: '10:00' });

    const springStart: number | undefined = nextScheduleWindowStartV2(
      [spring],
      new Date(2026, 2, 28, 12, 0).getTime(),
    )?.startsAt;
    const autumnStart: number | undefined = nextScheduleWindowStartV2(
      [autumn],
      new Date(2026, 9, 24, 12, 0).getTime(),
    )?.startsAt;

    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Europe/Amsterdam');
    expect(new Date(springStart ?? 0).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(new Date(autumnStart ?? 0).toISOString()).toBe('2026-10-25T08:00:00.000Z');
  });

  it('resolves the spring window through platform local Date construction', (): void => {
    const duringWindow: number = new Date(2026, 2, 29, 3, 45).getTime();
    const sundayEntry: ScheduleEntryV2 = entry({ days: [0], start: '03:30', end: '04:30' });
    const resolved = resolveOpenScheduleOccurrencesV2([sundayEntry], duringWindow)[0];

    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Europe/Amsterdam');
    expect(new Date(resolved?.windowStartsAt ?? 0).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(new Date(resolved?.windowEndsAt ?? 0).toISOString()).toBe('2026-03-29T02:30:00.000Z');
    expect(resolved?.occurrence.token).toBe('weekday@2026-03-29');
  });

  it('uses one fall token and platform bounds across both repeated local hours', (): void => {
    const sundayEntry: ScheduleEntryV2 = entry({ days: [0], start: '02:00', end: '03:00' });
    const firstOccurrence: number = new Date(2026, 9, 25, 2, 30).getTime();
    const repeatedOccurrence: number = new Date('2026-10-25T01:30:00.000Z').getTime();
    const first = resolveOpenScheduleOccurrencesV2([sundayEntry], firstOccurrence)[0];
    const repeated = resolveOpenScheduleOccurrencesV2([sundayEntry], repeatedOccurrence)[0];

    expect(new Date(first?.windowStartsAt ?? 0).toISOString()).toBe('2026-10-25T00:00:00.000Z');
    expect(new Date(first?.windowEndsAt ?? 0).toISOString()).toBe('2026-10-25T02:00:00.000Z');
    expect(first?.occurrence.token).toBe('weekday@2026-10-25');
    expect(repeated?.occurrence.token).toBe(first?.occurrence.token);

    const live: HandledScheduleOccurrence = handled(
      first?.occurrence.token ?? '',
      firstOccurrence,
      repeatedOccurrence + 1,
    );
    expect(selectScheduleCandidateV2([sundayEntry], [live], repeatedOccurrence)).toBeNull();
  });

  it('requires positive absolute time only for a window-timed fall candidate', (): void => {
    const repeatedSecondHour: number = new Date('2026-10-25T01:10:00.000Z').getTime();
    const windowEntry: ScheduleEntryV2 = entry({
      days: [0],
      start: '02:00',
      end: '02:15',
    });
    const indefiniteEntry: ScheduleEntryV2 = entry({
      ...windowEntry,
      duration: { kind: 'until-stopped' },
      strictness: 'flexible',
    });

    expect(resolveOpenScheduleOccurrencesV2([windowEntry], repeatedSecondHour)).toHaveLength(1);
    expect(selectScheduleCandidateV2([windowEntry], [], repeatedSecondHour)).toBeNull();
    expect(selectScheduleCandidateV2([indefiniteEntry], [], repeatedSecondHour)?.entry.id).toBe(
      'weekday',
    );
  });
});
