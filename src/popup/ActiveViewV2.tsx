import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useRef, useState } from 'preact/hooks';
import { getDomain } from 'tldts';
import { msUntilNextEarnedMinute } from '../core/budget';
import { MIN_BREAK_BEFORE_EARLY_MS } from '../shared/constants';
import type {
  CommandResponseV2,
  SessionCommandResultCodeV2,
  SessionRequestV2,
  StatsBundle,
} from '../shared/messages';
import { sendRequest, sendSessionRequestV2 } from '../shared/messages';
import { isStatsBundle } from '../shared/runtime-validation';
import { END_FAILED_COPY, END_SESSION_LABEL } from '../shared/session-copy';
import { formatClock } from '../shared/time';
import type { EndAuthorityV2, GateState, SessionSnapshotV2 } from '../shared/types';
import { ClockStack } from './ClockStack';
import { commandErrorMessage } from './command-errors';
import { type GateCommandErrorMapper, GatePanel, type GateRequest } from './GatePanel';

/** Shown when a spend, resume, or break command does not come back accepted. */
const ACTION_FAILED_COPY: string = 'Could not request that action. Try again.';

type ActiveHostState =
  | { status: 'loading' }
  | { status: 'ready'; host: string }
  | { status: 'unsupported' }
  | { status: 'error' };

/** The v2 session commands this view sends. Gate updates and retries belong elsewhere. */
type ActiveCommandV2 = Extract<
  SessionRequestV2,
  {
    type:
      | 'requestSessionEnd'
      | 'openEndGate'
      | 'openGate'
      | 'resumeFromPause'
      | 'startNextFocusEarly';
  }
>;

/** Duplicated from the v1 ActiveView. The cutover deletes the v1 copy. */
function useActiveHost(): ActiveHostState {
  const [state, setState]: [ActiveHostState, Dispatch<StateUpdater<ActiveHostState>>] =
    useState<ActiveHostState>({ status: 'loading' });
  useEffect((): void => {
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs: chrome.tabs.Tab[]): void => {
        const url: string | undefined = tabs[0]?.url;
        if (url === undefined) {
          setState({ status: 'unsupported' });
          return;
        }
        try {
          const parsed: URL = new URL(url);
          if (
            (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
            parsed.hostname === ''
          ) {
            setState({ status: 'unsupported' });
            return;
          }
          setState({ status: 'ready', host: getDomain(parsed.hostname) ?? parsed.hostname });
        } catch {
          setState({ status: 'unsupported' });
        }
      })
      .catch((): void => {
        setState({ status: 'error' });
      });
  }, []);
  return state;
}

/** Duplicated from the v1 ActiveView. Stats reads stay on the v1 request channel. */
function useFocusedTodayMs(): { ms: number | null; error: boolean } {
  const [ms, setMs]: [number | null, Dispatch<StateUpdater<number | null>>] = useState<
    number | null
  >(null);
  const [error, setError]: [boolean, Dispatch<StateUpdater<boolean>>] = useState<boolean>(false);
  useEffect((): void => {
    void sendRequest({ type: 'getStats', days: 1 })
      .then((bundle: StatsBundle): void => {
        if (isStatsBundle(bundle)) {
          setMs(bundle.totals.focusMsToday);
          setError(false);
        } else {
          setMs(null);
          setError(true);
        }
      })
      .catch((): void => {
        setMs(null);
        setError(true);
      });
  }, []);
  return { ms, error };
}

/** v2 mirror of extrapolatedBank, which only accepts the v1 snapshot shape. */
function extrapolatedBankV2(snapshot: SessionSnapshotV2, nowMs: number): number {
  const grown: number =
    snapshot.bankMs + Math.max(0, nowMs - snapshot.at) * snapshot.bankAccrualPerMs;
  return Math.min(snapshot.bankCapMs, grown);
}

function gateIdentity(gate: GateState): string {
  return JSON.stringify([gate.kind, gate.host, gate.openedAt, gate.readyAt, gate.requiredPhrase]);
}

/** The open cancel gate carried by End authority, absent for every other authority. */
function endGateOf(authority: EndAuthorityV2): GateState | null {
  return authority.kind === 'friction-gate' ? authority.gate : null;
}

