/**
 * Renders the blocked page from one frozen `DocumentOverlayView`. Every word on the page comes
 * from the view's own copy fields, so this module formats numbers and never authors wording. It
 * ticks the clock, bank affordability, and gate readiness locally from the view's timestamps and
 * waits for a newer worker command for anything else.
 */
import { msUntilNextEarnedMinute } from '../shared/budget-display';
import type { DocumentOverlayView } from '../shared/enforcement-v2';
import { exactDataEqual } from '../shared/exact-data';
import { growBank } from '../shared/live';
import type { Ack, Request } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { applyTheme } from '../shared/theme';
import { formatClock } from '../shared/time';
import type { GateState, Verdict } from '../shared/types';
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

type ActiveOverlayView = Extract<DocumentOverlayView, { presentation: 'active' }>;
type StartingOverlayView = Extract<DocumentOverlayView, { presentation: 'starting' }>;
type ActionRequest = Extract<
  Request,
  { type: 'openGate' | 'confirmGate' | 'requestSessionEnd' | 'abandonGate' }
>;

interface SpendControl {
  button: HTMLButtonElement;
  costMs: number;
  ready: HTMLSpanElement;
}

interface GateControls {
  ringFill: SVGCircleElement;
  count: HTMLElement;
  waitWrap: HTMLElement;
  confirm: HTMLButtonElement;
  phrase: HTMLInputElement | null;
}

interface MountedOverlay extends OverlayHostElements {
  timer: number;
  view: DocumentOverlayView;
  verdict: Verdict;
  clock: HTMLElement | null;
  bankLabel: HTMLElement | null;
  meterFill: HTMLElement | null;
  spends: SpendControl[];
  gate: GateControls | null;
  actionGeneration: number;
  actionPending: boolean;
  actionError: string | null;
}

let mounted: MountedOverlay | null = null;

/**
 * Paints one frozen view. A view and verdict structurally equal to the painted pair is the
 * worker replaying its own command, so the panel, its focus, and any pending action survive.
 */
export function renderDocumentOverlay(view: DocumentOverlayView, verdict: Verdict): void {
  const current: MountedOverlay | null = mounted;
  if (
    current !== null &&
    exactDataEqual(current.view, view) &&
    exactDataEqual(current.verdict, verdict)
  ) {
    return;
  }
  const overlay: MountedOverlay = current ?? mountOverlay(view, verdict);
  mounted = overlay;
  overlay.view = view;
  overlay.verdict = verdict;
  applyTheme(overlay.host, view.theme);
  if (!overlay.actionPending) overlay.actionGeneration += 1;
  renderPanel(overlay);
  if (overlay.actionPending) disableAllActions(overlay);
  focusInitialControl(overlay.root, overlay.container);
}

export function clearDocumentOverlay(): void {
  if (mounted === null) return;
  window.clearInterval(mounted.timer);
  unmountOverlayHost(mounted.host);
  mounted = null;
}

