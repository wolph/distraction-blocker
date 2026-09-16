/**
 * The toolbar icon: the store's green tile with its padlock and progress ring, drawn inline so the
 * page loads no extra file. The shackle sits closed while a focus session locks sites and swings
 * open otherwise, the same open geometry the worker draws for its idle toolbar glyph.
 */
import type { SessionSnapshotV2 } from '../../src/shared/types';

const SVG_NS: 'http://www.w3.org/2000/svg' = 'http://www.w3.org/2000/svg';
const TILE_GREEN: string = '#2ebf58';
const RING_DARK: string = '#116331';
const RING_LIGHT: string = '#93f195';
const RING_IDLE: string = '#1f8a41';

/** A session locks sites only while its focus phase runs. Breaks and pauses leave sites open. */
export function isLocked(snapshot: SessionSnapshotV2): boolean {
  return snapshot.lifecycle.kind === 'active' && snapshot.phase === 'focus';
}

function element<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node: SVGElementTagNameMap[K] = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

export function renderBrandIcon(locked: boolean): SVGSVGElement {
  const svg: SVGSVGElement = element('svg', {
    viewBox: '0 0 128 128',
    width: '32',
    height: '32',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  svg.append(
    element('rect', { x: '16', y: '16', width: '96', height: '96', rx: '20', fill: TILE_GREEN }),
  );
  const group: SVGGElement = element('g', {
    transform: 'translate(64 64) scale(0.82) translate(-64 -64)',
  });
  const ring: SVGGElement = element('g', {
    fill: 'none',
    'stroke-width': '7',
    'stroke-linecap': 'round',
  });
  ring.append(
    element('path', {
      d: 'M 96.9 83 A 38 38 0 1 1 60.03 26.21',
      stroke: locked ? RING_DARK : RING_IDLE,
    }),
    element('path', {
      d: 'M 71.9 26.83 A 38 38 0 0 1 101.17 71.9',
      stroke: locked ? RING_LIGHT : RING_IDLE,
    }),
  );
  const shackle: SVGPathElement = element('path', {
    d: 'M 53.5 61 V 53.6 A 10.5 10.5 0 0 1 74.5 53.6 V 61',
    fill: 'none',
    stroke: '#ffffff',
    'stroke-width': '6',
    'stroke-linecap': 'round',
  });
  // Open: pivot the shackle about its right foot and lift it clear of the body, as padlock.svg does.
  if (!locked) shackle.setAttribute('transform', 'rotate(-24 74.5 61) translate(0 -6)');
  const body: SVGRectElement = element('rect', {
    x: '46',
    y: '58.5',
    width: '36',
    height: '29',
    rx: '4',
    fill: '#ffffff',
  });
  const keyhole: SVGCircleElement = element('circle', {
    cx: '64',
    cy: '70',
    r: '3.6',
    fill: TILE_GREEN,
  });
  const keySlot: SVGPathElement = element('path', {
    d: 'M 62.4 71 H 65.6 L 66.2 80 H 61.8 Z',
    fill: TILE_GREEN,
  });
  group.append(ring, shackle, body, keyhole, keySlot);
  svg.append(group);
  return svg;
}
