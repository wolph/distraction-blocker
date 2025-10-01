import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useRef, useState } from 'preact/hooks';
import type {
  CommandResponseV2,
  RetryCleanupResultCodeV2,
  SessionCommandResultCodeV2,
  SessionRequestV2,
} from '../shared/messages';
import { sendSessionRequestV2 } from '../shared/messages';
import {
  DATA_CLEAR_ERROR_COPY,
  DATA_CLEAR_PENDING_COPY,
  END_FAILED_COPY,
  END_SESSION_LABEL,
  POPUP_CLOSURE_CLEANUP_COPY,
  POPUP_CLOSURE_ERROR_COPY,
  POPUP_STARTING_COPY,
  POPUP_TRANSITION_CLEANUP_COPY,
  POPUP_TRANSITION_ERROR_COPY,
  RETRY_CLEANUP_LABEL,
} from '../shared/session-copy';
import type { EndAuthorityV2, GateState, SessionSnapshotV2, SetupState } from '../shared/types';
import { commandErrorMessage } from './command-errors';
import { type GateCommandErrorMapper, GatePanel, type GateRequest } from './GatePanel';

/** Shown when a retry answer is not an exact accepted result. */
const RETRY_FAILED_COPY: string = 'Could not retry cleanup. Try again.';

const HIDDEN_AUTHORITY: EndAuthorityV2 = { kind: 'hidden' };

/** The v2 commands this view sends. Spends, phases, and starts belong elsewhere. */
type LifecycleCommandV2 = Extract<
  SessionRequestV2,
  {
    type:
      | 'requestSessionEnd'
      | 'openEndGate'
      | 'retryTransitionCleanup'
      | 'retryClosureCleanup'
      | 'retryDataClear';
  }
>;

type LifecycleResponseV2 = CommandResponseV2<SessionCommandResultCodeV2 | RetryCleanupResultCodeV2>;

/** One rendered lifecycle row: its exact copy, its End authority, and its retry. */
interface LifecycleBody {
  copy: string;
  authority: EndAuthorityV2;
  retry: LifecycleCommandV2 | null;
}

interface EndGateView {
  gate: GateState;
  title: string;
  intention: string;
}

/** Duplicated from ActiveViewV2: a reopened gate must not inherit the typed phrase. */
function gateIdentity(gate: GateState): string {
  return JSON.stringify([gate.kind, gate.host, gate.openedAt, gate.readyAt, gate.requiredPhrase]);
}

export interface LifecycleViewProps {
  snapshot: SessionSnapshotV2;
  now: number;
  dataClear:
    | SetupState['dataClear']
    | { status: 'pending' | 'error'; scope: 'all'; phase: 'browser-reset' };
}

/**
 * The all-data journal overrides every lifecycle, idle Setup included. A clear of one
 * other scope leaves the session surfaces alone, so it never reaches this view.
 */
function dataClearBody(dataClear: LifecycleViewProps['dataClear']): LifecycleBody | null {
  if (dataClear.status === 'idle' || dataClear.scope !== 'all') return null;
  if (dataClear.status === 'pending') {
    return { copy: DATA_CLEAR_PENDING_COPY, authority: HIDDEN_AUTHORITY, retry: null };
  }
  return {
    copy: DATA_CLEAR_ERROR_COPY,
    authority: HIDDEN_AUTHORITY,
    retry: { type: 'retryDataClear' },
  };
}

/** null while idle or active, which are owned by the start form and the active view. */
function lifecycleBody(snapshot: SessionSnapshotV2): LifecycleBody | null {
  const lifecycle: SessionSnapshotV2['lifecycle'] = snapshot.lifecycle;
  if (lifecycle.kind === 'starting') {
    return { copy: POPUP_STARTING_COPY, authority: lifecycle.endAuthority, retry: null };
  }
  if (lifecycle.kind === 'cleanup') {
    const copy: string =
      lifecycle.journal === 'closure' ? POPUP_CLOSURE_CLEANUP_COPY : POPUP_TRANSITION_CLEANUP_COPY;
    return { copy, authority: HIDDEN_AUTHORITY, retry: null };
  }
  if (lifecycle.kind === 'error') {
    return lifecycle.code === 'transition-cleanup-failed'
      ? {
          copy: POPUP_TRANSITION_ERROR_COPY,
          authority: HIDDEN_AUTHORITY,
          retry: { type: 'retryTransitionCleanup' },
        }
      : {
          copy: POPUP_CLOSURE_ERROR_COPY,
          authority: HIDDEN_AUTHORITY,
          retry: { type: 'retryClosureCleanup' },
        };
  }
  return null;
}

