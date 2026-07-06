/**
 * Shared shadow-root CSS for the blocked page. `DocumentOverlayView` mounts this exact string
 * through the overlay host, so every blocked page keeps one look and one tick cadence. The
 * transition durations are written from `OVERLAY_TICK_MS`, so a renderer that repaints on the
 * interval never animates past its next repaint.
 */

/** Local repaint cadence for the clock, the bank meter, and the gate ring. */
export const OVERLAY_TICK_MS: number = 250;

export const OVERLAY_STYLES: string = `
:host,
:host([data-theme="light"]) {
  color-scheme: light;
  --overlay-bg: rgba(248, 250, 252, 0.98);
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
    --overlay-bg: rgba(15, 23, 42, 0.97);
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
  --overlay-bg: rgba(15, 23, 42, 0.97);
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
  display: flex; align-items: center; justify-content: center;
  text-align: center;
}
.backdrop:focus { outline: none; }
.backdrop.opaque { background: var(--overlay-opaque); }
.notloaded { font-size: 0.9rem; color: var(--overlay-muted); }
.panel {
  max-width: 40rem; padding: 2rem;
  display: flex; flex-direction: column; align-items: center; gap: 0.9rem;
}
.padlock { width: 3.5rem; height: 3.5rem; }
.until { font-size: 1rem; color: var(--overlay-muted); }
.clock {
  font-size: 4.5rem; font-weight: 700; line-height: 1;
  font-variant-numeric: tabular-nums; letter-spacing: 0.02em;
  animation: pulse 2.4s ease-in-out infinite;
}
.intention { font-size: 1.5rem; font-weight: 600; color: var(--overlay-intention); overflow-wrap: anywhere; }
.attempts { font-size: 0.9rem; color: var(--overlay-subtle); }
.provenance {
  max-width: 100%; font-size: 0.85rem; color: var(--overlay-subtle); overflow-wrap: anywhere;
}
.meter {
  width: 16rem; height: 0.5rem; border-radius: 999px;
  background: var(--overlay-meter); overflow: hidden;
}
.meter-fill {
  height: 100%; border-radius: 999px; background: #22c55e;
  transition: width ${OVERLAY_TICK_MS}ms linear;
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
.pill:disabled { opacity: 0.55; }
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
  transition: stroke-dashoffset ${OVERLAY_TICK_MS}ms linear;
}
.ring-count {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 1.2rem; font-variant-numeric: tabular-nums; color: var(--overlay-intention);
}
.primary {
  background: #22c55e; color: #052e16; font-weight: 700;
  font-size: 1.25rem; padding: 1rem 2.2rem; border-radius: 999px;
}
.primary:hover:not(:disabled) { background: #4ade80; }
.primary:disabled { cursor: default; opacity: 0.55; }
.force-end {
  border: 1px solid var(--overlay-danger); border-radius: 999px; padding: 0.55rem 1.2rem;
  background: var(--overlay-danger-soft); color: var(--overlay-danger); font-size: 0.9rem;
}
.force-end:hover:not(:disabled) { filter: brightness(0.96); }
.force-end:disabled { opacity: 0.55; }
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
