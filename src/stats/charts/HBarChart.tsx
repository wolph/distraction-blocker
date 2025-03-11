import type { JSX } from 'preact';
import { useId } from 'preact/hooks';
import type { ChartDatum } from './BarChart';
import { niceMax } from './BarChart';

export interface HBarChartProps {
  data: ChartDatum[];
  format: (v: number) => string;
  /** accessible chart name, normally matching the surrounding heading */
  label?: string;
  color?: string;
  emptyLine?: string;
}

const W: number = 560;
const LABEL_W: number = 150;
const VALUE_W: number = 52;
const ROW_H: number = 22;
const BAR_H: number = 12;
const PAD_Y: number = 4;
const BAR_MAX_W: number = W - LABEL_W - VALUE_W;
const CHART_DESCRIPTION: string =
  'Horizontal bar chart. Use the keyboard to move through data points, or open View as table for the same values.';

function truncate(label: string): string {
  return label.length > 24 ? `${label.slice(0, 21)}...` : label;
}

/** Rounded data-end on the right, square at the left baseline. */
function hbarPath(y: number, w: number): string {
  if (w <= 0) return `M ${LABEL_W} ${y} v ${BAR_H}`;
  const r: number = Math.min(4, w, BAR_H / 2);
  const right: number = LABEL_W + w;
  return [
    `M ${LABEL_W} ${y}`,
    `H ${right - r}`,
    `Q ${right} ${y} ${right} ${y + r}`,
    `V ${y + BAR_H - r}`,
    `Q ${right} ${y + BAR_H} ${right - r} ${y + BAR_H}`,
    `H ${LABEL_W}`,
    'Z',
  ].join(' ');
}

export function HBarChart(props: HBarChartProps): JSX.Element {
  const titleId: string = useId();
  const descriptionId: string = useId();
  const data: ChartDatum[] = props.data;
  const emptyLine: string = props.emptyLine ?? 'No data yet.';
  if (data.length === 0 || data.every((d: ChartDatum): boolean => d.value <= 0)) {
    return <p class="empty-line">{emptyLine}</p>;
  }
  const color: string = props.color ?? 'var(--attempts-series)';
  const max: number = niceMax(Math.max(...data.map((d: ChartDatum): number => d.value)));
  const height: number = data.length * ROW_H + PAD_Y * 2;
  return (
    <div class="chart-wrap">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        class="chart hbar"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <title id={titleId}>{props.label ?? 'Horizontal bar chart'}</title>
        <desc id={descriptionId}>{CHART_DESCRIPTION}</desc>
        <line class="baseline" x1={LABEL_W} x2={LABEL_W} y1={PAD_Y} y2={height - PAD_Y} />
        {data.map((d: ChartDatum, i: number): JSX.Element => {
          const rowY: number = PAD_Y + i * ROW_H;
          const barY: number = rowY + (ROW_H - BAR_H) / 2;
          const barW: number = (d.value / max) * BAR_MAX_W;
          return (
            <g
              key={d.label}
              class="hbar-row"
              tabindex={0}
              aria-label={`${d.label}: ${props.format(d.value)}`}
            >
              <title>{`${d.label}: ${props.format(d.value)}`}</title>
              <rect
                class="hbar-focus-ring"
                x={1}
                y={rowY + 1}
                width={W - 2}
                height={ROW_H - 2}
                rx={3}
              />
              <text class="axis-text" x={LABEL_W - 8} y={rowY + ROW_H / 2 + 3} text-anchor="end">
                {truncate(d.label)}
              </text>
              <path class="hbar-mark" d={hbarPath(barY, barW)} data-w={String(barW)} fill={color} />
              {d.value > 0 ? (
                <text class="value-label" x={LABEL_W + barW + 6} y={rowY + ROW_H / 2 + 3}>
                  {props.format(d.value)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
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
            {data.map(
              (d: ChartDatum): JSX.Element => (
                <tr key={d.label}>
                  <th scope="row">{d.label}</th>
                  <td>{props.format(d.value)}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </details>
    </div>
  );
}
