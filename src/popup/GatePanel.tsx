import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useState } from 'preact/hooks';
import type { Ack } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { ackError } from '../shared/runtime-validation';
import type { GateKind, GateState } from '../shared/types';

const CONFIRM_LABELS: Record<GateKind, string> = {
  pause: 'Take pause',
  unlockSite: 'Unlock this site',
  cancel: 'End session',
};

/**
 * Deliberation gate. The worker owns the timing: this panel only renders
 * gate state and refuses to enable confirm before readyAt.
 */
export function GatePanel({
  gate,
  now,
  intention,
}: {
  gate: GateState;
  now: number;
  intention: string;
}): VNode {
  const [typed, setTyped]: [string, Dispatch<StateUpdater<string>>] = useState<string>('');
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);

  const totalS: number = Math.max(1, Math.round((gate.readyAt - gate.openedAt) / 1000));
  const elapsedS: number = Math.min(totalS, Math.max(0, Math.floor((now - gate.openedAt) / 1000)));
  const ready: boolean = now >= gate.readyAt;
  const phraseOk: boolean = gate.requiredPhrase === null || typed === gate.requiredPhrase;

  const requestGateUpdate: (
    request: { type: 'abandonGate' } | { type: 'confirmGate'; typedPhrase: string | null },
  ) => Promise<void> = async (
    request: { type: 'abandonGate' } | { type: 'confirmGate'; typedPhrase: string | null },
  ): Promise<void> => {
    setError(null);
    setPending(true);
    try {
      const ack: Ack = await sendRequest(request);
      const responseError: string | null = ackError(ack, 'Could not update the gate. Try again.');
      if (responseError !== null) setError(responseError);
    } catch {
      setError('Could not update the gate. Try again.');
    } finally {
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
      <p class="gate-wait">
        A moment to decide: <span class="time">{elapsedS}</span> of {totalS} s
      </p>
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
