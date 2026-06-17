import { type AccessAvailability, accessAvailability } from '../shared/budget-display';
import { focusDisplay } from '../shared/focus-display';
import { extrapolatedBank } from '../shared/live';
import type { Ack, Request } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { ackError, isSessionSnapshot } from '../shared/runtime-validation';
import { applyTheme } from '../shared/theme';
import { formatClock } from '../shared/time';
import type { GateKind, GateState, SessionSnapshot, Verdict } from '../shared/types';
import { parseWorkTargetResult, type WorkTargetResult } from '../shared/work-target';
import { createWorkTabPicker, WORK_PICKER_CSS, type WorkTabPicker } from './work-tab-picker';

/** The block overlay. One closed shadow root, rendered from the worker's
 * SessionSnapshot. This module displays state, it never decides it. */

const RING_RADIUS: number = 28;
const RING_CIRCUMFERENCE: number = 2 * Math.PI * RING_RADIUS;
const TICK_MS: number = 250;
const TRANSPORT_ERROR: string = 'Could not reach Focus Lock. Try again.';
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

interface SpendRef {
  button: HTMLButtonElement;
  kind: 'unlockSite' | 'pause';
  text: HTMLSpanElement;
  ready: HTMLSpanElement;
}

interface GateRefs {
  ringFill: SVGCircleElement;
  count: HTMLElement;
  waitWrap: HTMLElement;
  confirm: HTMLButtonElement;
  phrase: HTMLInputElement | null;
}

interface Mounted {
  host: HTMLElement;
  root: ShadowRoot;
  container: HTMLElement;
  timer: number;
  verdict: Verdict;
  snapshot: SessionSnapshot;
  stopped: boolean;
  clock: HTMLElement | null;
  bankLabel: HTMLElement | null;
  meterFill: HTMLElement | null;
  spends: SpendRef[];
  gate: GateRefs | null;
  actionGeneration: number;
  actionError: string | null;
  initialFocus: boolean;
  sessionKey: string | null;
  renderKey: string | null;
  targetGeneration: number;
  target: WorkTargetResult | null;
  targetPending: boolean;
  targetError: string | null;
  picker: WorkTabPicker | null;
}

let mounted: Mounted | null = null;

const SVG_NS: 'http://www.w3.org/2000/svg' = 'http://www.w3.org/2000/svg';

const PADLOCK_PATH: string =
  'M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 ' +
  '2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 1 1 6 0v3H9zm3 4a1.5 1.5 ' +
  '0 0 1 .75 2.8V19a.75.75 0 0 1-1.5 0v-2.2A1.5 1.5 0 0 1 12 14z';