function mountOverlay(view: DocumentOverlayView, verdict: Verdict): MountedOverlay {
  const elements: OverlayHostElements = mountOverlayHost();
  return {
    ...elements,
    timer: window.setInterval(tick, OVERLAY_TICK_MS),
    view,
    verdict,
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

function renderPanel(overlay: MountedOverlay): void {
  const now: number = Date.now();
  const view: DocumentOverlayView = overlay.view;
  overlay.clock = null;
  overlay.bankLabel = null;
  overlay.meterFill = null;
  overlay.spends = [];
  overlay.gate = null;
  overlay.container.className = view.stoppedPage ? 'backdrop opaque' : 'backdrop';
  const panel: HTMLElement = document.createElement('div');
  panel.className = 'panel';
  panel.appendChild(padlockSvg());
  if (view.presentation === 'starting') appendStartingPage(panel, view);
  else appendActivePage(overlay, panel, view, now);
  if (overlay.actionError !== null) panel.appendChild(actionErrorElement(overlay.actionError));
  overlay.container.replaceChildren(panel);
}

/** The starting page borrows the strong and muted type scales. It owns no clock and no control. */
function appendStartingPage(panel: HTMLElement, view: StartingOverlayView): void {
  appendLine(panel, 'intention', view.copy.title);
  appendLine(panel, 'until', view.copy.detail);
  appendLine(panel, 'provenance', view.copy.verdictProvenance);
  if (view.copy.stoppedPage !== null) appendLine(panel, 'notloaded', view.copy.stoppedPage);
}

/**
 * The status sentence leads both pages. A timed page says the wall clock it is locked until and
 * counts down below it, while an until-stopped page says the popup owns its ending and has no
 * clock. `copy.lockedUntil` is the bare wall clock behind the timed sentence, so it is never
 * rendered on its own: rendering it would drop the label the worker already wrote.
 */
function appendActivePage(
  overlay: MountedOverlay,
  panel: HTMLElement,
  view: ActiveOverlayView,
  now: number,
): void {
  appendLine(panel, 'until', view.copy.status.text);
  if (view.timing.phaseEndsAt !== null) {
    overlay.clock = appendLine(panel, 'clock', formatClock(view.timing.phaseEndsAt - now));
  }
  if (view.copy.intention !== null) appendLine(panel, 'intention', view.copy.intention);
  appendLine(panel, 'attempts', view.copy.attempts);
  appendLine(panel, 'provenance', view.copy.verdictProvenance);
  if (view.copy.stoppedPage !== null) appendLine(panel, 'notloaded', view.copy.stoppedPage);
  appendBank(overlay, panel, view, now);
  panel.appendChild(
    view.gate === null
      ? buildButtons(overlay, view, now)
      : buildGate(overlay, view, view.gate, now),
  );
}

function appendLine(parent: HTMLElement, className: string, text: string): HTMLElement {
  const line: HTMLElement = document.createElement('div');
  line.className = className;
  line.textContent = text;
  parent.appendChild(line);
  return line;
}

function appendBank(
  overlay: MountedOverlay,
  panel: HTMLElement,
  view: ActiveOverlayView,
  now: number,
): void {
  const meter: HTMLElement = document.createElement('div');
  meter.className = 'meter';
  const fill: HTMLElement = document.createElement('div');
  fill.className = 'meter-fill';
  meter.appendChild(fill);
  const label: HTMLElement = document.createElement('div');
  label.className = 'bank';
  panel.append(meter, label);
  overlay.meterFill = fill;
  overlay.bankLabel = label;
  updateBank(overlay, view, now);
}

/** Grows the frozen bank forward from the capture time, through the shared rule. */
function bankAt(view: ActiveOverlayView, now: number): number {
  return growBank(
    view.economy.bankMs,
    view.economy.bankAccrualPerMs,
    view.economy.bankCapMs,
    view.timing.capturedAt,
    now,
  );
}

function updateBank(overlay: MountedOverlay, view: ActiveOverlayView, now: number): void {
  const bank: number = bankAt(view, now);
  if (overlay.meterFill !== null) {
    const ratio: number = view.economy.bankCapMs > 0 ? bank / view.economy.bankCapMs : 0;
    overlay.meterFill.style.width = `${Math.min(100, ratio * 100)}%`;
  }
  if (overlay.bankLabel !== null) {
    overlay.bankLabel.textContent = `${formatClock(bank)} ${view.copy.bankUnit}`;
  }
}

function buildButtons(overlay: MountedOverlay, view: ActiveOverlayView, now: number): HTMLElement {
  const row: HTMLElement = document.createElement('div');
  row.className = 'buttons';
  const unlock: SpendControl = spendButton(
    view.copy.unlockAction,
    view.economy.unlockCostMs,
    (): void => {
      requestAction({ type: 'openGate', gate: 'unlockSite', host: window.location.hostname });
    },
  );
  const pause: SpendControl = spendButton(
    view.copy.pauseAction,
    view.economy.pauseCostMs,
    (): void => {
      requestAction({ type: 'openGate', gate: 'pause', host: null });
    },
  );
  overlay.spends = [unlock, pause];
  row.append(unlock.button, pause.button);
  if (view.actions.end === 'request-end') row.appendChild(endButton(view.copy.endAction));
  for (const control of overlay.spends) updateSpend(control, view, now);
  return row;
}

function spendButton(label: string, costMs: number, onClick: () => void): SpendControl {
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

function endButton(label: string): HTMLButtonElement {
  const button: HTMLButtonElement = document.createElement('button');
  button.className = 'linkish';
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', (): void => {
    requestAction({ type: 'requestSessionEnd' });
  });
  return button;
}

function updateSpend(control: SpendControl, view: ActiveOverlayView, now: number): void {
  const bank: number = bankAt(view, now);
  const affordable: boolean = bank >= control.costMs;
  control.button.disabled = !affordable;
  control.ready.hidden = affordable;
  control.ready.textContent = affordable ? '' : bankWaitText(view, bank);
}

function bankWaitText(view: ActiveOverlayView, bank: number): string {
  const waitMs: number | null = msUntilNextEarnedMinute(
    bank,
    view.economy.bankAccrualPerMs,
    view.economy.bankCapMs,
  );
  if (waitMs === null) return view.copy.bankWaitFallback;
  return `${view.copy.bankWaitPrefix} ${formatClock(waitMs)}`;
}

/**
 * The two `?? ''` fallbacks below are unreachable, and deliberately kept.
 * `validateDetachedActiveCopy` in `shared/enforcement-v2-validation.ts` requires `gateTitle` and
 * `gateConfirm` to be non-blank strings whenever a gate is open, and this function runs only for an
 * open gate, so neither can be null here. The contract cannot say so in a way TypeScript can use,
 * because `gate` and `copy` are sibling fields and no union on one narrows the other; tying them
 * together is a wire-shape change parked as its own item. Throwing instead would break a blocked
 * page mid-render for a case the validator already refuses.
 */
function buildGate(
  overlay: MountedOverlay,
  view: ActiveOverlayView,
  gate: GateState,
  now: number,
): HTMLElement {
  const wrap: HTMLElement = document.createElement('div');
  wrap.className = 'gate';
  appendLine(wrap, 'gate-title', view.copy.gateTitle ?? '');
  const ring: { waitWrap: HTMLElement; ringFill: SVGCircleElement; count: HTMLElement } =
    buildRing();
  wrap.appendChild(ring.waitWrap);
  const back: HTMLButtonElement = document.createElement('button');
  back.className = 'primary';
  back.type = 'button';
  back.textContent = view.copy.gateBack;
  back.addEventListener('click', (): void => {
    requestAction({ type: 'abandonGate' });
  });
  wrap.appendChild(back);
  const phrase: HTMLInputElement | null = appendPhrase(wrap, view, gate);
  const confirm: HTMLButtonElement = document.createElement('button');
  confirm.className = 'pill';
  confirm.type = 'button';
  confirm.textContent = view.copy.gateConfirm ?? '';
  confirm.hidden = true;
  confirm.addEventListener('click', (): void => {
    requestAction({ type: 'confirmGate', typedPhrase: phrase?.value ?? null });
  });
  wrap.appendChild(confirm);
  overlay.gate = {
    ringFill: ring.ringFill,
    count: ring.count,
    waitWrap: ring.waitWrap,
    confirm,
    phrase,
  };
  updateGate(overlay, view, now);
  return wrap;
}

function appendPhrase(
  wrap: HTMLElement,
  view: ActiveOverlayView,
  gate: GateState,
): HTMLInputElement | null {
  if (gate.requiredPhrase === null) return null;
  appendLine(wrap, 'phrase-label', view.copy.gatePhraseLabel);
  appendLine(wrap, 'phrase-text', gate.requiredPhrase);
  const input: HTMLInputElement = document.createElement('input');
  input.className = 'phrase';
  input.type = 'text';
  input.setAttribute('aria-label', view.copy.gatePhraseLabel);
  input.addEventListener('input', (): void => {
    if (mounted !== null) refresh(mounted);
  });
  wrap.appendChild(input);
  return input;
}

function updateGate(overlay: MountedOverlay, view: ActiveOverlayView, now: number): void {
  const controls: GateControls | null = overlay.gate;
  const gate: GateState | null = view.gate;
  if (controls === null || gate === null) return;
  const span: number = gate.readyAt - gate.openedAt;
  const progress: number = span <= 0 ? 1 : Math.min(1, Math.max(0, (now - gate.openedAt) / span));
  controls.ringFill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));
  controls.count.textContent = String(Math.max(0, Math.ceil((gate.readyAt - now) / 1000)));
  const ready: boolean = now >= gate.readyAt;
  controls.waitWrap.hidden = ready;
  controls.confirm.hidden = !ready;
  const phraseOk: boolean =
    gate.requiredPhrase === null ||
    (controls.phrase !== null && controls.phrase.value === gate.requiredPhrase);
  controls.confirm.disabled = !(ready && phraseOk);
}

