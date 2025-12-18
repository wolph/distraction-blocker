/** Typed error for domain-rule violations. Workers catch by code. */
export class CoreError extends Error {
  constructor(
    public readonly code:
      | 'insufficient-budget'
      | 'break-too-short'
      | 'gate-not-ready'
      | 'gate-wrong-phrase'
      | 'not-cancelable'
      | 'invalid-rule'
      | 'invalid-schedule'
      | 'lease-order'
      | 'storage',
    message: string,
  ) {
    super(message);
    this.name = 'CoreError';
  }
}
