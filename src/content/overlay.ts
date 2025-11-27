import { msUntilNextEarnedMinute } from '../shared/budget-display';
import { extrapolatedBank, remainingPhaseMs } from '../shared/live';
import type { Ack, Request } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { applyTheme } from '../shared/theme';
import { formatClock } from '../shared/time';
import type { GateKind, GateState, SessionSnapshot, Verdict } from '../shared/types';
import { verdictLabel } from '../shared/verdict-label';
import {
  buildRing,
  focusInitialControl,
  mountOverlayHost,
  type OverlayHostElements,
  padlockSvg,
  RING_CIRCUMFERENCE,
  unmountOverlayHost,
} from './overlay-host';
import { OVERLAY_TICK_MS } from './overlay-styles';

/** The v1 block overlay, rendered from the worker's SessionSnapshot into the shared shadow host
 * that `overlay-host.ts` owns. This module displays state, it never decides it. */

const TRANSPORT_ERROR: string = 'Could not reach Focus Lock. Try again.';

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

interface Mounted extends OverlayHostElements {
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
  actionPending: boolean;
  actionError: string | null;
}

let mounted: Mounted | null = null;

export function showOverlay(verdict: Verdict, snapshot: SessionSnapshot, stopped?: boolean): void {
  if (mounted === null) mounted = mount();
  applyTheme(mounted.host, snapshot.theme);
  if (!mounted.actionPending) mounted.actionGeneration += 1;
  mounted.verdict = verdict;
  mounted.snapshot = snapshot;
  mounted.stopped = stopped ?? false;
  render(mounted);
  if (mounted.actionPending) disableAllActions(mounted);
  focusInitialControl(mounted.root, mounted.container);
}

export function hideOverlay(_snapshot: SessionSnapshot): void {
  if (mounted === null) return;
  window.clearInterval(mounted.timer);
  unmountOverlayHost(mounted.host);
  mounted = null;
}

function mount(): Mounted {
  const { host, root, container }: OverlayHostElements = mountOverlayHost();
  return {
    host,
    root,
    container,
    timer: window.setInterval(tick, OVERLAY_TICK_MS),
    verdict: { blocked: true, reason: 'default', categoryId: null, matchedPattern: null },
    snapshot: null as unknown as SessionSnapshot, // overwritten by showOverlay before any render
    stopped: false,
    clock: null,
    bankLabel: null,
    meterFill: null,
    spends: [],
    gate: null,
    actionGeneration: 0,
    actionPending: false,
    actionError: null,
  };
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
  appendVerdictProvenance(panel, m.verdict);
  if (m.stopped) appendNotLoaded(panel);
  appendBank(m, panel, snap, now);
  if (snap.gate === null) panel.appendChild(buildButtons(m, snap, now));
  else panel.appendChild(buildGate(m, snap.gate, snap, now));
  if (m.actionError !== null) panel.appendChild(actionErrorElement(m.actionError));
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
  el.textContent = 'This page did not load. It will load by itself when the session ends.';
  panel.appendChild(el);
}

function appendAttempts(panel: HTMLElement, snap: SessionSnapshot): void {
  const el: HTMLElement = document.createElement('div');
  el.className = 'attempts';
  const n: number = snap.attemptsToday;
  el.textContent = n === 1 ? '1 attempt blocked today' : `${n} attempts blocked today`;
  panel.appendChild(el);
}

function appendVerdictProvenance(panel: HTMLElement, verdict: Verdict): void {
  const el: HTMLElement = document.createElement('div');
  el.className = 'provenance';
  el.textContent = verdictLabel(verdict);
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
    `Unlock this site for ${costMin(snap.unlockCostMs)} min`,
    snap.unlockCostMs,
    (): void => requestOpenGate('unlockSite', location.hostname),
  );
  const pause: SpendRef = spendButton(
    `Pause blocking for ${costMin(snap.pauseCostMs)} min`,
    snap.pauseCostMs,
    (): void => requestOpenGate('pause', null),
  );
  m.spends = [unlock, pause];
  row.append(unlock.button, pause.button);
  if (snap.config?.strictness !== 'hard') {
    const cancel: HTMLButtonElement = document.createElement('button');
    cancel.className = 'linkish';
    cancel.type = 'button';
    cancel.textContent = 'End session';
    cancel.addEventListener('click', (): void => requestSessionEnd());
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
    const waitMs: number | null = msUntilNextEarnedMinute(
      bank,
      snap.bankAccrualPerMs,
      snap.bankCapMs,
    );
    ref.ready.textContent =
      waitMs === null ? 'earn pause time by focusing' : `ready in ${formatClock(waitMs)}`;
  }
}

function gateTitle(gate: GateState, snap: SessionSnapshot): string {
  if (gate.kind === 'pause') return `Pause blocking for ${costMin(snap.pauseCostMs)} min`;
  if (gate.kind === 'unlockSite') {
    return `Unlock ${gate.host ?? 'this site'} ${costMin(snap.unlockCostMs)} min`;
  }
  return 'End this session';
}

function gateConfirmLabel(kind: GateKind): string {
  if (kind === 'pause') return 'Take the pause';
  if (kind === 'unlockSite') return 'Unlock this site';
  return 'End the session';
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
  const {
    waitWrap,
    ringFill,
    count,
  }: { waitWrap: HTMLElement; ringFill: SVGCircleElement; count: HTMLElement } = buildRing();
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
  if (mounted.actionPending) disableAllActions(mounted);
}

function requestOpenGate(kind: 'pause' | 'unlockSite', host: string | null): void {
  void sendAndRefresh({ type: 'openGate', gate: kind, host });
}

function requestAbandonGate(): void {
  void sendAndRefresh({ type: 'abandonGate' });
}

function requestConfirmGate(typedPhrase: string | null): void {
  void sendAndRefresh({ type: 'confirmGate', typedPhrase });
}

function requestSessionEnd(): void {
  void sendAndRefresh({ type: 'requestSessionEnd' });
}

async function sendAndRefresh(
  req: Extract<Request, { type: 'openGate' | 'confirmGate' | 'requestSessionEnd' | 'abandonGate' }>,
): Promise<void> {
  const mount: Mounted | null = mounted;
  if (mount === null || mount.actionPending) return;
  const generation: number = mount.actionGeneration + 1;
  mount.actionGeneration = generation;
  mount.actionPending = true;
  disableAllActions(mount);
  clearActionError(mount);
  try {
    const ack: Ack = await sendRequest(req);
    if (!isCurrentAction(mount, generation)) return;
    if (!ack.ok) {
      finishAction(mount);
      showActionError(mount, ack.error);
      return;
    }
    const snapshot: SessionSnapshot = await sendRequest({ type: 'getSnapshot' });
    if (!isCurrentAction(mount, generation)) return;
    finishAction(mount);
    showOverlay(mount.verdict, snapshot, mount.stopped);
  } catch {
    if (isCurrentAction(mount, generation)) {
      finishAction(mount);
      showActionError(mount, TRANSPORT_ERROR);
    }
  }
}

function disableAllActions(mount: Mounted): void {
  for (const button of mount.root.querySelectorAll<HTMLButtonElement>('button')) {
    button.disabled = true;
  }
}

function finishAction(mount: Mounted): void {
  mount.actionPending = false;
  const now: number = Date.now();
  for (const ref of mount.spends) updateSpend(ref, mount.snapshot, now);
  updateGate(mount, mount.snapshot, now);
  for (const button of mount.root.querySelectorAll<HTMLButtonElement>('.linkish, .primary')) {
    button.disabled = false;
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
