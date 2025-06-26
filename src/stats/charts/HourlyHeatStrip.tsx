import type { JSX } from 'preact';

export interface HourlyHeatStripProps {
  values: number[];
}

const HOURS_PER_DAY: number = 24;
const ACCESSIBLE_NAME: string = '24-hour blocked-attempt heat strip';

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

export function HourlyHeatStrip(props: HourlyHeatStripProps): JSX.Element {
  const values: number[] = Array.from(
    { length: HOURS_PER_DAY },
    (_unused: unknown, hour: number): number => Math.max(0, props.values[hour] ?? 0),
  );
  const maximum: number = Math.max(1, ...values);

  return (
    <div class="chart-wrap hourly-heat-wrap">
      <div class="heat-strip" role="img" aria-label={ACCESSIBLE_NAME}>
        {values.map((value: number, hour: number): JSX.Element => {
          const label: string = hourLabel(hour);
          return (
            <span
              class="heat-cell"
              data-hour={label}
              style={`--intensity: ${value / maximum}`}
              key={label}
            >
              <span class="heat-cell-label">{String(hour).padStart(2, '0')}</span>
            </span>
          );
        })}
      </div>
      <details class="chart-table">
        <summary>View as table</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {values.map((value: number, hour: number): JSX.Element => {
              const label: string = hourLabel(hour);
              return (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td>{value} blocked</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </div>
  );
}
