/**
 * Debounced batch writer for chrome.storage.sync. The sync quota is
 * roughly 1800 writes per hour, so every queued key waits flushMs and
 * rapid updates to the same key collapse into the latest value.
 */
export class SyncWriter {
  private pending: Map<string, unknown> = new Map();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly flushMs: number,
    private readonly write: (items: Record<string, unknown>) => Promise<void>,
  ) {}

  queue(key: string, value: unknown): void {
    this.pending.set(key, value);
    if (this.timer === null) {
      this.timer = setTimeout((): void => {
        this.timer = null;
        void this.flushNow();
      }, this.flushMs);
    }
  }

  async flushNow(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) return;
    const items: Record<string, unknown> = Object.fromEntries(this.pending);
    this.pending = new Map();
    await this.write(items);
  }
}
