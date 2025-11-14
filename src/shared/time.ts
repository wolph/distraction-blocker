export function minToMs(min: number): number {
  return Math.round(min * 60_000);
}

export function formatBadge(msRemaining: number): string {
  const ms: number = Math.max(0, msRemaining);
  const totalMin: number = Math.ceil(ms / 60_000);
  if (totalMin >= 60) {
    const h: number = Math.floor(totalMin / 60);
    const m: number = totalMin % 60;
    return `${h}h${String(m).padStart(2, '0')}`;
  }
  return `${totalMin}m`;
}

export function formatClock(msRemaining: number): string {
  const total: number = Math.max(0, Math.floor(msRemaining / 1000));
  const h: number = Math.floor(total / 3600);
  const m: number = Math.floor((total % 3600) / 60);
  const s: number = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function localDateStr(atMs: number): string {
  const d: Date = new Date(atMs);
  const y: number = d.getFullYear();
  const m: string = String(d.getMonth() + 1).padStart(2, '0');
  const day: string = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function localMonthStr(atMs: number): string {
  return localDateStr(atMs).slice(0, 7);
}

/**
 * The instant local midnight after one local date. The v1 engine's catch-up loop and the v2
 * controller's tick both walk finished days with it, so it lives beside `localDateStr` rather
 * than being spelled twice.
 */
export function localMidnightAfter(date: string): number {
  const midnight: Date = new Date(`${date}T00:00:00`);
  midnight.setDate(midnight.getDate() + 1);
  return midnight.getTime();
}