function tick(): void {
  if (mounted !== null) refresh(mounted);
}

/** Repaints only what the document may recompute on its own: clock, bank, and gate readiness. */
function refresh(overlay: MountedOverlay): void {
  const view: DocumentOverlayView = overlay.view;
  if (view.presentation !== 'active') return;
  const now: number = Date.now();
  if (overlay.clock !== null && view.timing.phaseEndsAt !== null) {
    overlay.clock.textContent = formatClock(view.timing.phaseEndsAt - now);
  }
  updateBank(overlay, view, now);
  for (const control of overlay.spends) updateSpend(control, view, now);
  updateGate(overlay, view, now);
  if (overlay.actionPending) disableAllActions(overlay);
}

function requestAction(request: ActionRequest): void {
  void sendAction(request);
}

/**
 * Sends one action and waits. The worker answers a committed change with a newer command, so a
 * successful action only unlocks the controls: this renderer never invents the next view.
 */
async function sendAction(request: ActionRequest): Promise<void> {
  const overlay: MountedOverlay | null = mounted;
  if (overlay === null || overlay.actionPending) return;
  const generation: number = overlay.actionGeneration + 1;
  overlay.actionGeneration = generation;
  overlay.actionPending = true;
  disableAllActions(overlay);
  clearActionError(overlay);
  const ack: Ack | null = await requestAck(request);
  if (!isCurrentAction(overlay, generation)) return;
  finishAction(overlay);
  if (ack === null || !ack.ok) showTransportError(overlay);
}

