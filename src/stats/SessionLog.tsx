import type { JSX } from 'preact';
import { formatDuration, formatTimeOfDay } from '../shared/format';
import type { EventRecord } from '../shared/types';
import { pairSessionRowsV2, type SessionRowV2 } from './session-rows-v2';

/** The chip a row wears, from the outcome kind the pairing already decided. */
function chipClass(outcomeKind: SessionRowV2['outcomeKind']): string {
  if (outcomeKind === 'completed') return 'chip completed';
  if (outcomeKind === 'running') return 'chip running';
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
  const rows: SessionRowV2[] = pairSessionRowsV2(props.events);
  if (rows.length === 0) {
    return (
      <section class="card">
        <h2>Recent sessions on this machine</h2>
        <p class="empty-line">Your first session will appear here.</p>
      </section>
    );
  }
  return (
    <section class="card">
      <h2>Recent sessions on this machine</h2>
      <div class="session-table-wrap">
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
              (row: SessionRowV2): JSX.Element => (
                <tr key={row.startedAt}>
                  <td>{new Date(row.startedAt).toLocaleDateString()}</td>
                  <td>{formatTimeOfDay(row.startedAt)}</td>
                  <td>{row.plan}</td>
                  <td>{row.focusedMs === null ? '-' : formatDuration(row.focusedMs)}</td>
                  <td>{formatDuration(row.pauseMs)}</td>
                  <td>{formatDuration(row.unlockMs)}</td>
                  <td class="intention-cell">{row.intention}</td>
                  <td>
                    <span class={chipClass(row.outcomeKind)}>{row.outcome}</span>
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
      <div class="session-articles">
        {rows.map(
          (row: SessionRowV2): JSX.Element => (
            <article
              class="session-article"
              aria-label={`Session: ${row.intention || 'No intention'}`}
              key={row.startedAt}
            >
              <div class="session-article-heading">
                <strong>{row.intention || 'No intention'}</strong>
                <span class={chipClass(row.outcomeKind)}>{row.outcome}</span>
              </div>
              <dl class="session-fields">
                <div>
                  <dt>Date</dt>
                  <dd>{new Date(row.startedAt).toLocaleDateString()}</dd>
                </div>
                <div>
                  <dt>Start</dt>
                  <dd>{formatTimeOfDay(row.startedAt)}</dd>
                </div>
                <div>
                  <dt>Planned</dt>
                  <dd>{row.plan}</dd>
                </div>
                <div>
                  <dt>Focused</dt>
                  <dd>{row.focusedMs === null ? '-' : formatDuration(row.focusedMs)}</dd>
                </div>
                <div>
                  <dt>All sites</dt>
                  <dd>{formatDuration(row.pauseMs)}</dd>
                </div>
                <div>
                  <dt>One site</dt>
                  <dd>{formatDuration(row.unlockMs)}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd class="session-source">
                    <SourceGlyph source={row.source} />
                    {row.source}
                  </dd>
                </div>
              </dl>
            </article>
          ),
        )}
      </div>
    </section>
  );
}
