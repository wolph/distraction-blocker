import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useRef, useState } from 'preact/hooks';
import { getDomain } from 'tldts';
import { msUntilNextEarnedMinute } from '../core/budget';
import { MIN_BREAK_BEFORE_EARLY_MS } from '../shared/constants';
import { growBank } from '../shared/live';
import type { StatsBundle } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { isStatsBundle } from '../shared/runtime-validation';
import { ACTION_FAILED_COPY } from '../shared/session-copy';
import { formatClock } from '../shared/time';
import type { EndAuthorityV2, GateState, SessionSnapshotV2 } from '../shared/types';
import { ClockStack } from './ClockStack';
import { GatePanel } from './GatePanel';
import {
  endControl,
  gateIdentity,
  gateIntention,
  gatePhraseLabel,
  mapGateError,
  sendGateCommand,
  useV2Command,
  type V2Command,
} from './v2-command';

type ActiveHostState =
  | { status: 'loading' }
  | { status: 'ready'; host: string }
  | { status: 'unsupported' }
  | { status: 'error' };

/** The active tab's host, for the unlock control's own wording. */
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

/** Today's focus total. Stats reads are a non-session request, so they stay on sendRequest. */
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

/** The open cancel gate carried by End authority, absent for every other authority. */
function endGateOf(authority: EndAuthorityV2): GateState | null {
  return authority.kind === 'friction-gate' ? authority.gate : null;
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

export interface ActiveViewProps {
  snapshot: SessionSnapshotV2;
  now: number;
}

export function ActiveView({ snapshot, now }: ActiveViewProps): VNode {
  const viewRef: { current: HTMLElement | null } = useRef<HTMLElement | null>(null);
  /** Disabling in the same tick keeps a second click from racing the pending commit. */
  const command: V2Command = useV2Command({
    onBegin: (): void => {
      for (const button of viewRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []) {
        button.disabled = true;
      }
    },
  });
  const activeSite: ActiveHostState = useActiveHost();
  const activeHost: string | null = activeSite.status === 'ready' ? activeSite.host : null;
  const focusedToday: { ms: number | null; error: boolean } = useFocusedTodayMs();

  /** Grown to `now` so the meter moves between published snapshots. */
  const bankMs: number = growBank(
    snapshot.bankMs,
    snapshot.bankAccrualPerMs,
    snapshot.bankCapMs,
    snapshot.at,
    now,
  );
  const bankFill: number = snapshot.bankCapMs > 0 ? Math.min(1, bankMs / snapshot.bankCapMs) : 0;
  const intention: string = snapshot.config?.intention ?? '';
  const authority: EndAuthorityV2 = snapshot.lifecycle.endAuthority;
  const activeGate: GateState | null = snapshot.gate ?? endGateOf(authority);

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
      countdown: waitMs === null ? null : `Ready in ${formatClock(waitMs)}`,
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
    value.affordable ? null : (value.countdown ?? 'earn site access credit by focusing');
  const pendingReason: string | null = command.pending ? 'Action in progress' : null;
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

  const endAction: VNode | null = endControl(authority, command);

  const phaseControls: VNode | null =
    snapshot.phase === 'paused' ? (
      <button
        type="button"
        class="start-button"
        disabled={command.pending}
        onClick={(): void => void command.run({ type: 'resumeFromPause' }, ACTION_FAILED_COPY)}
      >
        Resume now
      </button>
    ) : snapshot.phase === 'break' ? (
      breakEarlyVisible ? (
        <button
          type="button"
          class="spend-button"
          disabled={command.pending}
          onClick={(): void =>
            void command.run({ type: 'startNextFocusEarly' }, ACTION_FAILED_COPY)
          }
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
            void command.run(
              { type: 'openGate', gate: 'unlockSite', host: activeHost },
              ACTION_FAILED_COPY,
            )
          }
        />
        <SpendButton
          label={`Pause blocking for ${costMin(snapshot.pauseCostMs)} min`}
          sub={null}
          disabledReason={pauseDisabledReason}
          onClick={(): void =>
            void command.run({ type: 'openGate', gate: 'pause', host: null }, ACTION_FAILED_COPY)
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
        <span class="meter-label">{formatClock(bankMs)} site access credit</span>
      </div>

      {activeGate !== null ? (
        <GatePanel
          key={gateIdentity(activeGate)}
          gate={activeGate}
          now={now}
          intention={gateIntention(authority, activeGate, snapshot.config)}
          phraseLabel={gatePhraseLabel(authority, activeGate)}
          sendCommand={sendGateCommand}
          commandError={mapGateError}
        />
      ) : phaseControls !== null || endAction !== null ? (
        <div class="actions">
          {phaseControls}
          {endAction}
        </div>
      ) : null}
      {command.error !== null ? (
        <p class="form-error" role="alert">
          {command.error}
        </p>
      ) : null}
    </section>
  );
}