/**
 * The authority is the only gate source here: a starting snapshot may still carry a
 * pause or unlock gate, which this view must never render.
 */
function endGateView(authority: EndAuthorityV2): EndGateView | null {
  if (authority.kind !== 'friction-gate' || authority.gate === null) return null;
  return {
    gate: authority.gate,
    title: authority.copy.title,
    intention: authority.copy.intentionReminder ?? '',
  };
}

/** Duplicated from ActiveViewV2. The cutover shares one End authority helper. */
function endCommandOf(authority: EndAuthorityV2): LifecycleCommandV2 | null {
  if (authority.kind === 'immediate') return { type: 'requestSessionEnd' };
  if (authority.kind === 'friction-gate' && authority.gate === null) return { type: 'openEndGate' };
  return null;
}

/**
 * Starting, cleanup, and error states. Each row shows its exact copy, the End authority
 * the worker published for it, and the retry its journal allows. Idle and active belong
 * to the start form and the active view, so this view renders nothing for them.
 */
export function LifecycleView({ snapshot, now, dataClear }: LifecycleViewProps): VNode | null {
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const commandInFlight: { current: boolean } = useRef<boolean>(false);

  /** Every command shares one in-flight lock and one coded error path. */
  const act: (request: LifecycleCommandV2, fallback: string) => Promise<void> = async (
    request: LifecycleCommandV2,
    fallback: string,
  ): Promise<void> => {
    if (commandInFlight.current) return;
    commandInFlight.current = true;
    setError(null);
    setPending(true);
    try {
      const response: LifecycleResponseV2 = await sendSessionRequestV2(request);
      const message: string | null = commandErrorMessage(response, fallback);
      if (message !== null) setError(message);
    } catch {
      setError(fallback);
    } finally {
      commandInFlight.current = false;
      setPending(false);
    }
  };

  const sendGateCommand: (
    request: GateRequest,
  ) => Promise<CommandResponseV2<SessionCommandResultCodeV2>> = (
    request: GateRequest,
  ): Promise<CommandResponseV2<SessionCommandResultCodeV2>> => sendSessionRequestV2(request);

  /**
   * Boundary cast: the panel hands back whatever the transport answered, and
   * `commandErrorMessage` is the validator built for that untrusted value.
   */
  const mapGateError: GateCommandErrorMapper = (
    response: unknown,
    fallback: string,
  ): string | null =>
    commandErrorMessage(response as CommandResponseV2<SessionCommandResultCodeV2>, fallback);

  const body: LifecycleBody | null = dataClearBody(dataClear) ?? lifecycleBody(snapshot);
  if (body === null) return null;

  const endGate: EndGateView | null = endGateView(body.authority);
  const endCommand: LifecycleCommandV2 | null = endCommandOf(body.authority);
  const retryCommand: LifecycleCommandV2 | null = body.retry;

  const endControl: VNode | null =
    endCommand === null ? null : (
      <button
        type="button"
        class="cancel-link"
        disabled={pending}
        onClick={(): void => void act(endCommand, END_FAILED_COPY)}
      >
        {END_SESSION_LABEL}
      </button>
    );

  const retryControl: VNode | null =
    retryCommand === null ? null : (
      <button
        type="button"
        class="start-button"
        disabled={pending}
        onClick={(): void => void act(retryCommand, RETRY_FAILED_COPY)}
      >
        {RETRY_CLEANUP_LABEL}
      </button>
    );

  return (
    <section class="view lifecycle-view">
      <p class="lifecycle-view__copy">{body.copy}</p>
      {endGate !== null ? (
        <>
          <h2 class="lifecycle-view__title">{endGate.title}</h2>
          <GatePanel
            key={gateIdentity(endGate.gate)}
            gate={endGate.gate}
            now={now}
            intention={endGate.intention}
            sendCommand={sendGateCommand}
            commandError={mapGateError}
          />
        </>
      ) : retryControl !== null || endControl !== null ? (
        <div class="actions">
          {retryControl}
          {endControl}
        </div>
      ) : null}
      {error !== null ? (
        <p class="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
