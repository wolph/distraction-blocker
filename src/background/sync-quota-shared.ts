export const SYNC_QUOTA_BYTES_PER_ITEM: number = 8_192;

export class SyncQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncQuotaError';
  }
}