/** null is a dead worker channel. A rejected command and a dead channel read the same on screen. */
async function requestAck(request: ActionRequest): Promise<Ack | null> {
  try {
    return await sendRequest(request);
  } catch {
    return null;
  }
}

function isCurrentAction(overlay: MountedOverlay, generation: number): boolean {
  return mounted === overlay && overlay.actionGeneration === generation;
}

function finishAction(overlay: MountedOverlay): void {
  overlay.actionPending = false;
  const view: DocumentOverlayView = overlay.view;
  if (view.presentation === 'active') {
    const now: number = Date.now();
    for (const control of overlay.spends) updateSpend(control, view, now);
    updateGate(overlay, view, now);
  }
  for (const button of overlay.root.querySelectorAll<HTMLButtonElement>('.linkish, .primary')) {
    button.disabled = false;
  }
}

function disableAllActions(overlay: MountedOverlay): void {
  for (const button of overlay.root.querySelectorAll<HTMLButtonElement>('button')) {
    button.disabled = true;
  }
}

function clearActionError(overlay: MountedOverlay): void {
  overlay.actionError = null;
  overlay.root.querySelector('.action-error')?.remove();
}

/** Only an active view carries transport copy, and only an active view renders an action. */
function showTransportError(overlay: MountedOverlay): void {
  if (overlay.view.presentation !== 'active') return;
  const message: string = overlay.view.copy.transportError;
  clearActionError(overlay);
  overlay.actionError = message;
  overlay.container.querySelector('.panel')?.appendChild(actionErrorElement(message));
}

function actionErrorElement(message: string): HTMLElement {
  const alert: HTMLElement = document.createElement('div');
  alert.className = 'action-error';
  alert.setAttribute('role', 'alert');
  alert.textContent = message;
  return alert;
}
