import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useRef, useState } from 'preact/hooks';
import { getDomain } from 'tldts';
import { msUntilNextEarnedMinute } from '../core/budget';
import { MIN_BREAK_BEFORE_EARLY_MS } from '../shared/constants';
import { extrapolatedBank } from '../shared/live';
import type { Ack, StatsBundle } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { ackError, isStatsBundle } from '../shared/runtime-validation';
import { formatClock } from '../shared/time';
import type { GateKind, SessionSnapshot } from '../shared/types';
import { GatePanel } from './GatePanel';
import { Ring } from './Ring';

type ActiveHostState =
  | { status: 'loading' }
  | { status: 'ready'; host: string }
  | { status: 'unsupported' }
  | { status: 'error' };

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

function gateIdentity(gate: NonNullable<SessionSnapshot['gate']>): string {
  return `${gate.kind}\u0000${gate.host ?? ''}\u0000${gate.openedAt}\u0000${gate.readyAt}\u0000${gate.requiredPhrase ?? ''}`;
}

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

export function ActiveView({ snapshot, now }: { snapshot: SessionSnapshot; now: number }): VNode {
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

  const bankMs: number = extrapolatedBank(snapshot, now);
  const bankFill: number = snapshot.bankCapMs > 0 ? Math.min(1, bankMs / snapshot.bankCapMs) : 0;
  const intention: string = snapshot.config?.intention ?? '';
  const strictness: string = snapshot.config?.strictness ?? 'friction';

  const openGate: (gate: GateKind, host: string | null) => Promise<void> = async (
    gate: GateKind,
    host: string | null,
  ): Promise<void> => {
    if (!beginAction()) return;
    try {
      const ack: Ack = await sendRequest({ type: 'openGate', gate, host });
      const responseError: string | null = ackError(ack, 'Could not request action. Try again.');
      if (responseError !== null) setError(responseError);
    } catch {
      setError('Could not request that action. Try again.');
    } finally {
      actionInFlight.current = false;
      setActionPending(false);
    }
  };

  const act: (
    req:
      | { type: 'resumeFromPause' }
      | { type: 'startNextFocusEarly' }
      | { type: 'requestSessionEnd' },
  ) => Promise<void> = async (
    req:
      | { type: 'resumeFromPause' }
      | { type: 'startNextFocusEarly' }
      | { type: 'requestSessionEnd' },
  ): Promise<void> => {
    if (!beginAction()) return;
    try {
      const ack: Ack = await sendRequest(req);
      const responseError: string | null = ackError(ack, 'Could not request action. Try again.');
      if (responseError !== null) setError(responseError);
    } catch {
      setError('Could not request that action. Try again.');
    } finally {
      actionInFlight.current = false;
      setActionPending(false);
    }
  };

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

  return (
    <section ref={viewRef} class="view active-view">
      <Ring snapshot={snapshot} now={now} />
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

      {snapshot.gate !== null ? (
        <GatePanel
          key={gateIdentity(snapshot.gate)}
          gate={snapshot.gate}
          now={now}
          intention={intention}
        />
      ) : snapshot.phase === 'paused' ? (
        <button
          type="button"
          class="start-button"
          disabled={actionPending}
          onClick={(): void => void act({ type: 'resumeFromPause' })}
        >
          Resume now
        </button>
      ) : snapshot.phase === 'break' ? (
        breakEarlyVisible ? (
          <div class="actions">
            <button
              type="button"
              class="spend-button"
              disabled={actionPending}
              onClick={(): void => void act({ type: 'startNextFocusEarly' })}
            >
              Start next focus early
            </button>
          </div>
        ) : null
      ) : (
        <div class="actions">
          <SpendButton
            label={`Unlock this site for ${costMin(snapshot.unlockCostMs)} min`}
            sub={activeHost}
            disabledReason={unlockDisabledReason}
            onClick={(): void => void openGate('unlockSite', activeHost)}
          />
          <SpendButton
            label={`Pause blocking for ${costMin(snapshot.pauseCostMs)} min`}
            sub={null}
            disabledReason={pauseDisabledReason}
            onClick={(): void => void openGate('pause', null)}
          />
          {strictness !== 'hard' ? (
            <button
              type="button"
              class="cancel-link"
              disabled={actionPending}
              onClick={(): void => void act({ type: 'requestSessionEnd' })}
            >
              End session
            </button>
          ) : null}
        </div>
      )}
      {error !== null ? (
        <p class="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