/** The command a visible End control sends, null when this authority hides End. */
function endCommandOf(authority: EndAuthorityV2): ActiveCommandV2 | null {
  if (authority.kind === 'immediate') return { type: 'requestSessionEnd' };
  if (authority.kind === 'friction-gate' && authority.gate === null) return { type: 'openEndGate' };
  return null;
}

function SpendButton({
  label,
  sub,
  disabledReason,
  onClick,
}: {
  label: string;
  sub: string | null;
  disabledReason: string | null;
  onClick: () => void;
}): VNode {
  return (
    <button type="button" class="spend-button" disabled={disabledReason !== null} onClick={onClick}>
      <span class="spend-label">{label}</span>
      {disabledReason !== null ? (
        <span class="spend-sub">{disabledReason}</span>
      ) : sub !== null ? (
        <span class="spend-sub">{sub}</span>
      ) : null}
    </button>
  );
}

export interface ActiveViewV2Props {
  snapshot: SessionSnapshotV2;
  now: number;
}

export function ActiveViewV2({ snapshot, now }: ActiveViewV2Props): VNode {
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [actionPending, setActionPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const actionInFlight: { current: boolean } = useRef<boolean>(false);
  const viewRef: { current: HTMLElement | null } = useRef<HTMLElement | null>(null);
  const activeSite: ActiveHostState = useActiveHost();
  const activeHost: string | null = activeSite.status === 'ready' ? activeSite.host : null;
  const focusedToday: { ms: number | null; error: boolean } = useFocusedTodayMs();

  const beginAction: () => boolean = (): boolean => {
    if (actionInFlight.current) return false;
    actionInFlight.current = true;
    for (const button of viewRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []) {
      button.disabled = true;
    }
    setError(null);
    setActionPending(true);
    return true;
  };

  const bankMs: number = extrapolatedBankV2(snapshot, now);
  const bankFill: number = snapshot.bankCapMs > 0 ? Math.min(1, bankMs / snapshot.bankCapMs) : 0;
  const intention: string = snapshot.config?.intention ?? '';
  const authority: EndAuthorityV2 = snapshot.lifecycle.endAuthority;
  const endCommand: ActiveCommandV2 | null = endCommandOf(authority);
  const activeGate: GateState | null = snapshot.gate ?? endGateOf(authority);

  /** Every session command shares one in-flight lock and one coded error path. */
  const act: (request: ActiveCommandV2, fallback: string) => Promise<void> = async (
    request: ActiveCommandV2,
    fallback: string,
  ): Promise<void> => {
    if (!beginAction()) return;
    try {
      const response: CommandResponseV2<SessionCommandResultCodeV2> =
        await sendSessionRequestV2(request);
      const message: string | null = commandErrorMessage(response, fallback);
      if (message !== null) setError(message);
    } catch {
      setError(fallback);
    } finally {
      actionInFlight.current = false;
      setActionPending(false);
    }
  };

  /** Narrowed per member so each call resolves its own mapped v2 response type. */
  const sendGateCommand: (
    request: GateRequest,
  ) => Promise<CommandResponseV2<SessionCommandResultCodeV2>> = (
    request: GateRequest,
  ): Promise<CommandResponseV2<SessionCommandResultCodeV2>> =>
    request.type === 'abandonGate' ? sendSessionRequestV2(request) : sendSessionRequestV2(request);

  /**
   * Boundary cast: the panel hands back whatever the transport answered, and
   * `commandErrorMessage` is the validator built for that untrusted value. `ackError`
   * cannot do it, because it rejects any answer carrying the v2 `code` key.
   */
  const mapGateError: GateCommandErrorMapper = (
    response: unknown,
    fallback: string,
  ): string | null =>
    commandErrorMessage(response as CommandResponseV2<SessionCommandResultCodeV2>, fallback);

  const affordability: (costMs: number) => { affordable: boolean; countdown: string | null } = (
    costMs: number,
  ): { affordable: boolean; countdown: string | null } => {
    if (bankMs >= costMs) return { affordable: true, countdown: null };
    const waitMs: number | null = msUntilNextEarnedMinute(
      bankMs,
      snapshot.bankAccrualPerMs,
      snapshot.bankCapMs,
    );
    return {
      affordable: false,
      countdown: waitMs === null ? null : `ready in ${formatClock(waitMs)}`,
    };
  };

  const unlockAfford: { affordable: boolean; countdown: string | null } = affordability(
    snapshot.unlockCostMs,
  );
  const pauseAfford: { affordable: boolean; countdown: string | null } = affordability(
    snapshot.pauseCostMs,
  );
  const affordabilityReason: (value: {
    affordable: boolean;
    countdown: string | null;
  }) => string | null = (value: {
    affordable: boolean;
    countdown: string | null;
  }): string | null =>
    value.affordable ? null : (value.countdown ?? 'earn pause time by focusing');
  const pendingReason: string | null = actionPending ? 'Action in progress' : null;
  const activeSiteReason: string | null =
    activeSite.status === 'loading'
      ? 'Checking the active site'
      : activeSite.status === 'unsupported'
        ? 'Open a regular website to unlock it'
        : activeSite.status === 'error'
          ? 'Could not identify the active site'
          : null;
  const unlockDisabledReason: string | null =
    pendingReason ?? activeSiteReason ?? affordabilityReason(unlockAfford);
  const pauseDisabledReason: string | null = pendingReason ?? affordabilityReason(pauseAfford);
  const costMin: (ms: number) => number = (ms: number): number => Math.round(ms / 60_000);
  const breakEarlyVisible: boolean =
    snapshot.phase === 'break' &&
    snapshot.phaseStartedAt !== null &&
    now - snapshot.phaseStartedAt >= MIN_BREAK_BEFORE_EARLY_MS;

  const endControl: VNode | null =
    endCommand === null ? null : (
      <button
        type="button"
        class="cancel-link"
        disabled={actionPending}
        onClick={(): void => void act(endCommand, END_FAILED_COPY)}
      >
        {END_SESSION_LABEL}
      </button>
    );

  const phaseControls: VNode | null =
    snapshot.phase === 'paused' ? (
      <button
        type="button"
        class="start-button"
        disabled={actionPending}
        onClick={(): void => void act({ type: 'resumeFromPause' }, ACTION_FAILED_COPY)}
      >
        Resume now
      </button>
    ) : snapshot.phase === 'break' ? (
      breakEarlyVisible ? (
        <button
          type="button"
          class="spend-button"
          disabled={actionPending}
          onClick={(): void => void act({ type: 'startNextFocusEarly' }, ACTION_FAILED_COPY)}
        >
          Start next focus early
        </button>
      ) : null
    ) : (
      <>
        <SpendButton
          label={`Unlock this site for ${costMin(snapshot.unlockCostMs)} min`}
          sub={activeHost}
          disabledReason={unlockDisabledReason}
          onClick={(): void =>
            void act({ type: 'openGate', gate: 'unlockSite', host: activeHost }, ACTION_FAILED_COPY)
          }
        />
        <SpendButton
          label={`Pause blocking for ${costMin(snapshot.pauseCostMs)} min`}
          sub={null}
          disabledReason={pauseDisabledReason}
          onClick={(): void =>
            void act({ type: 'openGate', gate: 'pause', host: null }, ACTION_FAILED_COPY)
          }
        />
      </>
    );

  return (
    <section ref={viewRef} class="view active-view">
      <ClockStack snapshot={snapshot} now={now} />
      {intention !== '' ? <p class="intention-line">{intention}</p> : null}
      {focusedToday.ms !== null ? (
        <p class="today-line">{Math.floor(focusedToday.ms / 60_000)} min focused today</p>
      ) : focusedToday.error ? (
        <p class="form-error" role="alert">
          Today's focus total is unavailable.
        </p>
      ) : null}
      {activeSite.status === 'error' ? (
        <p class="form-error" role="alert">
          Could not identify the active site.
        </p>
      ) : null}

      <div class="meter">
        <div class="meter-bar">
          <div class="meter-fill" style={{ width: `${bankFill * 100}%` }} />
        </div>
        <span class="meter-label">{formatClock(bankMs)} pause banked</span>
      </div>

      {activeGate !== null ? (
        <GatePanel
          key={gateIdentity(activeGate)}
          gate={activeGate}
          now={now}
          intention={intention}
          sendCommand={sendGateCommand}
          commandError={mapGateError}
        />
      ) : phaseControls !== null || endControl !== null ? (
        <div class="actions">
          {phaseControls}
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
