import type { VNode } from 'preact';
import { useState } from 'preact/hooks';
import { sendRequest } from '../shared/messages';
import type { GateKind, GateState } from '../shared/types';

const CONFIRM_LABELS: Record<GateKind, string> = {
  pause: 'Take break',
  unlockSite: 'Unlock it',
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
  const [typed, setTyped] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const totalS: number = Math.max(1, Math.round((gate.readyAt - gate.openedAt) / 1000));
  const elapsedS: number = Math.min(totalS, Math.max(0, Math.floor((now - gate.openedAt) / 1000)));
  const ready: boolean = now >= gate.readyAt;
  const phraseOk: boolean = gate.requiredPhrase === null || typed === gate.requiredPhrase;

  const abandon = (): void => {
    void sendRequest({ type: 'abandonGate' });
  };

  const confirm = async (): Promise<void> => {
    const ack = await sendRequest({
      type: 'confirmGate',
      typedPhrase: gate.requiredPhrase === null ? null : typed,
    });
    if (!ack.ok) setError(ack.error);
  };

  return (
    <div class="gate-panel">
      {intention !== '' ? <p class="gate-intention">You said: {intention}</p> : null}
      <p class="gate-wait">
        A moment to decide: <span class="time">{elapsedS}</span> of {totalS} s
      </p>
      <button type="button" class="start-button" onClick={abandon}>
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
        disabled={!ready || !phraseOk}
        onClick={(): void => void confirm()}
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
