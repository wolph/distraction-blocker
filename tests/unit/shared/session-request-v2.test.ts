import { afterEach, beforeEach, describe, expect, expectTypeOf, it, type Mock, vi } from 'vitest';
import {
  type CommandResponseV2,
  type RetryCleanupResultCodeV2,
  type SessionCommandResultCodeV2,
  type SessionRequestV2,
  type SessionResponseMapV2,
  type StartSessionResponseV2,
  sendSessionRequestV2,
} from '../../../src/shared/messages';
import type { SessionConfigV2 } from '../../../src/shared/types';
import { MANUAL_INDEFINITE_CONFIG } from './v2-runtime-fixtures';

const sendMessageMock: Mock = vi.fn();

interface ChromeHost {
  chrome?: unknown;
}

const START_SESSION: Extract<SessionRequestV2, { type: 'startSession' }> = {
  type: 'startSession',
  config: MANUAL_INDEFINITE_CONFIG,
};
const REQUEST_SESSION_END: Extract<SessionRequestV2, { type: 'requestSessionEnd' }> = {
  type: 'requestSessionEnd',
};
const OPEN_END_GATE: Extract<SessionRequestV2, { type: 'openEndGate' }> = { type: 'openEndGate' };
const ABANDON_GATE: Extract<SessionRequestV2, { type: 'abandonGate' }> = { type: 'abandonGate' };
const CONFIRM_GATE: Extract<SessionRequestV2, { type: 'confirmGate' }> = {
  type: 'confirmGate',
  typedPhrase: 'I am ending this session before: Review the release',
};
const OPEN_GATE: Extract<SessionRequestV2, { type: 'openGate' }> = {
  type: 'openGate',
  gate: 'unlockSite',
  host: 'example.com',
};
const RESUME_FROM_PAUSE: Extract<SessionRequestV2, { type: 'resumeFromPause' }> = {
  type: 'resumeFromPause',
};
const START_NEXT_FOCUS_EARLY: Extract<SessionRequestV2, { type: 'startNextFocusEarly' }> = {
  type: 'startNextFocusEarly',
};
const RETRY_TRANSITION_CLEANUP: Extract<SessionRequestV2, { type: 'retryTransitionCleanup' }> = {
  type: 'retryTransitionCleanup',
};
const RETRY_CLOSURE_CLEANUP: Extract<SessionRequestV2, { type: 'retryClosureCleanup' }> = {
  type: 'retryClosureCleanup',
};
const RETRY_DATA_CLEAR: Extract<SessionRequestV2, { type: 'retryDataClear' }> = {
  type: 'retryDataClear',
};

interface ChannelCall {
  readonly request: SessionRequestV2;
  readonly send: () => Promise<unknown>;
}

/** One entry per SessionRequestV2 member, each sent through its own generic instantiation. */
const CHANNEL_CALLS: readonly ChannelCall[] = [
  {
    request: START_SESSION,
    send: (): Promise<SessionResponseMapV2['startSession']> => sendSessionRequestV2(START_SESSION),
  },
  {
    request: REQUEST_SESSION_END,
    send: (): Promise<SessionResponseMapV2['requestSessionEnd']> =>
      sendSessionRequestV2(REQUEST_SESSION_END),
  },
  {
    request: OPEN_END_GATE,
    send: (): Promise<SessionResponseMapV2['openEndGate']> => sendSessionRequestV2(OPEN_END_GATE),
  },
  {
    request: ABANDON_GATE,
    send: (): Promise<SessionResponseMapV2['abandonGate']> => sendSessionRequestV2(ABANDON_GATE),
  },
  {
    request: CONFIRM_GATE,
    send: (): Promise<SessionResponseMapV2['confirmGate']> => sendSessionRequestV2(CONFIRM_GATE),
  },
  {
    request: OPEN_GATE,
    send: (): Promise<SessionResponseMapV2['openGate']> => sendSessionRequestV2(OPEN_GATE),
  },
  {
    request: RESUME_FROM_PAUSE,
    send: (): Promise<SessionResponseMapV2['resumeFromPause']> =>
      sendSessionRequestV2(RESUME_FROM_PAUSE),
  },
  {
    request: START_NEXT_FOCUS_EARLY,
    send: (): Promise<SessionResponseMapV2['startNextFocusEarly']> =>
      sendSessionRequestV2(START_NEXT_FOCUS_EARLY),
  },
  {
    request: RETRY_TRANSITION_CLEANUP,
    send: (): Promise<SessionResponseMapV2['retryTransitionCleanup']> =>
      sendSessionRequestV2(RETRY_TRANSITION_CLEANUP),
  },
  {
    request: RETRY_CLOSURE_CLEANUP,
    send: (): Promise<SessionResponseMapV2['retryClosureCleanup']> =>
      sendSessionRequestV2(RETRY_CLOSURE_CLEANUP),
  },
  {
    request: RETRY_DATA_CLEAR,
    send: (): Promise<SessionResponseMapV2['retryDataClear']> =>
      sendSessionRequestV2(RETRY_DATA_CLEAR),
  },
];

