/** Human duration for tiles and tables: "2 h 05 m", "45 m", never "125 min". */
export function formatDuration(ms: number): string {
  const totalMin: number = Math.max(0, Math.round(ms / 60_000));
  if (totalMin >= 60) {
    const h: number = Math.floor(totalMin / 60);
    const m: number = totalMin % 60;
    return `${h} h ${String(m).padStart(2, '0')} m`;
  }
  return `${totalMin} m`;
}

/** Minutes as a compact chart value: "1 h 05 m" above an hour, "45 m" below. */
export function formatMinutes(min: number): string {
  return formatDuration(min * 60_000);
}

/** Local "HH:MM" for the session log. */
export function formatTimeOfDay(atMs: number): string {
  const d: Date = new Date(atMs);
  const h: string = String(d.getHours()).padStart(2, '0');
  const m: string = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}
