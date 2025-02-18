import {
  assertSyncItemWithinQuota,
  type SanitizedSyncJournal,
  sanitizeSyncJournal,
} from './sync-quota';

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
  private readonly pendingRevisions: Map<string, number> = new Map();
  private readonly reconciliationPending: Set<string> = new Set();
  private nextRevision: number = 0;
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
    const sanitized: SanitizedSyncJournal = sanitizeSyncJournal(
      journal?.initial ?? { sets: {}, removes: [] },
    );
    const initial: SyncJournal = sanitized.journal;
    this.pending = new Map(Object.entries(initial.sets));
    this.pendingRemovals = new Set(initial.removes);
    for (const key of this.pending.keys()) this.markChanged(key);
    for (const key of this.pendingRemovals) this.markChanged(key);
    if (sanitized.rejected.length > 0) {
      this.persistPendingJournal();
      void this.journalDurability.catch((): void => this.schedule());
    }
    if (this.pending.size > 0 || this.pendingRemovals.size > 0) this.schedule();
  }

  queue(key: string, value: unknown): void {
    assertSyncItemWithinQuota(key, value);
    this.pendingRemovals.delete(key);
    this.pending.set(key, value);
    this.markChanged(key);
    this.persistPendingJournal();
    this.schedule();
  }

  supersede(key: string, value: unknown): void {
    if (!this.pending.has(key)) return;
    assertSyncItemWithinQuota(key, value);
    this.pending.set(key, value);
    this.markChanged(key);
    this.persistPendingJournal();
  }

  hasPending(key: string): boolean {
    return (
      this.pending.has(key) || this.pendingRemovals.has(key) || this.reconciliationPending.has(key)
    );
  }

  remove(key: string): void {
    this.pending.delete(key);
    this.pendingRemovals.add(key);
    this.markChanged(key);
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

  /**
   * Rewrites the complete pending journal while flushes are paused. Work
   * queued during asynchronous preparation is included in the transform.
   */
  transformPending<T>(
    prepare: () => Promise<T>,
    transform: (prepared: T, pending: SyncJournal) => SyncJournal,
  ): Promise<void> {
    const requested: Promise<void> = this.flushQueue.then(async (): Promise<void> => {
      const prepared: T = await prepare();
      const current: SyncJournal = {
        sets: Object.fromEntries(
          [...this.pending.entries()].sort(
            ([left]: [string, unknown], [right]: [string, unknown]): number =>
              left.localeCompare(right),
          ),
        ),
        removes: [...this.pendingRemovals].sort((left: string, right: string): number =>
          left.localeCompare(right),
        ),
      };
      const transformed: SyncJournal = transform(prepared, current);
      const removals: Set<string> = new Set(transformed.removes);
      const sets: Array<[string, unknown]> = Object.entries(transformed.sets)
        .filter(([key]: [string, unknown]): boolean => !removals.has(key))
        .sort(([left]: [string, unknown], [right]: [string, unknown]): number =>
          left.localeCompare(right),
        );
      for (const [key, value] of sets) assertSyncItemWithinQuota(key, value);

      this.pending = new Map(sets);
      this.pendingRemovals = new Set(
        [...removals].sort((left: string, right: string): number => left.localeCompare(right)),
      );
      this.reconciliationPending.clear();
      this.pendingRevisions.clear();
      for (const key of this.pending.keys()) this.markChanged(key);
      for (const key of this.pendingRemovals) this.markChanged(key);
      this.persistPendingJournal();
      const durability: Promise<void> = this.journalDurability;
      if (this.pending.size > 0 || this.pendingRemovals.size > 0) this.schedule();
      await durability;
    });
    this.flushQueue = requested.catch((): void => {});
    return requested;
  }

  private async performFlush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch: Map<string, unknown> = new Map(this.pending);
    const removals: Set<string> = new Set(this.pendingRemovals);
    const revisions: Map<string, number> = new Map(this.pendingRevisions);
    if (this.journal !== undefined) {
      await this.persistJournalForFlush();
      this.reconciliationPending.clear();
    }
    if (batch.size === 0 && removals.size === 0) return;
    try {
      for (const [key, value] of batch) assertSyncItemWithinQuota(key, value);
      if (this.journal !== undefined) await this.removeBatch(removals);
      if (batch.size > 0) await this.write(Object.fromEntries(batch));
      if (this.journal === undefined) await this.removeBatch(removals);
    } catch (error: unknown) {
      this.schedule();
      throw error;
    }
    for (const key of batch.keys()) {
      if (this.pendingRevisions.get(key) === revisions.get(key)) {
        this.pending.delete(key);
        if (this.journal !== undefined) this.reconciliationPending.add(key);
      }
    }
    for (const key of removals) {
      if (this.pendingRevisions.get(key) === revisions.get(key)) {
        this.pendingRemovals.delete(key);
        if (this.journal !== undefined) this.reconciliationPending.add(key);
      }
    }
    for (const [key, revision] of revisions) {
      if (
        this.pendingRevisions.get(key) === revision &&
        !this.pending.has(key) &&
        !this.pendingRemovals.has(key)
      ) {
        this.pendingRevisions.delete(key);
      }
    }
    if (this.journal !== undefined) {
      await this.persistJournalForFlush();
      this.reconciliationPending.clear();
    }
    if (this.pending.size > 0 || this.pendingRemovals.size > 0) this.schedule();
  }

  private async removeBatch(removals: Set<string>): Promise<void> {
    if (removals.size === 0) return;
    if (this.removeStored === undefined) {
      throw new Error('sync removal requested without a remove callback');
    }
    await this.removeStored([...removals]);
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
    const requested: Promise<void> = this.journalQueue.then((): Promise<void> => {
      for (const [key, value] of Object.entries(snapshot.sets)) {
        assertSyncItemWithinQuota(key, value);
      }
      return this.journal?.persist(snapshot) ?? Promise.resolve();
    });
    this.journalQueue = requested.catch((): void => {});
    this.journalDurability = requested;
  }

  private markChanged(key: string): void {
    this.nextRevision += 1;
    this.pendingRevisions.set(key, this.nextRevision);
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
