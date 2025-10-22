/**
 * The shared blocked-page shell: one closed shadow host carrying the overlay styles, a dialog
 * backdrop, the interaction trap, initial focus, and the two SVG figures both renderers draw.
 *
 * This is a leaf on purpose. The v1 snapshot renderer and the v2 `DocumentOverlayView` renderer
 * both mount through here, so retiring v1 at the cutover removes a renderer and leaves the shell
 * and its tests standing. Nothing here reads session state, a verdict, or a view.
 */

import { OVERLAY_STYLES } from './overlay-styles';

const RING_RADIUS: number = 28;
export const RING_CIRCUMFERENCE: number = 2 * Math.PI * RING_RADIUS;

const SCROLL_KEYS: ReadonlySet<string> = new Set<string>([
  ' ',
  'Spacebar',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);
const RANGE_KEYS: ReadonlySet<string> = new Set<string>([
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

export interface OverlayHostElements {
  host: HTMLElement;
  root: ShadowRoot;
  container: HTMLElement;
}

const SVG_NS: 'http://www.w3.org/2000/svg' = 'http://www.w3.org/2000/svg';

const PADLOCK_PATH: string =
  'M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 ' +
  '2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 1 1 6 0v3H9zm3 4a1.5 1.5 ' +
  '0 0 1 .75 2.8V19a.75.75 0 0 1-1.5 0v-2.2A1.5 1.5 0 0 1 12 14z';

export function padlockSvg(): SVGSVGElement {
  const svg: SVGSVGElement = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'padlock');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', '#22c55e');
  svg.setAttribute('fill-rule', 'evenodd');
  svg.setAttribute('aria-hidden', 'true');
  const path: SVGPathElement = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', PADLOCK_PATH);
  svg.appendChild(path);
  return svg;
}

/** The shared closed-shadow host: overlay styles, dialog backdrop, and interaction trap. */
export function mountOverlayHost(): OverlayHostElements {
  const host: HTMLElement = document.createElement('focus-lock-overlay');
  applyHostStyle(host);
  const root: ShadowRoot = host.attachShadow({ mode: 'closed' });
  const style: HTMLStyleElement = document.createElement('style');
  style.textContent = OVERLAY_STYLES;
  const container: HTMLElement = document.createElement('div');
  container.className = 'backdrop';
  container.setAttribute('role', 'dialog');
  container.setAttribute('aria-modal', 'true');
  container.setAttribute('aria-label', 'Focus Lock');
  container.tabIndex = -1;
  root.append(style, container);
  trapInteraction(host, root);
  document.documentElement.appendChild(host);
  if (import.meta.env.MODE === 'test') {
    (globalThis as { __focusLockShadow?: ShadowRoot }).__focusLockShadow = root;
  }
  return { host, root, container };
}

/** Removes a mounted host and drops the closed-root handle the tests read. */
export function unmountOverlayHost(host: HTMLElement): void {
  host.remove();
  if (import.meta.env.MODE === 'test') {
    (globalThis as { __focusLockShadow?: ShadowRoot }).__focusLockShadow = undefined;
  }
}

function applyHostStyle(host: HTMLElement): void {
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('inset', '0', 'important');
  host.style.setProperty('z-index', '2147483647', 'important');
  host.style.setProperty('display', 'block', 'important');
  host.style.setProperty('direction', 'ltr', 'important');
  host.style.setProperty('unicode-bidi', 'isolate', 'important');
}

function trapInteraction(host: HTMLElement, root: ShadowRoot): void {
  host.addEventListener('wheel', (ev: WheelEvent): void => ev.preventDefault(), {
    passive: false,
  });
  host.addEventListener('touchmove', (ev: TouchEvent): void => ev.preventDefault(), {
    passive: false,
  });
  root.addEventListener('keydown', (event: Event): void => {
    const ev: KeyboardEvent = event as KeyboardEvent;
    if (ev.key !== 'Tab') {
      if (shouldPreventKeyboardScroll(ev)) ev.preventDefault();
      return;
    }
    const focusables: HTMLElement[] = Array.from(
      root.querySelectorAll<HTMLElement>('button:not([disabled]):not([hidden]), input'),
    );
    if (focusables.length === 0) {
      ev.preventDefault();
      root.querySelector<HTMLElement>('[role="dialog"]')?.focus();
      return;
    }
    const first: HTMLElement = focusables[0] as HTMLElement;
    const last: HTMLElement = focusables[focusables.length - 1] as HTMLElement;
    const active: Element | null = root.activeElement;
    if (ev.shiftKey && (active === first || active === null)) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && (active === last || active === null)) {
      ev.preventDefault();
      first.focus();
    }
  });
}

function shouldPreventKeyboardScroll(event: KeyboardEvent): boolean {
  if (!SCROLL_KEYS.has(event.key)) return false;
  const path: EventTarget[] = event.composedPath();
  const effectiveTarget: EventTarget | null = path[0] ?? event.target;
  if (!(effectiveTarget instanceof Element)) return true;
  const editable: Element | null = effectiveTarget.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
  );
  if (editable instanceof HTMLInputElement) {
    if (editable.type === 'range') return !RANGE_KEYS.has(event.key);
    return event.key === 'PageUp' || event.key === 'PageDown';
  }
  if (editable instanceof HTMLSelectElement) return false;
  if (editable !== null) return event.key === 'PageUp' || event.key === 'PageDown';
  const space: boolean = event.key === ' ' || event.key === 'Spacebar';
  return !(space && effectiveTarget.closest('button') !== null);
}

/** Focuses the first enabled control, or the dialog itself when a page has none. */
export function focusInitialControl(root: ShadowRoot, fallback: HTMLElement): void {
  if (root.activeElement !== null) return;
  const target: HTMLElement | null = root.querySelector<HTMLElement>(
    'button:not([disabled]):not([hidden])',
  );
  (target ?? fallback).focus();
}

/** The gate countdown ring. Both renderers read the same stroke geometry from the shared CSS. */
export function buildRing(): {
  waitWrap: HTMLElement;
  ringFill: SVGCircleElement;
  count: HTMLElement;
} {
  const waitWrap: HTMLElement = document.createElement('div');
  waitWrap.className = 'ring-wrap';
  const svg: SVGSVGElement = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ring');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('width', '64');
  svg.setAttribute('height', '64');
  const track: SVGCircleElement = document.createElementNS(SVG_NS, 'circle');
  track.setAttribute('class', 'ring-track');
  const ringFill: SVGCircleElement = document.createElementNS(SVG_NS, 'circle');
  ringFill.setAttribute('class', 'ring-fill');
  for (const circle of [track, ringFill]) {
    circle.setAttribute('cx', '32');
    circle.setAttribute('cy', '32');
    circle.setAttribute('r', String(RING_RADIUS));
  }
  ringFill.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
  ringFill.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));
  svg.append(track, ringFill);
  const count: HTMLElement = document.createElement('div');
  count.className = 'ring-count';
  waitWrap.append(svg, count);
  return { waitWrap, ringFill, count };
}
