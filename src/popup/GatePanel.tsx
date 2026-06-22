import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useState } from 'preact/hooks';
import type { Ack } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { ackError } from '../shared/runtime-validation';
import type { GateKind, GateState } from '../shared/types';
import { ReturnToWorkButton, type WorkDestination } from './ReturnToWorkButton';

type GateRequest =
  | { type: 'abandonGate' }
  | { type: 'confirmGate'; typedPhrase: string | null }
  | { type: 'forceEndGate' };

const CONFIRM_LABELS: Record<GateKind, string> = {
  pause: 'Unlock all sites',
  unlockSite: 'Unlock this site',
  cancel: 'End the session',
};

/**
 * Deliberation gate. The worker owns the timing: this panel only renders
 * gate state and refuses to enable confirm before readyAt.
 */
export function GatePanel({
  gate,
  now,
  intention,
  returnToWork,
  returnDestination,
  returnPending = false,
}: {
  gate: GateState;
  now: number;
  intention: string;
  returnToWork?: () => Promise<void>;
  returnDestination?: WorkDestination;
  returnPending?: boolean;
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

  const requestGateUpdate: (request: GateRequest) => Promise<void> = async (
    request: GateRequest,
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

  const forceEnd: () => void = (): void => {
    void requestGateUpdate({ type: 'forceEndGate' });
  };

  return (
    <div class="gate-panel">
      {intention !== '' ? <p class="gate-intention">You said: {intention}</p> : null}
      <p class="gate-wait">
        A moment to decide: <span class="time">{elapsedS}</span> of {totalS} s
      </p>
      {returnToWork !== undefined ? (
        <ReturnToWorkButton
          destination={returnDestination ?? { title: null }}
          disabled={pending || returnPending}
          onClick={(): void => void returnToWork()}
        />
      ) : (
        <button
          type="button"
          class="start-button"
          disabled={pending || returnPending}
          onClick={abandon}
        >
          Keep focusing
        </button>
      )}
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
      {gate.forceEndAvailable ? (
        <button type="button" class="gate-force-end" disabled={pending} onClick={forceEnd}>
          Ignore timeout and end anyway
        </button>
      ) : null}
      {error !== null ? (
        <p class="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