function padlockSvg(): SVGSVGElement {
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

const OVERLAY_CSS: string = `
:host,
:host([data-theme="light"]) {
  color-scheme: light;
  --overlay-bg: #f8fafc;
  --overlay-opaque: #f8fafc;
  --overlay-text: #0f172a;
  --overlay-muted: #475569;
  --overlay-subtle: #64748b;
  --overlay-intention: #1e293b;
  --overlay-meter: rgba(100, 116, 139, 0.25);
  --overlay-pill: rgba(100, 116, 139, 0.14);
  --overlay-pill-hover: rgba(100, 116, 139, 0.22);
  --overlay-bank: #166534;
  --overlay-input-bg: rgba(255, 255, 255, 0.92);
  --overlay-input-border: rgba(71, 85, 105, 0.4);
  --overlay-error-border: #d97706;
  --overlay-error-bg: #fffbeb;
  --overlay-error-text: #78350f;
  --overlay-danger: #a4251b;
  --overlay-danger-soft: #fce8e6;
}
@media (prefers-color-scheme: dark) {
  :host([data-theme="auto"]) {
    color-scheme: dark;
    --overlay-bg: #0f172a;
    --overlay-opaque: #0f172a;
    --overlay-text: #f8fafc;
    --overlay-muted: #94a3b8;
    --overlay-subtle: #94a3b8;
    --overlay-intention: #e2e8f0;
    --overlay-meter: rgba(148, 163, 184, 0.25);
    --overlay-pill: rgba(148, 163, 184, 0.18);
    --overlay-pill-hover: rgba(148, 163, 184, 0.3);
    --overlay-bank: #86efac;
    --overlay-input-bg: rgba(15, 23, 42, 0.6);
    --overlay-input-border: rgba(148, 163, 184, 0.4);
    --overlay-error-border: rgba(251, 191, 36, 0.45);
    --overlay-error-bg: rgba(120, 53, 15, 0.35);
    --overlay-error-text: #fde68a;
    --overlay-danger: #ff8a80;
    --overlay-danger-soft: #3d2422;
  }
}
:host([data-theme="dark"]) {
  color-scheme: dark;
  --overlay-bg: #0f172a;
  --overlay-opaque: #0f172a;
  --overlay-text: #f8fafc;
  --overlay-muted: #94a3b8;
  --overlay-subtle: #94a3b8;
  --overlay-intention: #e2e8f0;
  --overlay-meter: rgba(148, 163, 184, 0.25);
  --overlay-pill: rgba(148, 163, 184, 0.18);
  --overlay-pill-hover: rgba(148, 163, 184, 0.3);
  --overlay-bank: #86efac;
  --overlay-input-bg: rgba(15, 23, 42, 0.6);
  --overlay-input-border: rgba(148, 163, 184, 0.4);
  --overlay-error-border: rgba(251, 191, 36, 0.45);
  --overlay-error-bg: rgba(120, 53, 15, 0.35);
  --overlay-error-text: #fde68a;
  --overlay-danger: #ff8a80;
  --overlay-danger-soft: #3d2422;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
.backdrop {
  position: fixed; inset: 0;
  background: var(--overlay-bg);
  color: var(--overlay-text);
  font-family: system-ui, -apple-system, sans-serif;
  display: flex; align-items: flex-start; justify-content: center;
  overflow-y: auto; overscroll-behavior: contain;
  text-align: center;
}
.backdrop.opaque { background: var(--overlay-opaque); }
.notloaded { font-size: 0.9rem; color: var(--overlay-muted); }
.panel {
  width: 100%; max-width: 480px; padding: 2rem 1.5rem; margin-block: auto;
  display: flex; flex-direction: column; align-items: center; gap: 0.9rem;
}
.padlock { width: 1.5rem; height: 1.5rem; }
.access { width: 100%; margin-top: 1rem; }
summary { cursor: pointer; color: var(--overlay-muted); padding: 0.5rem; }
summary:focus-visible, button:focus-visible, input:focus-visible { outline: 2px solid #22c55e; outline-offset: 4px; }
.access-note, .work-target { font-size: 0.9rem; color: var(--overlay-muted); overflow-wrap: anywhere; }
.access-note { margin-top: 0.8rem; }
.until { font-size: 1rem; color: var(--overlay-muted); }
.clock {
  font-size: 1rem; font-weight: 400; line-height: 1.5; color: var(--overlay-muted);
  font-variant-numeric: tabular-nums; letter-spacing: 0.02em;
}
.intention { font-size: 1.5rem; font-weight: 600; color: var(--overlay-intention); overflow-wrap: anywhere; }
.attempts { font-size: 0.9rem; color: var(--overlay-subtle); }
.meter {
  width: 16rem; height: 0.5rem; border-radius: 999px;
  background: var(--overlay-meter); overflow: hidden;
}
.meter-fill {
  height: 100%; border-radius: 999px; background: #22c55e;
  transition: width ${TICK_MS}ms linear;
}
.bank { font-size: 0.9rem; color: var(--overlay-bank); font-variant-numeric: tabular-nums; }
button { font: inherit; cursor: pointer; border: none; }
button:disabled { cursor: default; }
.buttons {
  display: flex; flex-direction: column; gap: 0.6rem; align-items: center; margin-top: 0.4rem;
}
.pill {
  border-radius: 999px; padding: 0.6rem 1.4rem;
  background: var(--overlay-pill); color: var(--overlay-text); font-size: 1rem;
}
.pill:hover:not(:disabled) { background: var(--overlay-pill-hover); }
.pill:disabled { color: var(--overlay-muted); }
.force-end {
  border: 1px solid var(--overlay-danger); border-radius: 999px; padding: 0.55rem 1.2rem;
  background: var(--overlay-danger-soft); color: var(--overlay-danger); font-size: 0.9rem;
}
.force-end:hover { filter: brightness(0.96); }
.ready { display: block; font-size: 0.75rem; color: var(--overlay-muted); }
.ready[hidden] { display: none; }
.linkish {
  background: none; color: var(--overlay-muted); text-decoration: underline;
  font-size: 0.9rem; padding: 0.4rem;
}
.gate { display: flex; flex-direction: column; align-items: center; gap: 0.9rem; margin-top: 0.4rem; }
.gate-title { font-size: 1.1rem; color: var(--overlay-intention); }
.gate-said { font-size: 1rem; color: var(--overlay-muted); }
.ring-wrap { position: relative; width: 4rem; height: 4rem; }
.ring { transform: rotate(-90deg); }
.ring-track { fill: none; stroke: var(--overlay-meter); stroke-width: 4; }
.ring-fill {
  fill: none; stroke: #22c55e; stroke-width: 4; stroke-linecap: round;
  transition: stroke-dashoffset ${TICK_MS}ms linear;
}
.ring-count {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 1.2rem; font-variant-numeric: tabular-nums; color: var(--overlay-intention);
}
.primary {
  background: #22c55e; color: #052e16; font-weight: 700;
  font-size: 1.25rem; padding: 1rem 2.2rem; border-radius: 999px;
}
.primary:disabled { opacity: 0.55; }
.primary:hover:not(:disabled) { background: #4ade80; }
.phrase-label { font-size: 0.9rem; color: var(--overlay-muted); }
.phrase-text { font-size: 0.95rem; color: var(--overlay-intention); font-style: italic; overflow-wrap: anywhere; }
.phrase {
  font: inherit; padding: 0.5rem 0.8rem; border-radius: 0.5rem;
  border: 1px solid var(--overlay-input-border);
  background: var(--overlay-input-bg); color: var(--overlay-text); width: 22rem; max-width: 90vw;
}
.action-error {
  max-width: 28rem;
  padding: 0.65rem 0.9rem;
  border: 1px solid var(--overlay-error-border);
  border-radius: 0.5rem;
  background: var(--overlay-error-bg);
  color: var(--overlay-error-text);
  font-size: 0.9rem;
}
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.82; } }
@media (prefers-reduced-motion: reduce) {
  .clock { animation: none; }
  .meter-fill, .ring-fill { transition: none; }
}
`;

export function showOverlay(verdict: Verdict, snapshot: SessionSnapshot, stopped?: boolean): void {
  if (mounted === null) mounted = mount();
  applyTheme(mounted.host, snapshot.theme);

  mounted.verdict = verdict;
  mounted.snapshot = snapshot;
  mounted.stopped = stopped ?? false;
  render(mounted);
  focusInitial(mounted);
  refreshWorkTarget();
}

export function updateOverlaySnapshot(snapshot: unknown): void {
  if (mounted === null || !isSessionSnapshot(snapshot)) return;
  if (snapshot.phase === 'idle') hideOverlay(snapshot);
  else showOverlay(mounted.verdict, snapshot, mounted.stopped);
}

export function hideOverlay(_snapshot: SessionSnapshot): void {
  if (mounted === null) return;
  mounted.picker?.close(false);
  window.clearInterval(mounted.timer);
  mounted.host.remove();
  mounted = null;
  if (import.meta.env.MODE === 'test') {
    (globalThis as { __focusLockShadow?: ShadowRoot }).__focusLockShadow = undefined;
  }
}

function mount(): Mounted {
  const host: HTMLElement = document.createElement('focus-lock-overlay');
  applyHostStyle(host);
  const root: ShadowRoot = host.attachShadow({ mode: 'closed' });
  const style: HTMLStyleElement = document.createElement('style');
  style.textContent = OVERLAY_CSS + WORK_PICKER_CSS;
  const container: HTMLElement = document.createElement('div');
  container.className = 'backdrop';
  container.setAttribute('role', 'dialog');
  container.setAttribute('aria-modal', 'true');
  container.setAttribute('aria-label', 'Focus Lock');
  container.tabIndex = -1;
  root.append(style, container);
  trapInteraction(root);
  document.documentElement.appendChild(host);
  const timer: number = window.setInterval(tick, TICK_MS);
  if (import.meta.env.MODE === 'test') {
    (globalThis as { __focusLockShadow?: ShadowRoot }).__focusLockShadow = root;
  }
  return {
    host,
    root,
    container,
    timer,
    verdict: { blocked: true, reason: 'default', matchedPattern: null },
    snapshot: null as unknown as SessionSnapshot, // overwritten by showOverlay before any render
    stopped: false,
    clock: null,
    bankLabel: null,
    meterFill: null,
    spends: [],
    gate: null,
    actionGeneration: 0,
    actionError: null,
    initialFocus: true,
    sessionKey: null,
    renderKey: null,
    targetGeneration: 0,
    target: null,
    targetPending: true,
    targetError: null,
    picker: null,
  };
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

function trapInteraction(root: ShadowRoot): void {
  const stopOutsideScroll: (event: Event) => void = (event: Event): void => {
    const path: EventTarget[] = event.composedPath();
    if (
      !path.some(
        (target: EventTarget): boolean =>
          target instanceof Element && target.classList.contains('backdrop'),
      )
    )
      event.preventDefault();
  };
  root.addEventListener('wheel', stopOutsideScroll, { passive: false });
  root.addEventListener('touchmove', stopOutsideScroll, { passive: false });
  root.addEventListener('pointerdown', (): void => {
    if (mounted !== null) mounted.initialFocus = false;
  });
  root.addEventListener('keydown', (event: Event): void => {
    if (mounted !== null) mounted.initialFocus = false;
    const ev: KeyboardEvent = event as KeyboardEvent;
    if (ev.defaultPrevented) return;
    if (ev.key === 'Escape' && mounted?.picker !== null) {
      mounted?.picker?.close();
      ev.preventDefault();
      return;
    }
    if (ev.key !== 'Tab') {
      if (shouldPreventKeyboardScroll(ev)) {
        ev.preventDefault();
        const container: HTMLElement | null = root.querySelector('.backdrop');
        if (container !== null) {
          const step: number =
            ev.key === 'PageDown' || ev.key === 'PageUp' || ev.key === ' '
              ? container.clientHeight * 0.8
              : 40;
          if (ev.key === 'Home') container.scrollTop = 0;
          else if (ev.key === 'End') container.scrollTop = container.scrollHeight;
          else container.scrollTop += (ev.key === 'ArrowUp' || ev.key === 'PageUp' ? -1 : 1) * step;
        }
      }
      return;
    }
    const focusables: HTMLElement[] = Array.from(
      root.querySelectorAll<HTMLElement>('button:not([disabled]):not([hidden]), input, summary'),
    ).filter((element: HTMLElement): boolean => {
      const details: HTMLDetailsElement | null = element.closest('details');
      return details === null || details.open || element.tagName === 'SUMMARY';
    });
    if (focusables.length === 0) {
      ev.preventDefault();
      root.querySelector<HTMLElement>('[role="dialog"]')?.focus();
      return;
    }
    const first: HTMLElement = focusables[0] as HTMLElement;
    const last: HTMLElement = focusables[focusables.length - 1] as HTMLElement;
    const active: Element | null = root.activeElement;
    if (
      ev.shiftKey &&
      (active === first || active === null || active.getAttribute('role') === 'dialog')
    ) {
      ev.preventDefault();
      last.focus();
    } else if (
      !ev.shiftKey &&
      (active === last || active === null || active.getAttribute('role') === 'dialog')
    ) {
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
  return !(space && effectiveTarget.closest('button, summary') !== null);
}

function focusInitial(m: Mounted): void {
  if (m.root.activeElement !== null) return;
  const target: HTMLElement | null = m.root.querySelector<HTMLElement>(
    '.return-work:not([disabled])',
  );
  (target ?? m.container).focus();
}

function render(m: Mounted): void {
  const now: number = Date.now();
  const snap: SessionSnapshot = m.snapshot;
  const sessionKey: string = JSON.stringify([snap.startedAt, snap.sessionEndsAt]);
  const key: string = JSON.stringify([
    sessionKey,
    snap.gate?.kind,
    snap.gate?.openedAt,
    snap.gate?.host,
    snap.gate?.requiredPhrase,
  ]);
  m.container.className = 'backdrop opaque';
  if (m.renderKey === key) {
    updateStatic(m);
    tick();
    return;
  }
  const sameSession: boolean = m.sessionKey === sessionKey;
  m.sessionKey = sessionKey;
  const open: boolean = sameSession && (m.root.querySelector('details')?.open ?? false);
  if (!sameSession) {
    m.target = null;
    m.targetPending = true;
    m.targetError = null;
    m.actionError = null;
  }
  m.picker?.close(false);
  m.renderKey = key;
  m.actionGeneration += 1;
  m.spends = [];
  m.gate = null;
  const panel: HTMLElement = document.createElement('div');
  panel.className = 'panel';
  panel.appendChild(padlockSvg());
  const heading: HTMLElement = document.createElement('p');
  heading.className = 'until';
  heading.textContent = 'Your next step';
  const intention: HTMLElement = document.createElement('h1');
  intention.className = 'intention';
  panel.append(heading, intention);
  m.clock = document.createElement('p');
  m.clock.className = 'clock';
  panel.append(m.clock);
  const progress: HTMLElement = document.createElement('div');
  progress.className = 'meter';
  m.meterFill = document.createElement('div');
  m.meterFill.className = 'meter-fill';
  progress.append(m.meterFill);
  panel.append(progress);
  const primary: HTMLButtonElement = document.createElement('button');
  primary.type = 'button';
  primary.className = 'primary return-work';
  primary.addEventListener('click', (): void => {
    if (m.target?.ok && m.target.state === 'ready' && m.target.sessionId !== null)
      void returnToWork(m, m.target.sessionId);
    else if (m.target?.ok && m.target.sessionId !== null) openWorkPicker(m, primary);
    else {
      m.actionGeneration += 1;
      void loadWorkTarget(m, primary);
    }
  });
  const title: HTMLElement = document.createElement('p');
  title.className = 'work-target';
  const change: HTMLButtonElement = document.createElement('button');
  change.type = 'button';
  change.className = 'change-work';
  change.textContent = 'Change work tab';
  change.addEventListener('click', (): void => openWorkPicker(m, change));
  panel.append(primary, title, change);
  appendNotLoaded(panel);
  const details: HTMLDetailsElement = document.createElement('details');
  details.className = 'access';
  details.open = snap.gate !== null || open;
  const summary: HTMLElement = document.createElement('summary');
  summary.textContent = 'Need a break or site access?';
  details.append(summary);
  m.bankLabel = document.createElement('p');
  m.bankLabel.className = 'bank';
  details.append(m.bankLabel);
  if (snap.gate === null) details.appendChild(buildButtons(m, snap, now));
  else details.appendChild(buildGate(m, snap.gate, snap, now));
  const note: HTMLElement = document.createElement('p');
  note.className = 'access-note';
  note.textContent = 'You can step away at any time. Site access uses credit.';
  details.append(note);
  panel.append(details);
  if (m.actionError !== null) panel.appendChild(actionErrorElement(m.actionError));
  m.container.replaceChildren(panel);
  updateStatic(m);
  tick();
}

function updateStatic(m: Mounted): void {
  const intention: HTMLElement | null = m.root.querySelector('.intention');
  if (intention !== null)
    intention.textContent = m.snapshot.config?.intention.trim() || 'Continue your current task';
  const stopped: HTMLElement | null = m.root.querySelector('.notloaded');
  if (stopped !== null) stopped.hidden = !m.stopped;
  const cancel: HTMLElement | null = m.root.querySelector('.linkish');
  if (cancel !== null) cancel.hidden = m.snapshot.config?.strictness !== 'friction';
  const gateTitleElement: HTMLElement | null = m.root.querySelector('.gate-title');
  if (gateTitleElement !== null && m.snapshot.gate !== null)
    gateTitleElement.textContent = gateTitle(m.snapshot.gate, m.snapshot);
  const forceEnd: HTMLElement | null = m.root.querySelector('.force-end');
  if (forceEnd !== null) forceEnd.hidden = !m.snapshot.gate?.forceEndAvailable;
  updateTarget(m);
}

function updateTarget(m: Mounted): void {
  const button: HTMLButtonElement | null = m.root.querySelector('.return-work');
  const title: HTMLElement | null = m.root.querySelector('.work-target');
  const ready: boolean = m.target?.ok === true && m.target.state === 'ready';
  if (button !== null) {
    button.textContent = ready ? 'Back to work' : 'Choose a work tab';
    button.disabled = m.targetPending && !(m.target?.ok && m.target.sessionId !== null);
    button.setAttribute('aria-busy', String(m.targetPending));
    if (ready && m.initialFocus && m.root.activeElement === m.container) button.focus();
  }
  if (title !== null)
    title.textContent =
      ready && m.target?.ok
        ? m.target.title
        : m.targetPending
          ? 'Checking available work tabs...'
          : (m.targetError ??
            (m.target?.ok && m.target.sessionId !== null
              ? 'Pick an open tab to continue your task.'
              : 'Your focus session is not available. Try again, or reload this page.'));
  const change: HTMLElement | null = m.root.querySelector('.change-work');
  if (change !== null) {
    if (!ready && m.root.activeElement === change)
      (button !== null && !button.disabled ? button : m.container).focus({ preventScroll: true });
    change.hidden = !ready;
  }
}

export function refreshWorkTarget(): void {
  if (mounted !== null) void loadWorkTarget(mounted);
}

async function loadWorkTarget(mount: Mounted, trigger: HTMLElement | null = null): Promise<void> {
  const generation: number = ++mount.targetGeneration;
  const action: number = mount.actionGeneration;
  const scrollTop: number = mount.container.scrollTop;
  const active: Element | null = mount.root.activeElement;
  const restoreTarget: HTMLButtonElement | null =
    active instanceof HTMLButtonElement &&
    (active === trigger ||
      (active.classList.contains('return-work') &&
        !(mount.target?.ok && mount.target.sessionId !== null)))
      ? active
      : null;
  if (restoreTarget !== null) mount.container.focus({ preventScroll: true });
  mount.targetPending = true;
  updateTarget(mount);
  let target: WorkTargetResult | null = null;
  let error: string | null = null;
  try {
    target = parseWorkTargetResult(await sendRequest({ type: 'getWorkTarget' }));
    if (!target?.ok) error = workTargetLookupError(target?.error);
  } catch (cause: unknown) {
    error = workTargetLookupError(cause instanceof Error ? cause.message : undefined);
  }
  if (mounted !== mount || generation !== mount.targetGeneration) return;
  const closePicker: boolean =
    mount.target?.ok === true && (!target?.ok || target.sessionId !== mount.target.sessionId);
  mount.target = target;
  mount.targetPending = false;
  mount.targetError = error;
  updateTarget(mount);
  if (closePicker && mount.picker !== null)
    mount.picker.close(mount.picker.element.contains(mount.root.activeElement));
  if (!isCurrentAction(mount, action)) return;
  if (restoreTarget !== null && mount.root.activeElement === mount.container)
    restoreTarget.focus({ preventScroll: true });
  if (trigger === null) return;
  mount.container.scrollTop = scrollTop;
  if (target?.ok && target.sessionId !== null) openWorkPicker(mount, trigger);
}

function workTargetLookupError(error: string | undefined): string {
  if (error === 'The requesting page has changed. Reload the page.') return error;
  if (error?.includes('Extension context invalidated'))
    return 'Reload this page to reconnect to Focus Lock.';
  return 'Could not load your work tab. Try again, or reload this page.';
}

function openWorkPicker(m: Mounted, trigger: HTMLElement): void {
  const sessionId: string | null = m.target?.ok ? m.target.sessionId : null;
  if (sessionId === null) return;
  if (m.picker !== null) {
    m.picker.close();
    return;
  }
  m.actionGeneration += 1;
  clearActionError(m);
  m.picker = createWorkTabPicker(
    sessionId,
    trigger,
    m.container,
    (tabId: number): Promise<string | null> => selectWorkTab(m, sessionId, tabId),
    (): void => {
      m.picker = null;
      m.root.querySelector('.panel')?.classList.remove('panel-picker');
      m.actionGeneration += 1;
    },
  );
  m.root.querySelector('.panel')?.classList.add('panel-picker');
  m.root.querySelector('.change-work')?.after(m.picker.element);
  m.picker.element
    .querySelector<HTMLInputElement>('.work-picker-search')
    ?.focus({ preventScroll: true });
}

async function selectWorkTab(m: Mounted, sessionId: string, tabId: number): Promise<string | null> {
  const generation: number = ++m.actionGeneration;
  let error: string | null;
  try {
    error = ackError(
      await sendRequest({ type: 'setWorkTarget', sessionId, tabId }),
      TRANSPORT_ERROR,
    );
  } catch {
    error = TRANSPORT_ERROR;
  }
  if (!isCurrentAction(m, generation)) return null;
  if (error !== null) return error;
  m.picker?.close();
  await returnToWork(m, sessionId);
  return null;
}

async function returnToWork(m: Mounted, sessionId: string): Promise<void> {
  const generation: number = ++m.actionGeneration;
  clearActionError(m);
  let error: string | null;
  try {
    error = ackError(await sendRequest({ type: 'returnToWork', sessionId }), TRANSPORT_ERROR);
  } catch {
    error = TRANSPORT_ERROR;
  }
  if (!isCurrentAction(m, generation)) return;
  if (error !== null) showActionError(m, error);
  try {
    const snapshot: unknown = await sendRequest({ type: 'getSnapshot' });
    if (!isCurrentAction(m, generation)) return;
    if (!isSessionSnapshot(snapshot)) {
      if (error === null) showActionError(m, TRANSPORT_ERROR);
      refreshWorkTarget();
      return;
    }
    updateOverlaySnapshot(snapshot);
    if (mounted === m && error !== null) showActionError(m, error);
  } catch {
    if (!isCurrentAction(m, generation)) return;
    if (error === null) showActionError(m, TRANSPORT_ERROR);
    refreshWorkTarget();
  }
}

function appendNotLoaded(panel: HTMLElement): void {
  const el: HTMLElement = document.createElement('div');
  el.className = 'notloaded';
  el.textContent = 'This page did not load. It will load by itself when the session ends.';
  panel.appendChild(el);
}

function updateBank(m: Mounted, snap: SessionSnapshot, now: number): void {
  const bank: number = extrapolatedBank(snap, now);
  if (m.meterFill !== null) m.meterFill.style.width = `${focusDisplay(snap, now).progress * 100}%`;
  if (m.bankLabel !== null) m.bankLabel.textContent = `${formatClock(bank)} site access credit`;
}

function buildButtons(m: Mounted, snap: SessionSnapshot, now: number): HTMLElement {
  const row: HTMLElement = document.createElement('div');
  row.className = 'buttons';
  const unlock: SpendRef = spendButton('unlockSite', (): void =>
    requestOpenGate('unlockSite', location.hostname),
  );
  const pause: SpendRef = spendButton('pause', (): void => requestOpenGate('pause', null));
  m.spends = [unlock, pause];
  row.append(unlock.button, pause.button);
  {
    const cancel: HTMLButtonElement = document.createElement('button');
    cancel.className = 'linkish';
    cancel.type = 'button';
    cancel.textContent = 'End session';
    cancel.addEventListener('click', (): void => requestOpenGate('cancel', null));
    row.appendChild(cancel);
  }
  for (const ref of m.spends) updateSpend(ref, snap, now);
  return row;
}

function spendButton(kind: 'unlockSite' | 'pause', onClick: () => void): SpendRef {
  const button: HTMLButtonElement = document.createElement('button');
  button.className = 'pill';
  button.type = 'button';
  const text: HTMLSpanElement = document.createElement('span');
  const ready: HTMLSpanElement = document.createElement('span');
  ready.className = 'ready';
  ready.hidden = true;
  button.append(text, ready);
  button.addEventListener('click', onClick);
  return { button, kind, text, ready };
}

function updateSpend(ref: SpendRef, snap: SessionSnapshot, now: number): void {
  const costMs: number = ref.kind === 'unlockSite' ? snap.unlockCostMs : snap.pauseCostMs;
  const label: string = ref.kind === 'unlockSite' ? 'Unlock this site' : 'Unlock all sites';
  ref.text.textContent = `${label} ${formatClock(costMs)} - costs ${formatClock(costMs)} credit`;
  const availability: AccessAvailability = accessAvailability(snap, now, costMs);
  ref.button.disabled = !availability.affordable;
  ref.ready.hidden = availability.message === null;
  ref.ready.textContent = availability.message;
}

function gateTitle(gate: GateState, snap: SessionSnapshot): string {
  if (gate.kind === 'pause')
    return `Unlock all sites ${formatClock(snap.pauseCostMs)} - costs ${formatClock(snap.pauseCostMs)} credit`;
  if (gate.kind === 'unlockSite') {
    return `Unlock ${gate.host ?? 'this site'} ${formatClock(snap.unlockCostMs)}`;
  }
  return 'End this session';
}

function gateConfirmLabel(kind: GateKind): string {
  if (kind === 'pause') return 'Unlock all sites';
  if (kind === 'unlockSite') return 'Unlock this site';
  return 'End the session';
}

function buildGate(m: Mounted, gate: GateState, snap: SessionSnapshot, now: number): HTMLElement {
  const wrap: HTMLElement = document.createElement('div');
  wrap.className = 'gate';
  const keep: HTMLButtonElement = document.createElement('button');
  keep.type = 'button';
  keep.className = 'keep-focusing pill';
  keep.textContent = 'Keep focusing';
  keep.addEventListener('click', (): void => {
    void sendAndRefresh({ type: 'abandonGate' });
  });
  wrap.append(keep);
  const title: HTMLElement = document.createElement('div');
  title.className = 'gate-title';
  title.textContent = gateTitle(gate, snap);
  wrap.appendChild(title);
  const intention: string = snap.config?.intention.trim() ?? '';
  if (intention !== '') {
    const said: HTMLElement = document.createElement('div');
    said.className = 'gate-said';
    said.textContent = `You said: ${intention}`;
    wrap.appendChild(said);
  }
  const {
    waitWrap,
    ringFill,
    count,
  }: { waitWrap: HTMLElement; ringFill: SVGCircleElement; count: HTMLElement } = buildRing();
  wrap.appendChild(waitWrap);
  const phrase: HTMLInputElement | null = appendPhrase(wrap, gate);
  const confirm: HTMLButtonElement = document.createElement('button');
  confirm.className = 'pill';
  confirm.type = 'button';
  confirm.textContent = gateConfirmLabel(gate.kind);
  confirm.hidden = true;
  confirm.addEventListener('click', (): void => requestConfirmGate(phrase?.value ?? null));
  wrap.appendChild(confirm);
  {
    const forceEnd: HTMLButtonElement = document.createElement('button');
    forceEnd.className = 'force-end';
    forceEnd.type = 'button';
    forceEnd.textContent = 'Ignore timeout and end anyway';
    forceEnd.addEventListener('click', (): void => requestForceEndGate());
    wrap.appendChild(forceEnd);
  }
  m.gate = { ringFill, count, waitWrap, confirm, phrase };
  updateGate(m, snap, now);
  return wrap;
}

function buildRing(): { waitWrap: HTMLElement; ringFill: SVGCircleElement; count: HTMLElement } {
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

function appendPhrase(wrap: HTMLElement, gate: GateState): HTMLInputElement | null {
  if (gate.requiredPhrase === null) return null;
  const label: HTMLElement = document.createElement('div');
  label.className = 'phrase-label';
  label.textContent = 'Type this to confirm:';
  const text: HTMLElement = document.createElement('div');
  text.className = 'phrase-text';
  text.textContent = gate.requiredPhrase;
  const input: HTMLInputElement = document.createElement('input');
  input.className = 'phrase';
  input.type = 'text';
  input.setAttribute('aria-label', 'Confirmation phrase');
  input.addEventListener('input', (): void => {
    if (mounted !== null) updateGate(mounted, mounted.snapshot, Date.now());
  });
  wrap.append(label, text, input);
  return input;
}

function updateGate(m: Mounted, snap: SessionSnapshot, now: number): void {
  const refs: GateRefs | null = m.gate;
  const gate: GateState | null = snap.gate;
  if (refs === null || gate === null) return;
  const span: number = gate.readyAt - gate.openedAt;
  const progress: number = span <= 0 ? 1 : Math.min(1, Math.max(0, (now - gate.openedAt) / span));
  refs.ringFill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));
  const leftS: number = Math.max(0, Math.ceil((gate.readyAt - now) / 1000));
  refs.count.textContent = String(leftS);
  const ready: boolean = now >= gate.readyAt;
  refs.waitWrap.hidden = ready;
  refs.confirm.hidden = !ready;
  const phraseOk: boolean =
    gate.requiredPhrase === null ||
    (refs.phrase !== null && refs.phrase.value === gate.requiredPhrase);
  refs.confirm.disabled = !(ready && phraseOk);
}

function tick(): void {
  if (mounted === null) return;
  const now: number = Date.now();
  const snap: SessionSnapshot = mounted.snapshot;
  if (mounted.clock !== null) {
    mounted.clock.textContent = focusDisplay(snap, now).text;
  }
  updateBank(mounted, snap, now);
  for (const ref of mounted.spends) updateSpend(ref, snap, now);
  updateGate(mounted, snap, now);
}

function requestOpenGate(kind: GateKind, host: string | null): void {
  void sendAndRefresh({ type: 'openGate', gate: kind, host });
}

function requestConfirmGate(typedPhrase: string | null): void {
  void sendAndRefresh({ type: 'confirmGate', typedPhrase });
}

function requestForceEndGate(): void {
  void sendAndRefresh({ type: 'forceEndGate' });
}

async function sendAndRefresh(
  req: Extract<Request, { type: 'openGate' | 'confirmGate' | 'forceEndGate' | 'abandonGate' }>,
): Promise<void> {
  const mount: Mounted | null = mounted;
  if (mount === null) return;
  const generation: number = mount.actionGeneration + 1;
  mount.actionGeneration = generation;
  clearActionError(mount);
  try {
    const ack: Ack = await sendRequest(req);
    if (!isCurrentAction(mount, generation)) return;
    if (!ack.ok) {
      showActionError(mount, ack.error);
      return;
    }
    const snapshot: SessionSnapshot = await sendRequest({ type: 'getSnapshot' });
    if (!isCurrentAction(mount, generation)) return;
    if (!isSessionSnapshot(snapshot)) {
      showActionError(mount, TRANSPORT_ERROR);
      return;
    }
    showOverlay(mount.verdict, snapshot, mount.stopped);
  } catch {
    if (isCurrentAction(mount, generation)) showActionError(mount, TRANSPORT_ERROR);
  }
}

function isCurrentAction(mount: Mounted, generation: number): boolean {
  return mounted === mount && mount.actionGeneration === generation;
}

function clearActionError(mount: Mounted): void {
  mount.actionError = null;
  mount.root.querySelector('.action-error')?.remove();
}

function showActionError(mount: Mounted, message: string): void {
  clearActionError(mount);
  mount.actionError = message;
  mount.container.querySelector('.panel')?.appendChild(actionErrorElement(message));
}

function actionErrorElement(message: string): HTMLElement {
  const alert: HTMLElement = document.createElement('div');
  alert.className = 'action-error';
  alert.setAttribute('role', 'alert');
  alert.textContent = message;
  return alert;
}
