import type { JSX, RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { ChartDatum } from './BarChart';

export interface ChartTableProps {
  className: string;
  data: ChartDatum[];
  format: (value: number) => string;
  autoOpenBelow?: number;
}

export function ChartTable(props: ChartTableProps): JSX.Element {
  const detailsRef: RefObject<HTMLDetailsElement> = useRef<HTMLDetailsElement>(null);
  useEffect((): (() => void) | undefined => {
    const details: HTMLDetailsElement | null = detailsRef.current;
    const container: HTMLElement | null = details?.parentElement ?? null;
    if (
      details === null ||
      container === null ||
      props.autoOpenBelow === undefined ||
      typeof ResizeObserver === 'undefined'
    ) {
      return undefined;
    }
    const update: (width: number) => void = (width: number): void => {
      if (width <= (props.autoOpenBelow ?? 0)) {
        if (!details.open) {
          details.open = true;
          details.dataset.autoOpened = 'true';
        }
        return;
      }
      if (details.dataset.autoOpened === 'true') {
        details.open = false;
        delete details.dataset.autoOpened;
      }
    };
    const observer: ResizeObserver = new ResizeObserver((entries: ResizeObserverEntry[]): void => {
      const entry: ResizeObserverEntry | undefined = entries[0];
      if (entry !== undefined) update(entry.contentRect.width);
    });
    observer.observe(container);
    update(container.getBoundingClientRect().width);
    return (): void => observer.disconnect();
  }, [props.autoOpenBelow]);

  return (
    <details class={props.className} ref={detailsRef}>
      <summary>View as table</summary>
      <table>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {props.data.map(
            (datum: ChartDatum): JSX.Element => (
              <tr key={datum.label}>
                <th scope="row">{datum.label}</th>
                <td>{props.format(datum.value)}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </details>
  );
}
