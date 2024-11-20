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
    this.schedule();
  }

  private schedule(): void {
    if (this.timer === null) {
      this.timer = setTimeout((): void => {
        this.timer = null;
        void this.flushNow().catch((): void => {
          // flushNow preserved the batch and scheduled another attempt
        });
      }, this.flushMs);
    }
  }

  async flushNow(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) return;
    const batch: Map<string, unknown> = new Map(this.pending);
    try {
      await this.write(Object.fromEntries(batch));
    } catch (error: unknown) {
      this.schedule();
      throw error;
    }
    for (const [key, value] of batch) {
      if (this.pending.get(key) === value) this.pending.delete(key);
    }
    if (this.pending.size > 0) this.schedule();
  }
}

export class SyncEchoes {
  private readonly expected: Map<string, string> = new Map();

  remember(key: string, value: unknown): void {
    this.expected.set(key, JSON.stringify(value));
  }

  consume(key: string, value: unknown): boolean {
    const serialized: string = JSON.stringify(value);
    if (this.expected.get(key) !== serialized) return false;
    this.expected.delete(key);
    return true;
  }
}
