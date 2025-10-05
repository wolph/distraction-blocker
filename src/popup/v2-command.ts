import { h, type JSX } from 'preact';
import { type Dispatch, type StateUpdater, useRef, useState } from 'preact/hooks';
import type {
  CommandResponseV2,
  RetryCleanupResultCodeV2,
  SessionCommandResultCodeV2,
  SessionRequestV2,
} from '../shared/messages';
import { sendSessionRequestV2 } from '../shared/messages';
import { END_FAILED_COPY, END_SESSION_LABEL } from '../shared/session-copy';
import type { EndAuthorityV2, GateState } from '../shared/types';
import { commandErrorMessage } from './command-errors';
import type { GateCommandErrorMapper, GateRequest } from './GatePanel';

/** Every v2 session command a view sends. The start form owns `startSession`. */
export type V2CommandRequest = Exclude<SessionRequestV2, { type: 'startSession' }>;

/** The command a visible End control sends. */
export type V2EndCommand = Extract<SessionRequestV2, { type: 'requestSessionEnd' | 'openEndGate' }>;

export type V2CommandResponse = CommandResponseV2<
  SessionCommandResultCodeV2 | RetryCleanupResultCodeV2
>;

export interface V2CommandOptions {
  /** Runs once the in-flight lock is taken, before the request is sent. */
  onBegin?: () => void;
}

export interface V2Command {
  pending: boolean;
  error: string | null;
  run: (request: V2CommandRequest, fallback: string) => Promise<void>;
}

/** A reopened gate must not inherit the typed phrase, so the panel is keyed by this. */
export function gateIdentity(gate: GateState): string {
  return JSON.stringify([gate.kind, gate.host, gate.openedAt, gate.readyAt, gate.requiredPhrase]);
}

/** The command a visible End control sends, null when this authority hides End. */
export function endCommandOf(authority: EndAuthorityV2): V2EndCommand | null {
  if (authority.kind === 'immediate') return { type: 'requestSessionEnd' };
  if (authority.kind === 'friction-gate' && authority.gate === null) return { type: 'openEndGate' };
  return null;
}

/** The gate transport for every v2 surface. GatePanel defaults to the v1 channel. */
export function sendGateCommand(
  request: GateRequest,
): Promise<CommandResponseV2<SessionCommandResultCodeV2>> {
  return sendSessionRequestV2(request);
}

/**
 * Boundary cast: the panel hands back whatever the transport answered, and
 * `commandErrorMessage` is the validator built for that untrusted value. `ackError`
 * cannot do it, because it rejects any answer carrying the v2 `code` key.
 */
export const mapGateError: GateCommandErrorMapper = (
  response: unknown,
  fallback: string,
): string | null =>
  commandErrorMessage(response as CommandResponseV2<SessionCommandResultCodeV2>, fallback);

/**
 * Only an open friction End authority publishes exact cancel-gate copy. A pause or
 * unlock gate keeps the panel's own v1 label.
 */
export function gatePhraseLabel(authority: EndAuthorityV2, gate: GateState): string | undefined {
  return authority.kind === 'friction-gate' && authority.gate !== null && gate.kind === 'cancel'
    ? authority.copy.phraseLabel
    : undefined;
}

/**
 * One in-flight lock, one pending flag, and one coded error path for every v2 session
 * command. An accepted answer clears the error, a known rejected code reports the
 * worker's own text, and anything else reports the caller's fallback.
 */
export function useV2Command(options: V2CommandOptions = {}): V2Command {
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const commandInFlight: { current: boolean } = useRef<boolean>(false);

  const run: (request: V2CommandRequest, fallback: string) => Promise<void> = async (
    request: V2CommandRequest,
    fallback: string,
  ): Promise<void> => {
    if (commandInFlight.current) return;
    commandInFlight.current = true;
    options.onBegin?.();
    setError(null);
    setPending(true);
    try {
      const response: V2CommandResponse = await sendSessionRequestV2(request);
      const message: string | null = commandErrorMessage(response, fallback);
      if (message !== null) setError(message);
    } catch {
      setError(fallback);
    } finally {
      commandInFlight.current = false;
      setPending(false);
    }
  };

  return { pending, error, run };
}

/** The End control both v2 views render, null when the authority hides End. */
export function endControl(authority: EndAuthorityV2, command: V2Command): JSX.Element | null {
  const request: V2EndCommand | null = endCommandOf(authority);
  if (request === null) return null;
  return h(
    'button',
    {
      type: 'button',
      class: 'cancel-link',
      disabled: command.pending,
      onClick: (): void => void command.run(request, END_FAILED_COPY),
    },
    END_SESSION_LABEL,
  );
}
