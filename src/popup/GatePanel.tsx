import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useRef, useState } from 'preact/hooks';
import type { Ack, CommandResponseV2, SessionCommandResultCodeV2 } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { ackError } from '../shared/runtime-validation';
import type { GateKind, GateState } from '../shared/types';

export type GateRequest =
  | { type: 'abandonGate' }
  | { type: 'confirmGate'; typedPhrase: string | null };

/** Both transports answer this panel: v1 with an Ack, v2 with a coded command result. */
export type GateCommandSender = (
  request: GateRequest,
) => Promise<Ack | CommandResponseV2<SessionCommandResultCodeV2>>;

/**
 * Maps one transport answer to its message, or null when the command was accepted.
 * The shapes differ per transport, so the sender's mapper travels with it: `ackError`
 * rejects any v1 Ack carrying extra keys, which every coded v2 answer does.
 */
export type GateCommandErrorMapper = (response: unknown, fallback: string) => string | null;

const CONFIRM_LABELS: Record<GateKind, string> = {
  pause: 'Take the pause',
  unlockSite: 'Unlock this site',
  cancel: 'End the session',
};

/**
 * Deliberation gate. The worker owns the timing: this panel only renders
 * gate state and refuses to enable confirm before readyAt.
 */
export interface GatePanelProps {
  gate: GateState;
  now: number;
  intention: string;
  /** v2 surfaces pass the v2 session channel. v1 callers keep the live sendRequest. */
  sendCommand?: GateCommandSender;
  /** Must match the sender: `commandErrorMessage` for v2, `ackError` for v1. */
  commandError?: GateCommandErrorMapper;
}

export function GatePanel({
  gate,
  now,
  intention,
  sendCommand = sendRequest,
  commandError = ackError,
}: GatePanelProps): VNode {
  const [typed, setTyped]: [string, Dispatch<StateUpdater<string>>] = useState<string>('');
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const requestInFlight: { current: boolean } = useRef<boolean>(false);

  const totalS: number = Math.max(1, Math.round((gate.readyAt - gate.openedAt) / 1000));
  const elapsedS: number = Math.min(totalS, Math.max(0, Math.floor((now - gate.openedAt) / 1000)));
  /** A gate whose ready moment precedes its opening is not a deliberation window. */
  const ready: boolean = gate.readyAt >= gate.openedAt && now >= gate.readyAt;
  const phraseOk: boolean = gate.requiredPhrase === null || typed === gate.requiredPhrase;

  const requestGateUpdate: (request: GateRequest) => Promise<void> = async (
    request: GateRequest,
  ): Promise<void> => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setError(null);
    setPending(true);
    try {
      const response: Ack | CommandResponseV2<SessionCommandResultCodeV2> =
        await sendCommand(request);
      const responseError: string | null = commandError(
        response,
        'Could not update the gate. Try again.',
      );
      if (responseError !== null) setError(responseError);
    } catch {
      setError('Could not update the gate. Try again.');
    } finally {
      requestInFlight.current = false;
      setPending(false);
    }
  };

  const abandon: () => void = (): void => {
    void requestGateUpdate({ type: 'abandonGate' });
  };

  const confirm: () => void = (): void => {
    void requestGateUpdate({
      type: 'confirmGate',
      typedPhrase: gate.requiredPhrase === null ? null : typed,
    });
  };

  return (
    <div class="gate-panel">
      {intention !== '' ? <p class="gate-intention">You said: {intention}</p> : null}
      {!ready ? (
        <p class="gate-wait">
          A moment to decide: <span class="time">{elapsedS}</span> of {totalS} s
        </p>
      ) : null}
      <button type="button" class="start-button" disabled={pending} onClick={abandon}>
        Never mind, back to work
      </button>
      {gate.requiredPhrase !== null ? (
        <label class="gate-phrase">
          <span class="radio-hint">Type: {gate.requiredPhrase}</span>
          <input
            type="text"
            value={typed}
            onInput={(e: Event): void => setTyped((e.currentTarget as HTMLInputElement).value)}
          />
        </label>
      ) : null}
      <button
        type="button"
        class="gate-confirm"
        disabled={pending || !ready || !phraseOk}
        onClick={confirm}
      >
        {CONFIRM_LABELS[gate.kind]}
      </button>
      {error !== null ? (
        <p class="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
