export interface SyncJournal {
  sets: Record<string, unknown>;
  removes: string[];
}

export interface SyncWriterJournalOptions {
  initial: SyncJournal;
  persist(journal: SyncJournal): Promise<void>;
}

/**
 * Debounced batch writer for chrome.storage.sync. The sync quota is
 * roughly 1800 writes per hour, so every queued key waits flushMs and
 * rapid updates to the same key collapse into the latest value.
 */
export class SyncWriter {
  private pending: Map<string, unknown>;
  private pendingRemovals: Set<string>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushQueue: Promise<void> = Promise.resolve();
  private journalQueue: Promise<void> = Promise.resolve();
  private journalDurability: Promise<void> = Promise.resolve();

  constructor(
    private readonly flushMs: number,
    private readonly write: (items: Record<string, unknown>) => Promise<void>,
    private readonly removeStored?: (keys: string[]) => Promise<void>,
    private readonly journal?: SyncWriterJournalOptions,
  ) {
    this.pending = new Map(Object.entries(journal?.initial.sets ?? {}));
    this.pendingRemovals = new Set(journal?.initial.removes ?? []);
    if (this.pending.size > 0 || this.pendingRemovals.size > 0) this.schedule();
  }

  queue(key: string, value: unknown): void {
    this.pendingRemovals.delete(key);
    this.pending.set(key, value);
    this.persistPendingJournal();
    this.schedule();
  }

  supersede(key: string, value: unknown): void {
    if (!this.pending.has(key)) return;
    this.pending.set(key, value);
    this.persistPendingJournal();
  }

  remove(key: string): void {
    this.pending.delete(key);
    this.pendingRemovals.add(key);
    this.persistPendingJournal();
    this.schedule();
  }

  whenJournalDurable(): Promise<void> {
    this.persistPendingJournal();
    return this.journalDurability;
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

  flushNow(): Promise<void> {
    const requested: Promise<void> = this.flushQueue.then((): Promise<void> => this.performFlush());
    this.flushQueue = requested.catch((): void => {});
    return requested;
  }

  private async performFlush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.journal !== undefined) await this.persistJournalForFlush();
    if (this.pending.size === 0 && this.pendingRemovals.size === 0) return;
    const batch: Map<string, unknown> = new Map(this.pending);
    const removals: Set<string> = new Set(this.pendingRemovals);
    try {
      if (batch.size > 0) await this.write(Object.fromEntries(batch));
      if (removals.size > 0) {
        if (this.removeStored === undefined) {
          throw new Error('sync removal requested without a remove callback');
        }
        await this.removeStored([...removals]);
      }
    } catch (error: unknown) {
      this.schedule();
      throw error;
    }
    for (const [key, value] of batch) {
      if (this.pending.get(key) === value) this.pending.delete(key);
    }
    for (const key of removals) this.pendingRemovals.delete(key);
    if (this.journal !== undefined) await this.persistJournalForFlush();
    if (this.pending.size > 0 || this.pendingRemovals.size > 0) this.schedule();
  }

  private async persistJournalForFlush(): Promise<void> {
    try {
      await this.whenJournalDurable();
    } catch (error: unknown) {
      this.schedule();
      throw error;
    }
  }

  private persistPendingJournal(): void {
    if (this.journal === undefined) return;
    const snapshot: SyncJournal = {
      sets: Object.fromEntries(this.pending),
      removes: [...this.pendingRemovals],
    };
    const requested: Promise<void> = this.journalQueue.then(
      (): Promise<void> => this.journal?.persist(snapshot) ?? Promise.resolve(),
    );
    this.journalQueue = requested.catch((): void => {});
    this.journalDurability = requested;
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
