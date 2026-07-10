/**
 * What one mounted blocked page holds between repaints: the frozen view it paints, the live
 * element handles its ticks update, the pending action, and the work target lookup. One page is
 * mounted at a time, and every renderer module reads it through `mountedOverlay()`.
 */
import type { DocumentOverlayView } from '../shared/enforcement-v2';
import type { Verdict } from '../shared/types';
import type { WorkTargetResult } from '../shared/work-target';
import type { OverlayHostElements } from './overlay-host';
import type { WorkTabPicker } from './work-tab-picker';

export interface SpendControl {
  button: HTMLButtonElement;
  costMs: number;
  ready: HTMLSpanElement;
}

export interface GateControls {
  ringFill: SVGCircleElement;
  count: HTMLElement;
  waitWrap: HTMLElement;
  confirm: HTMLButtonElement;
  phrase: HTMLInputElement | null;
}

export interface WorkTargetControls {
  button: HTMLButtonElement;
  status: HTMLElement;
  change: HTMLButtonElement;
}

export interface MountedOverlay extends OverlayHostElements {
  timer: number;
  view: DocumentOverlayView;
  verdict: Verdict;
  clock: HTMLElement | null;
  bankLabel: HTMLElement | null;
  meterFill: HTMLElement | null;
  access: HTMLDetailsElement | null;
  spends: SpendControl[];
  gate: GateControls | null;
  work: WorkTargetControls | null;
  actionGeneration: number;
  actionPending: boolean;
  actionError: string | null;
  /** True until the person presses or clicks anything, so a ready target may take first focus. */
  initialFocus: boolean;
  targetGeneration: number;
  target: WorkTargetResult | null;
  targetPending: boolean;
  targetError: string | null;
  picker: WorkTabPicker | null;
  /** Re-derives every control's enabled state after an action settles. Set by the renderer. */
  settle: () => void;
}

let mounted: MountedOverlay | null = null;

export function mountedOverlay(): MountedOverlay | null {
  return mounted;
}

export function setMountedOverlay(overlay: MountedOverlay | null): void {
  mounted = overlay;
}