beforeEach((): void => {
  sendMessageMock.mockReset();
  // Boundary cast: the fake implements only the runtime slice this channel uses.
  (globalThis as ChromeHost).chrome = { runtime: { sendMessage: sendMessageMock } };
});

afterEach((): void => {
  Reflect.deleteProperty(globalThis, 'chrome');
});

describe('v2 session request channel', (): void => {
  it('pins every v2 session request variant', (): void => {
    expectTypeOf<Extract<SessionRequestV2, { type: 'startSession' }>>().toEqualTypeOf<{
      type: 'startSession';
      config: SessionConfigV2;
    }>();
    expectTypeOf<Extract<SessionRequestV2, { type: 'requestSessionEnd' }>>().toEqualTypeOf<{
      type: 'requestSessionEnd';
    }>();
    expectTypeOf<Extract<SessionRequestV2, { type: 'openEndGate' }>>().toEqualTypeOf<{
      type: 'openEndGate';
    }>();
    expectTypeOf<Extract<SessionRequestV2, { type: 'abandonGate' }>>().toEqualTypeOf<{
      type: 'abandonGate';
    }>();
    expectTypeOf<Extract<SessionRequestV2, { type: 'confirmGate' }>>().toEqualTypeOf<{
      type: 'confirmGate';
      typedPhrase: string | null;
    }>();
    expectTypeOf<Extract<SessionRequestV2, { type: 'openGate' }>>().toEqualTypeOf<{
      type: 'openGate';
      gate: 'pause' | 'unlockSite';
      host: string | null;
    }>();
    expectTypeOf<Extract<SessionRequestV2, { type: 'resumeFromPause' }>>().toEqualTypeOf<{
      type: 'resumeFromPause';
    }>();
    expectTypeOf<Extract<SessionRequestV2, { type: 'startNextFocusEarly' }>>().toEqualTypeOf<{
      type: 'startNextFocusEarly';
    }>();
    expectTypeOf<Extract<SessionRequestV2, { type: 'retryTransitionCleanup' }>>().toEqualTypeOf<{
      type: 'retryTransitionCleanup';
    }>();
    expectTypeOf<Extract<SessionRequestV2, { type: 'retryClosureCleanup' }>>().toEqualTypeOf<{
      type: 'retryClosureCleanup';
    }>();
    expectTypeOf<Extract<SessionRequestV2, { type: 'retryDataClear' }>>().toEqualTypeOf<{
      type: 'retryDataClear';
    }>();
    expectTypeOf<SessionRequestV2['type']>().toEqualTypeOf<
      | 'startSession'
      | 'requestSessionEnd'
      | 'openEndGate'
      | 'abandonGate'
      | 'confirmGate'
      | 'openGate'
      | 'resumeFromPause'
      | 'startNextFocusEarly'
      | 'retryTransitionCleanup'
      | 'retryClosureCleanup'
      | 'retryDataClear'
    >();
  });

  it('maps every request type to its v2 response', (): void => {
    expectTypeOf<SessionResponseMapV2['startSession']>().toEqualTypeOf<StartSessionResponseV2>();
    expectTypeOf<SessionResponseMapV2['requestSessionEnd']>().toEqualTypeOf<
      CommandResponseV2<SessionCommandResultCodeV2>
    >();
    expectTypeOf<SessionResponseMapV2['openEndGate']>().toEqualTypeOf<
      CommandResponseV2<SessionCommandResultCodeV2>
    >();
    expectTypeOf<SessionResponseMapV2['abandonGate']>().toEqualTypeOf<
      CommandResponseV2<SessionCommandResultCodeV2>
    >();
    expectTypeOf<SessionResponseMapV2['confirmGate']>().toEqualTypeOf<
      CommandResponseV2<SessionCommandResultCodeV2>
    >();
    expectTypeOf<SessionResponseMapV2['openGate']>().toEqualTypeOf<
      CommandResponseV2<SessionCommandResultCodeV2>
    >();
    expectTypeOf<SessionResponseMapV2['resumeFromPause']>().toEqualTypeOf<
      CommandResponseV2<SessionCommandResultCodeV2>
    >();
    expectTypeOf<SessionResponseMapV2['startNextFocusEarly']>().toEqualTypeOf<
      CommandResponseV2<SessionCommandResultCodeV2>
    >();
    expectTypeOf<SessionResponseMapV2['retryTransitionCleanup']>().toEqualTypeOf<
      CommandResponseV2<RetryCleanupResultCodeV2>
    >();
    expectTypeOf<SessionResponseMapV2['retryClosureCleanup']>().toEqualTypeOf<
      CommandResponseV2<RetryCleanupResultCodeV2>
    >();
    expectTypeOf<SessionResponseMapV2['retryDataClear']>().toEqualTypeOf<
      CommandResponseV2<RetryCleanupResultCodeV2>
    >();
    expectTypeOf<keyof SessionResponseMapV2>().toEqualTypeOf<SessionRequestV2['type']>();
  });

  it('posts every request object unchanged and returns the resolved response', async (): Promise<void> => {
    let call: ChannelCall;
    for (call of CHANNEL_CALLS) {
      sendMessageMock.mockReset();
      const resolved: { ok: true; code: 'ok' } = { ok: true, code: 'ok' };
      sendMessageMock.mockResolvedValueOnce(resolved);

      const response: unknown = await call.send();

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock.mock.calls[0]).toHaveLength(1);
      expect(sendMessageMock.mock.calls[0]?.[0]).toBe(call.request);
      expect(response).toBe(resolved);
    }
  });

  it('infers the mapped response type for each response family', async (): Promise<void> => {
    sendMessageMock.mockResolvedValue({ ok: true, code: 'ok' });

    // Asserted on the call, not on an annotated local: annotating first would make every
    // one of these true whatever the sender infers.
    expectTypeOf(
      sendSessionRequestV2(START_SESSION),
    ).resolves.toEqualTypeOf<StartSessionResponseV2>();
    expectTypeOf(sendSessionRequestV2(CONFIRM_GATE)).resolves.toEqualTypeOf<
      CommandResponseV2<SessionCommandResultCodeV2>
    >();
    expectTypeOf(sendSessionRequestV2(RETRY_DATA_CLEAR)).resolves.toEqualTypeOf<
      CommandResponseV2<RetryCleanupResultCodeV2>
    >();

    const start: StartSessionResponseV2 = await sendSessionRequestV2(START_SESSION);
    const command: CommandResponseV2<SessionCommandResultCodeV2> =
      await sendSessionRequestV2(CONFIRM_GATE);
    const retry: CommandResponseV2<RetryCleanupResultCodeV2> =
      await sendSessionRequestV2(RETRY_DATA_CLEAR);

    expect([start, command, retry]).toEqual([
      { ok: true, code: 'ok' },
      { ok: true, code: 'ok' },
      { ok: true, code: 'ok' },
    ]);
  });

  it('surfaces worker rejections verbatim instead of swallowing them', async (): Promise<void> => {
    const rejection: CommandResponseV2<SessionCommandResultCodeV2> = {
      ok: false,
      code: 'confirmation-mismatch',
      error: 'That phrase does not match.',
    };
    sendMessageMock.mockResolvedValueOnce(rejection);

    await expect(sendSessionRequestV2(CONFIRM_GATE)).resolves.toBe(rejection);
  });

  it('propagates a failed runtime transport instead of resolving', async (): Promise<void> => {
    sendMessageMock.mockRejectedValueOnce(new Error('Receiving end does not exist.'));

    await expect(sendSessionRequestV2(REQUEST_SESSION_END)).rejects.toThrow(
      'Receiving end does not exist.',
    );
  });
});
