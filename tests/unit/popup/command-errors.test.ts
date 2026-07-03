import { describe, expect, it } from 'vitest';
import { commandErrorMessage, startErrorMessage } from '../../../src/popup/command-errors';
import type {
  CommandResponseV2,
  RetryCleanupResultCodeV2,
  SessionCommandResultCodeV2,
  StartSessionResponseV2,
} from '../../../src/shared/messages';

const START_FALLBACK: string = 'Could not start session. Try again.';
const COMMAND_FALLBACK: string = 'Could not end session. Try again.';

type StartFailureCode = Exclude<StartSessionResponseV2, { ok: true }>['code'];
type CommandFailureCode = Exclude<SessionCommandResultCodeV2 | RetryCleanupResultCodeV2, 'ok'>;

const START_FAILURE_CODES: readonly StartFailureCode[] = [
  'invalid-request',
  'website-access-lost',
  'content-registration-failed',
  'alarm-failed',
  'tab-enforcement-failed',
  'transition-cleanup-pending',
  'closure-cleanup-pending',
  'data-clear-pending',
  'work-target-not-saved',
];

const COMMAND_FAILURE_CODES: readonly CommandFailureCode[] = [
  'no-active-session',
  'end-not-allowed',
  'no-active-gate',
  'gate-not-ready',
  'confirmation-mismatch',
  'transition-cleanup-pending',
  'closure-cleanup-pending',
  'data-clear-pending',
  'retry-not-available',
];

/** A response whose `code` is an accessor, which no exact data message ever carries. */
function responseWithCodeAccessor(): unknown {
  const response: Record<string, unknown> = { ok: false, error: 'accessor error' };
  Object.defineProperty(response, 'code', {
    configurable: true,
    enumerable: true,
    get: (): string => 'invalid-request',
  });
  return response;
}

function startMessageOf(response: unknown): string | null {
  return startErrorMessage(response as StartSessionResponseV2);
}

function commandMessageOf(response: unknown): string | null {
  return commandErrorMessage(
    response as CommandResponseV2<SessionCommandResultCodeV2 | RetryCleanupResultCodeV2>,
    COMMAND_FALLBACK,
  );
}

describe('startErrorMessage', (): void => {
  it('reports no error for an accepted start', (): void => {
    expect(startMessageOf({ ok: true, code: 'ok' })).toBeNull();
  });

  it('reports the worker error text for every rejected start code', (): void => {
    for (const code of START_FAILURE_CODES) {
      expect(startMessageOf({ ok: false, code, error: `worker said ${code}` })).toBe(
        `worker said ${code}`,
      );
    }
  });

  it('reports the worker error text for a transition failure that needs cleanup', (): void => {
    expect(
      startMessageOf({
        ok: false,
        code: 'tab-enforcement-failed',
        error: 'Blocking could not start on an open tab.',
        cleanupPending: true,
      }),
    ).toBe('Blocking could not start on an open tab.');
  });

  it('falls back when the code carries an accessor instead of data', (): void => {
    expect(startMessageOf(responseWithCodeAccessor())).toBe(START_FALLBACK);
  });

  it('falls back for every malformed start response', (): void => {
    const malformed: readonly unknown[] = [
      null,
      undefined,
      'ok',
      [],
      {},
      { ok: true },
      { ok: true, code: 'ok', extra: 1 },
      { ok: 'false', code: 'invalid-request', error: 'x' },
      { ok: false, code: 'invalid-request' },
      { ok: false, code: 'invalid-request', error: '' },
      { ok: false, code: 'invalid-request', error: '   ' },
      { ok: false, code: 'no-active-session', error: 'wrong channel' },
      { ok: false, code: 'nope', error: 'unknown code' },
      { ok: false, code: 'invalid-request', error: 'x', cleanupPending: true },
      { ok: false, code: 'tab-enforcement-failed', error: 'x', cleanupPending: false },
      { ok: false, code: 'tab-enforcement-failed', error: 'x', cleanupPending: 'true' },
      Object.create({ ok: true, code: 'ok' }),
    ];

    for (const response of malformed) {
      expect(startMessageOf(response)).toBe(START_FALLBACK);
    }
  });
});

describe('commandErrorMessage', (): void => {
  it('reports no error for an accepted command', (): void => {
    expect(commandMessageOf({ ok: true, code: 'ok' })).toBeNull();
  });

  it('reports the worker error text for every rejected command code', (): void => {
    for (const code of COMMAND_FAILURE_CODES) {
      expect(commandMessageOf({ ok: false, code, error: `worker said ${code}` })).toBe(
        `worker said ${code}`,
      );
    }
  });

  it('falls back when the code carries an accessor instead of data', (): void => {
    expect(commandMessageOf(responseWithCodeAccessor())).toBe(COMMAND_FALLBACK);
  });

  it('falls back for every malformed command response', (): void => {
    const malformed: readonly unknown[] = [
      null,
      undefined,
      42,
      [],
      {},
      { ok: true, code: 'ok', error: 'unexpected' },
      { ok: false, code: 'end-not-allowed' },
      { ok: false, code: 'end-not-allowed', error: '' },
      { ok: false, code: 'invalid-request', error: 'start only' },
      { ok: false, code: 'end-not-allowed', error: 'x', cleanupPending: true },
      { ok: false, code: 'nope', error: 'unknown code' },
    ];

    for (const response of malformed) {
      expect(commandMessageOf(response)).toBe(COMMAND_FALLBACK);
    }
  });
});
