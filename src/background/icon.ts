import { formatBadge } from '../shared/time';
import type { Phase, SessionSnapshot } from '../shared/types';

const STATE_COLORS: Record<Phase, string> = {
  idle: '#9ca3af',
  focus: '#22c55e',
  break: '#14b8a6',
  paused: '#f59e0b',
};

export interface IconSpec {
  color: string;
  open: boolean;
  progress: number;
}

/** Pure description of the icon: state color, shackle position, phase progress. */
export function iconSpec(snapshot: SessionSnapshot): IconSpec {
  const color: string = STATE_COLORS[snapshot.phase];
  if (
    snapshot.phase === 'idle' ||
    snapshot.phaseStartedAt === null ||
    snapshot.phaseEndsAt === null
  ) {
    return { color, open: snapshot.phase === 'idle', progress: 0 };
  }
  const span: number = snapshot.phaseEndsAt - snapshot.phaseStartedAt;
  const progress: number =
    span <= 0 ? 0 : Math.min(1, Math.max(0, (snapshot.at - snapshot.phaseStartedAt) / span));
  return { color, open: false, progress };
}

export function badgeFor(
  snapshot: SessionSnapshot,
  countdown: boolean,
): { text: string; color: string } {
  const color: string = STATE_COLORS[snapshot.phase];
  if (!countdown || snapshot.phase === 'idle' || snapshot.phaseEndsAt === null) {
    return { text: '', color };
  }
  return { text: formatBadge(snapshot.phaseEndsAt - snapshot.at), color };
}

function drawPadlock(size: number, spec: IconSpec): ImageData {
  const canvas: OffscreenCanvas = new OffscreenCanvas(size, size);
  // biome-ignore lint/style/noNonNullAssertion: 2d context always exists on a fresh OffscreenCanvas
  const ctx: OffscreenCanvasRenderingContext2D = canvas.getContext('2d')!;
  const u: number = size / 16;
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = spec.color;
  ctx.fillStyle = spec.color;
  ctx.lineWidth = 1.6 * u;
  ctx.lineCap = 'round';
  // shackle: an arc sitting on the body, lifted and rotated when open
  ctx.save();
  if (spec.open) {
    ctx.translate(8 * u, 7 * u);
    ctx.rotate((-20 * Math.PI) / 180);
    ctx.translate(-8 * u, -8 * u);
  }
  ctx.beginPath();
  ctx.arc(8 * u, 7 * u, 3.2 * u, Math.PI, 2 * Math.PI);
  ctx.stroke();
  ctx.restore();
  // body: filled rounded rect
  const r: number = 1.2 * u;
  const x: number = 3.5 * u;
  const y: number = 7 * u;
  const w: number = 9 * u;
  const h: number = 7 * u;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
  // progress ring: thin arc from 12 o'clock, clockwise
  if (spec.progress > 0) {
    ctx.lineWidth = Math.max(1, 0.9 * u);
    ctx.beginPath();
    ctx.arc(8 * u, 8 * u, 7.2 * u, -Math.PI / 2, -Math.PI / 2 + spec.progress * 2 * Math.PI);
    ctx.stroke();
  }
  return ctx.getImageData(0, 0, size, size);
}

/** Renders and applies icon plus badge. Never throws: an icon render must not kill a tick. */
export function updateIcon(snapshot: SessionSnapshot, badgeCountdown: boolean): void {
  try {
    const spec: IconSpec = iconSpec(snapshot);
    const imageData: Record<number, ImageData> = {
      16: drawPadlock(16, spec),
      32: drawPadlock(32, spec),
    };
    void chrome.action.setIcon({ imageData });
    const badge: { text: string; color: string } = badgeFor(snapshot, badgeCountdown);
    void chrome.action.setBadgeText({ text: badge.text });
    void chrome.action.setBadgeBackgroundColor({ color: badge.color });
  } catch {
    // OffscreenCanvas or action API hiccups must not break the engine
  }
}
