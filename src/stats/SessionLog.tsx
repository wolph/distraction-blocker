import type { JSX } from 'preact';
import type { EventRecord } from '../shared/types';
import { formatDuration, formatTimeOfDay } from './format';

const MAX_ROWS: number = 20;

export interface SessionRow {
  startedAt: number;
  plannedMin: number | null;
  intention: string;
  source: 'manual' | 'schedule';
  outcome: 'completed' | 'ended early' | 'running';
  /** null when the session is still running or its end event is missing */
  focusedMs: number | null;
  pauseMs: number;
  unlockMs: number;
}

interface OpenRow {
  sessionId?: string;
  superseded: boolean;
  startedAt: number;
  plannedMin: number | null;
  intention: string;
  source: 'manual' | 'schedule';
  pauseMs: number;
  unlockMs: number;
}

function closed(
  open: OpenRow,
  outcome: SessionRow['outcome'],
  focusedMs: number | null,
): SessionRow {
  return {
    startedAt: open.startedAt,
    plannedMin: open.plannedMin,
    intention: open.intention,
    source: open.source,
    outcome,
    focusedMs,
    pauseMs: open.pauseMs,
    unlockMs: open.unlockMs,
  };
}

function matchingOpenIndex(opens: OpenRow[], event: EventRecord): number {
  const sessionId: string | undefined = 'sessionId' in event ? event.sessionId : undefined;
  if (sessionId !== undefined) {
    const exact: number = opens.findIndex((open: OpenRow): boolean => open.sessionId === sessionId);
    return exact;
  }
  const legacy: number = opens.findIndex((open: OpenRow): boolean => open.sessionId === undefined);
  if (legacy >= 0) return legacy;
  return event.t === 'pauseTaken' || event.t === 'unlockTaken' ? opens.length - 1 : -1;
}

/**
 * Pair sessionStarted with the following sessionCompleted or sessionCanceled.
 * Input is newest first (StatsBundle.recentSessions). A dangling newest start
 * is a running session. A start displaced by a later start closed without an
 * end event (worker restart), shown as ended early with unknown focus time.
 */
export function pairSessions(events: EventRecord[]): SessionRow[] {
  const chronological: EventRecord[] = [...events].reverse();
  const rows: SessionRow[] = [];
  const opens: OpenRow[] = [];
  for (const event of chronological) {
    if (event.t === 'sessionIdentityAssigned') {
      const open: OpenRow | undefined = opens.find(
        (candidate: OpenRow): boolean =>
          candidate.sessionId === undefined && candidate.startedAt === event.startedAt,
      );
      if (
        open !== undefined &&
        !opens.some((candidate: OpenRow): boolean => candidate.sessionId === event.sessionId)
      ) {
        open.sessionId = event.sessionId;
      }
      continue;
    }
    if (event.t === 'sessionStarted') {
      for (const open of opens) open.superseded = true;
      const displacedIndex: number =
        event.sessionId === undefined
          ? opens.findIndex((open: OpenRow): boolean => open.sessionId === undefined)
          : opens.findIndex((open: OpenRow): boolean => open.sessionId === event.sessionId);
      if (displacedIndex >= 0) {
        const displaced: OpenRow | undefined = opens.splice(displacedIndex, 1)[0];
        if (displaced !== undefined) rows.push(closed(displaced, 'ended early', null));
      }
      opens.push({
        ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
        superseded: false,
        startedAt: event.at,
        plannedMin: event.durationMin,
        intention: event.intention,
        source: event.source,
        pauseMs: 0,
        unlockMs: 0,
      });
      continue;
    }
    const openIndex: number = matchingOpenIndex(opens, event);
    const open: OpenRow | undefined = opens[openIndex];
    if (open === undefined) continue;
    if (event.t === 'pauseTaken') {
      open.pauseMs += event.ms;
    } else if (event.t === 'unlockTaken') {
      open.unlockMs += event.ms;
    } else if (event.t === 'sessionCompleted') {
      rows.push(closed(open, 'completed', event.focusedMs));
      opens.splice(openIndex, 1);
    } else if (event.t === 'sessionCanceled') {
      rows.push(closed(open, 'ended early', event.focusedMs));
      opens.splice(openIndex, 1);
    }
  }
  for (const open of opens) {
    rows.push(closed(open, open.superseded ? 'ended early' : 'running', null));
  }
  rows.sort((left: SessionRow, right: SessionRow): number => right.startedAt - left.startedAt);
  return rows.slice(0, MAX_ROWS);
}

function chipClass(outcome: SessionRow['outcome']): string {
  if (outcome === 'completed') return 'chip completed';
  if (outcome === 'running') return 'chip running';
  return 'chip neutral';
}

function SourceGlyph(props: { source: 'manual' | 'schedule' }): JSX.Element {
  if (props.source === 'schedule') {
    return (
      <svg class="glyph source" viewBox="0 0 16 16" aria-label="scheduled" role="img">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4" />
        <path
          d="M8 4.5V8l2.4 1.6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
        />
      </svg>
    );
  }
  return (
    <svg class="glyph source" viewBox="0 0 16 16" aria-label="manual" role="img">
      <circle cx="8" cy="8" r="2.6" fill="currentColor" />
    </svg>
  );
}

export function SessionLog(props: { events: EventRecord[] }): JSX.Element {
  const rows: SessionRow[] = pairSessions(props.events);
  if (rows.length === 0) {
    return (
      <section class="card">
        <h2>Recent sessions</h2>
        <p class="empty-line">Your first session will appear here.</p>
      </section>
    );
  }
  return (
    <section class="card">
      <h2>Recent sessions</h2>
      <div class="table-scroll">
        <table class="session-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Start</th>
              <th>Planned</th>
              <th>Focused</th>
              <th>All sites</th>
              <th>One site</th>
              <th>Intention</th>
              <th>Outcome</th>
              <th>
                <span class="visually-hidden">Source</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(
              (row: SessionRow): JSX.Element => (
                <tr key={row.startedAt}>
                  <td>{new Date(row.startedAt).toLocaleDateString()}</td>
                  <td>{formatTimeOfDay(row.startedAt)}</td>
                  <td>
                    {row.plannedMin === null
                      ? 'Until manual unlock'
                      : formatDuration(row.plannedMin * 60_000)}
                  </td>
                  <td>{row.focusedMs === null ? '-' : formatDuration(row.focusedMs)}</td>
                  <td>{formatDuration(row.pauseMs)}</td>
                  <td>{formatDuration(row.unlockMs)}</td>
                  <td class="intention-cell">{row.intention}</td>
                  <td>
                    <span class={chipClass(row.outcome)}>{row.outcome}</span>
                  </td>
                  <td>
                    <SourceGlyph source={row.source} />
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
