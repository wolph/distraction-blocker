import type { JSX } from 'preact';
import type { EventRecord } from '../shared/types';
import { formatDuration, formatTimeOfDay } from './format';

const MAX_ROWS = 20;

export interface SessionRow {
  startedAt: number;
  plannedMin: number;
  intention: string;
  source: 'manual' | 'schedule';
  outcome: 'completed' | 'ended early' | 'running';
  /** null when the session is still running or its end event is missing */
  focusedMs: number | null;
}

interface OpenRow {
  startedAt: number;
  plannedMin: number;
  intention: string;
  source: 'manual' | 'schedule';
}

function closed(
  open: OpenRow,
  outcome: SessionRow['outcome'],
  focusedMs: number | null,
): SessionRow {
  return { ...open, outcome, focusedMs };
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
  let open: OpenRow | null = null;
  for (const event of chronological) {
    if (event.t === 'sessionStarted') {
      if (open !== null) rows.push(closed(open, 'ended early', null));
      open = {
        startedAt: event.at,
        plannedMin: event.durationMin,
        intention: event.intention,
        source: event.source,
      };
    } else if (event.t === 'sessionCompleted' && open !== null) {
      rows.push(closed(open, 'completed', event.focusedMs));
      open = null;
    } else if (event.t === 'sessionCanceled' && open !== null) {
      rows.push(closed(open, 'ended early', event.focusedMs));
      open = null;
    }
  }
  if (open !== null) rows.push(closed(open, 'running', null));
  rows.reverse();
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
                  <td>{formatDuration(row.plannedMin * 60_000)}</td>
                  <td>{row.focusedMs === null ? '-' : formatDuration(row.focusedMs)}</td>
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
