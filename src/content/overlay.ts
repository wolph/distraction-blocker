import { msUntilNextEarnedMinute } from '../core/budget';
import { extrapolatedBank, remainingPhaseMs } from '../shared/live';
import type { Request } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { formatClock } from '../shared/time';
import type { GateKind, GateState, SessionSnapshot, Verdict } from '../shared/types';

/** The block overlay. One closed shadow root, rendered from the worker's
 * SessionSnapshot. This module displays state, it never decides it. */

const RING_RADIUS: number = 28;
const RING_CIRCUMFERENCE: number = 2 * Math.PI * RING_RADIUS;
const TICK_MS: number = 250;

interface SpendRef {
  button: HTMLButtonElement;
  costMs: number;
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
* { margin: 0; padding: 0; box-sizing: border-box; }
.backdrop {
  position: fixed; inset: 0;
  background: rgba(15, 23, 42, 0.97);
  color: #f8fafc;
  font-family: system-ui, -apple-system, sans-serif;
  display: flex; align-items: center; justify-content: center;
  text-align: center;
}
.backdrop.opaque { background: #0f172a; }
.notloaded { font-size: 0.9rem; color: #94a3b8; }
.panel {
  max-width: 40rem; padding: 2rem;
  display: flex; flex-direction: column; align-items: center; gap: 0.9rem;
}
.padlock { width: 3.5rem; height: 3.5rem; }
.until { font-size: 1rem; color: #94a3b8; }
.clock {
  font-size: 4.5rem; font-weight: 700; line-height: 1;
  font-variant-numeric: tabular-nums; letter-spacing: 0.02em;
  animation: pulse 2.4s ease-in-out infinite;
}
.intention { font-size: 1.5rem; font-weight: 600; color: #e2e8f0; overflow-wrap: anywhere; }
.attempts { font-size: 0.9rem; color: #64748b; }
.meter {
  width: 16rem; height: 0.5rem; border-radius: 999px;
  background: rgba(148, 163, 184, 0.25); overflow: hidden;
}
.meter-fill {
  height: 100%; border-radius: 999px; background: #22c55e;
  transition: width ${TICK_MS}ms linear;
}
.bank { font-size: 0.9rem; color: #86efac; font-variant-numeric: tabular-nums; }
button { font: inherit; cursor: pointer; border: none; }
button:disabled { cursor: default; }
.buttons {
  display: flex; flex-direction: column; gap: 0.6rem; align-items: center; margin-top: 0.4rem;
}
.pill {
  border-radius: 999px; padding: 0.6rem 1.4rem;
  background: rgba(148, 163, 184, 0.18); color: #f8fafc; font-size: 1rem;
}
.pill:hover:not(:disabled) { background: rgba(148, 163, 184, 0.3); }
.pill:disabled { opacity: 0.55; }
.ready { display: block; font-size: 0.75rem; color: #94a3b8; }
.ready[hidden] { display: none; }
.linkish {
  background: none; color: #94a3b8; text-decoration: underline;
  font-size: 0.9rem; padding: 0.4rem;
}
.gate { display: flex; flex-direction: column; align-items: center; gap: 0.9rem; margin-top: 0.4rem; }
.gate-title { font-size: 1.1rem; color: #e2e8f0; }
.gate-said { font-size: 1rem; color: #94a3b8; }
.ring-wrap { position: relative; width: 4rem; height: 4rem; }
.ring { transform: rotate(-90deg); }
.ring-track { fill: none; stroke: rgba(148, 163, 184, 0.25); stroke-width: 4; }
.ring-fill {
  fill: none; stroke: #22c55e; stroke-width: 4; stroke-linecap: round;
  transition: stroke-dashoffset ${TICK_MS}ms linear;
}
.ring-count {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 1.2rem; font-variant-numeric: tabular-nums; color: #e2e8f0;
}
.primary {
  background: #22c55e; color: #052e16; font-weight: 700;
  font-size: 1.25rem; padding: 1rem 2.2rem; border-radius: 999px;
}
.primary:hover { background: #4ade80; }
.phrase-label { font-size: 0.9rem; color: #94a3b8; }
.phrase-text { font-size: 0.95rem; color: #e2e8f0; font-style: italic; overflow-wrap: anywhere; }
.phrase {
  font: inherit; padding: 0.5rem 0.8rem; border-radius: 0.5rem;
  border: 1px solid rgba(148, 163, 184, 0.4);
  background: rgba(15, 23, 42, 0.6); color: #f8fafc; width: 22rem; max-width: 90vw;
}
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.82; } }
@media (prefers-reduced-motion: reduce) {
  .clock { animation: none; }
  .meter-fill, .ring-fill { transition: none; }
}
`;

export function showOverlay(verdict: Verdict, snapshot: SessionSnapshot, stopped?: boolean): void {
  if (mounted === null) mounted = mount();
  mounted.verdict = verdict;
  mounted.snapshot = snapshot;
  mounted.stopped = stopped ?? false;
  render(mounted);
  focusInitial(mounted);
}

export function hideOverlay(_snapshot: SessionSnapshot): void {
  if (mounted === null) return;
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
  style.textContent = OVERLAY_CSS;
  const container: HTMLElement = document.createElement('div');
  container.className = 'backdrop';
  container.setAttribute('role', 'dialog');
  container.setAttribute('aria-modal', 'true');
  container.setAttribute('aria-label', 'Focus Lock');
  container.tabIndex = -1;
  root.append(style, container);
  trapInteraction(host, root);
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

function trapInteraction(host: HTMLElement, root: ShadowRoot): void {
  host.addEventListener('wheel', (ev: WheelEvent): void => ev.preventDefault(), {
    passive: false,
  });
  host.addEventListener('touchmove', (ev: TouchEvent): void => ev.preventDefault(), {
    passive: false,
  });
  host.addEventListener('keydown', (ev: KeyboardEvent): void => {
    if (ev.key !== 'Tab') return;
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

function focusInitial(m: Mounted): void {
  if (m.root.activeElement !== null) return;
  const target: HTMLElement | null = m.root.querySelector<HTMLElement>(
    'button:not([disabled]):not([hidden])',
  );
  (target ?? m.container).focus();
}

function render(m: Mounted): void {
  const now: number = Date.now();
  const snap: SessionSnapshot = m.snapshot;
  m.spends = [];
  m.gate = null;
  m.container.className = m.stopped ? 'backdrop opaque' : 'backdrop';
  const panel: HTMLElement = document.createElement('div');
  panel.className = 'panel';
  panel.appendChild(padlockSvg());
  appendLockedUntil(panel, snap);
  m.clock = appendClock(panel, snap, now);
  appendIntention(panel, snap);
  appendAttempts(panel, snap);
  if (m.stopped) appendNotLoaded(panel);
  appendBank(m, panel, snap, now);
  if (snap.gate === null) panel.appendChild(buildButtons(m, snap, now));
  else panel.appendChild(buildGate(m, snap.gate, snap, now));
  m.container.replaceChildren(panel);
}

function appendLockedUntil(panel: HTMLElement, snap: SessionSnapshot): void {
  if (snap.sessionEndsAt === null) return;
  const el: HTMLElement = document.createElement('div');
  el.className = 'until';
  el.textContent = `Locked until ${formatWallClock(snap.sessionEndsAt)}`;
  panel.appendChild(el);
}

function formatWallClock(at: number): string {
  const d: Date = new Date(at);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function appendClock(panel: HTMLElement, snap: SessionSnapshot, now: number): HTMLElement {
  const el: HTMLElement = document.createElement('div');
  el.className = 'clock';
  el.textContent = formatClock(remainingPhaseMs(snap, now));
  panel.appendChild(el);
  return el;
}

function appendIntention(panel: HTMLElement, snap: SessionSnapshot): void {
  const intention: string = snap.config?.intention.trim() ?? '';
  if (intention === '') return;
  const el: HTMLElement = document.createElement('div');
  el.className = 'intention';
  el.textContent = intention;
  panel.appendChild(el);
}

function appendNotLoaded(panel: HTMLElement): void {
  const el: HTMLElement = document.createElement('div');
  el.className = 'notloaded';
  el.textContent = 'This page did not load. It will load by itself when session ends.';
  panel.appendChild(el);
}

function appendAttempts(panel: HTMLElement, snap: SessionSnapshot): void {
  const el: HTMLElement = document.createElement('div');
  el.className = 'attempts';
  const n: number = snap.attemptsToday;
  el.textContent = n === 1 ? '1 attempt blocked today' : `${n} attempts blocked today`;
  panel.appendChild(el);
}

function appendBank(m: Mounted, panel: HTMLElement, snap: SessionSnapshot, now: number): void {
  const meter: HTMLElement = document.createElement('div');
  meter.className = 'meter';
  const fill: HTMLElement = document.createElement('div');
  fill.className = 'meter-fill';
  meter.appendChild(fill);
  const label: HTMLElement = document.createElement('div');
  label.className = 'bank';
  panel.append(meter, label);
  m.meterFill = fill;
  m.bankLabel = label;
  updateBank(m, snap, now);
}

function updateBank(m: Mounted, snap: SessionSnapshot, now: number): void {
  const bank: number = extrapolatedBank(snap, now);
  if (m.meterFill !== null) {
    const ratio: number = snap.bankCapMs > 0 ? bank / snap.bankCapMs : 0;
    m.meterFill.style.width = `${Math.min(100, ratio * 100)}%`;
  }
  if (m.bankLabel !== null) m.bankLabel.textContent = `${formatClock(bank)} pause banked`;
}

function costMin(costMs: number): number {
  return Math.round(costMs / 60_000);
}

function buildButtons(m: Mounted, snap: SessionSnapshot, now: number): HTMLElement {
  const row: HTMLElement = document.createElement('div');
  row.className = 'buttons';
  const unlock: SpendRef = spendButton(
    `Unlock this site ${costMin(snap.unlockCostMs)} min`,
    snap.unlockCostMs,
    (): void => requestOpenGate('unlockSite', location.hostname),
  );
  const pause: SpendRef = spendButton(
    `Pause everything ${costMin(snap.pauseCostMs)} min`,
    snap.pauseCostMs,
    (): void => requestOpenGate('pause', null),
  );
  m.spends = [unlock, pause];
  row.append(unlock.button, pause.button);
  if (snap.config?.strictness === 'friction') {
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

function spendButton(label: string, costMs: number, onClick: () => void): SpendRef {
  const button: HTMLButtonElement = document.createElement('button');
  button.className = 'pill';
  button.type = 'button';
  const text: HTMLSpanElement = document.createElement('span');
  text.textContent = label;
  const ready: HTMLSpanElement = document.createElement('span');
  ready.className = 'ready';
  ready.hidden = true;
  button.append(text, ready);
  button.addEventListener('click', onClick);
  return { button, costMs, ready };
}

function updateSpend(ref: SpendRef, snap: SessionSnapshot, now: number): void {
  const bank: number = extrapolatedBank(snap, now);
  const affordable: boolean = bank >= ref.costMs;
  ref.button.disabled = !affordable;
  ref.ready.hidden = affordable;
  if (!affordable) {
    const waitMs: number | null = msUntilNextEarnedMinute(bank, snap.bankAccrualPerMs);
    ref.ready.textContent =
      waitMs === null ? 'earn pause time by focusing' : `ready in ${formatClock(waitMs)}`;
  }
}

function gateTitle(gate: GateState, snap: SessionSnapshot): string {
  if (gate.kind === 'pause') return `Pause everything ${costMin(snap.pauseCostMs)} min`;
  if (gate.kind === 'unlockSite') {
    return `Unlock ${gate.host ?? 'this site'} ${costMin(snap.unlockCostMs)} min`;
  }
  return 'End this session';
}

function gateConfirmLabel(kind: GateKind): string {
  if (kind === 'pause') return 'Take pause';
  if (kind === 'unlockSite') return 'Unlock this site';
  return 'End session';
}

function buildGate(m: Mounted, gate: GateState, snap: SessionSnapshot, now: number): HTMLElement {
  const wrap: HTMLElement = document.createElement('div');
  wrap.className = 'gate';
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
  const { waitWrap, ringFill, count } = buildRing();
  wrap.appendChild(waitWrap);
  const primary: HTMLButtonElement = document.createElement('button');
  primary.className = 'primary';
  primary.type = 'button';
  primary.textContent = 'Never mind, back to work';
  primary.addEventListener('click', (): void => requestAbandonGate());
  wrap.appendChild(primary);
  const phrase: HTMLInputElement | null = appendPhrase(wrap, gate);
  const confirm: HTMLButtonElement = document.createElement('button');
  confirm.className = 'pill';
  confirm.type = 'button';
  confirm.textContent = gateConfirmLabel(gate.kind);
  confirm.hidden = true;
  confirm.addEventListener('click', (): void => requestConfirmGate(phrase?.value ?? null));
  wrap.appendChild(confirm);
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
    mounted.clock.textContent = formatClock(remainingPhaseMs(snap, now));
  }
  updateBank(mounted, snap, now);
  for (const ref of mounted.spends) updateSpend(ref, snap, now);
  updateGate(mounted, snap, now);
}

function requestOpenGate(kind: GateKind, host: string | null): void {
  void sendAndRefresh({ type: 'openGate', gate: kind, host });
}

function requestAbandonGate(): void {
  void sendAndRefresh({ type: 'abandonGate' });
}

function requestConfirmGate(typedPhrase: string | null): void {
  void sendAndRefresh({ type: 'confirmGate', typedPhrase });
}

async function sendAndRefresh(
  req: Extract<Request, { type: 'openGate' | 'confirmGate' | 'abandonGate' }>,
): Promise<void> {
  try {
    await sendRequest(req);
    const snapshot: SessionSnapshot = await sendRequest({ type: 'getSnapshot' });
    if (mounted !== null) showOverlay(mounted.verdict, snapshot, mounted.stopped);
  } catch {
    // worker unavailable (shutdown race): keep the last render, the next push corrects us
  }
}
