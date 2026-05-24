import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import { getDomain } from 'tldts';
import { type AccessAvailability, accessAvailability } from '../shared/budget-display';
import { MIN_BREAK_BEFORE_EARLY_MS } from '../shared/constants';
import { extrapolatedBank } from '../shared/live';
import type { Ack, StatsBundle } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { ackError, isStatsBundle } from '../shared/runtime-validation';
import { formatClock } from '../shared/time';
import type { GateKind, SessionSnapshot } from '../shared/types';
import { GatePanel } from './GatePanel';
import { Ring } from './Ring';
import { useWorkTarget, type WorkTargetState } from './use-work-tabs';
import { WorkTabControl } from './WorkTabControl';

function useActiveHost(): { host: string | null; error: boolean } {
  const [host, setHost]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [error, setError]: [boolean, Dispatch<StateUpdater<boolean>>] = useState<boolean>(false);
  useEffect((): void => {
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs: chrome.tabs.Tab[]): void => {
        const url: string | undefined = tabs[0]?.url;
        if (url === undefined || !url.startsWith('http')) {
          setHost(null);
          setError(false);
          return;
        }
        try {
          const hostname: string = new URL(url).hostname;
          setHost(getDomain(hostname) ?? hostname);
          setError(false);
        } catch {
          // Unparseable tab URL: leave the unlock button host-less.
          setHost(null);
          setError(false);
        }
      })
      .catch((): void => {
        setHost(null);
        setError(true);
      });
  }, []);
  return { host, error };
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
  affordable,
  countdown,
  pending,
  onClick,
}: {
  label: string;
  sub: string | null;
  affordable: boolean;
  countdown: string | null;
  pending: boolean;
  onClick: () => void;
}): VNode {
  return (
    <button type="button" class="spend-button" disabled={!affordable || pending} onClick={onClick}>
      <span class="spend-label">{label}</span>
      {affordable ? (
        sub !== null ? (
          <span class="spend-sub">{sub}</span>
        ) : null
      ) : (
        <span class="spend-sub">{countdown ?? 'Site access unavailable'}</span>
      )}
    </button>
  );
}

export function ActiveView({ snapshot, now }: { snapshot: SessionSnapshot; now: number }): VNode {
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [actionPending, setActionPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const work: WorkTargetState = useWorkTarget(snapshot);
  const activeSite: { host: string | null; error: boolean } = useActiveHost();
  const activeHost: string | null = activeSite.host;
  const focusedToday: { ms: number | null; error: boolean } = useFocusedTodayMs();

  const bankMs: number = extrapolatedBank(snapshot, now);
  const bankFill: number = snapshot.bankCapMs > 0 ? Math.min(1, bankMs / snapshot.bankCapMs) : 0;
  const intention: string = snapshot.config?.intention ?? '';
  const strictness: string = snapshot.config?.strictness ?? 'friction';

  const openGate: (gate: GateKind, host: string | null) => Promise<void> = async (
    gate: GateKind,
    host: string | null,
  ): Promise<void> => {
    setError(null);
    setActionPending(true);
    try {
      const ack: Ack = await sendRequest({ type: 'openGate', gate, host });
      const responseError: string | null = ackError(ack, 'Could not request action. Try again.');
      if (responseError !== null) setError(responseError);
    } catch {
      setError('Could not request that action. Try again.');
    } finally {
      setActionPending(false);
    }
  };

  const act: (req: { type: 'resumeFromPause' } | { type: 'startNextFocusEarly' }) => Promise<void> =
    async (req: { type: 'resumeFromPause' } | { type: 'startNextFocusEarly' }): Promise<void> => {
      setError(null);
      setActionPending(true);
      try {
        const ack: Ack = await sendRequest(req);
        const responseError: string | null = ackError(ack, 'Could not request action. Try again.');
        if (responseError !== null) setError(responseError);
      } catch {
        setError('Could not request that action. Try again.');
      } finally {
        setActionPending(false);
      }
    };

  const affordability: (costMs: number) => { affordable: boolean; countdown: string | null } = (
    costMs: number,
  ): { affordable: boolean; countdown: string | null } => {
    const availability: AccessAvailability = accessAvailability(snapshot, now, costMs);
    return { affordable: availability.affordable, countdown: availability.message };
  };

  const unlockAfford: { affordable: boolean; countdown: string | null } = affordability(
    snapshot.unlockCostMs,
  );
  const pauseAfford: { affordable: boolean; countdown: string | null } = affordability(
    snapshot.pauseCostMs,
  );
  const returnToWork: () => Promise<void> = async (): Promise<void> => {
    if (!work.target?.ok || work.target.sessionId === null || work.windowId === null) return;
    setActionPending(true);
    setError(null);
    try {
      setError(
        ackError(
          await sendRequest({
            type: 'returnToWork',
            sessionId: work.target.sessionId,
            windowId: work.windowId,
          }),
          'Could not return to work. Try again.',
        ),
      );
    } catch {
      setError('Could not return to work. Try again.');
    } finally {
      setActionPending(false);
      work.refresh();
    }
  };
  const breakEarlyVisible: boolean =
    snapshot.phase === 'break' &&
    snapshot.phaseStartedAt !== null &&
    now - snapshot.phaseStartedAt >= MIN_BREAK_BEFORE_EARLY_MS;

  return (
    <section class="view active-view">
      <Ring snapshot={snapshot} now={now} />
      {intention !== '' ? <p class="intention-line">{intention}</p> : null}
      <WorkTabControl snapshot={snapshot} work={work} />
      {snapshot.gate === null && work.target?.ok && work.target.state === 'ready' ? (
        <button
          type="button"
          class="start-button"
          disabled={actionPending}
          onClick={(): void => {
            void returnToWork();
          }}
        >
          Back to work
        </button>
      ) : null}
      {focusedToday.ms !== null ? (
        <p class="today-line">{Math.floor(focusedToday.ms / 60_000)} min focused today</p>
      ) : focusedToday.error ? (
        <p class="form-error" role="alert">
          Today's focus total is unavailable.
        </p>
      ) : null}
      {activeSite.error ? (
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

      {snapshot.gate !== null ? (
        <GatePanel
          key={`${snapshot.startedAt}-${snapshot.gate.openedAt}-${snapshot.gate.kind}`}
          gate={snapshot.gate}
          now={now}
          intention={intention}
          returnToWork={work.target?.ok && work.target.state === 'ready' ? returnToWork : undefined}
          returnPending={actionPending}
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
            label={`Unlock this site ${formatClock(snapshot.unlockCostMs)} - costs ${formatClock(snapshot.unlockCostMs)} credit`}
            sub={activeHost}
            affordable={unlockAfford.affordable && activeHost !== null}
            countdown={activeHost === null ? 'Open a website to unlock it' : unlockAfford.countdown}
            pending={actionPending}
            onClick={(): void => void openGate('unlockSite', activeHost)}
          />
          <SpendButton
            label={`Unlock all sites ${formatClock(snapshot.pauseCostMs)} - costs ${formatClock(snapshot.pauseCostMs)} credit`}
            sub={null}
            affordable={pauseAfford.affordable}
            countdown={pauseAfford.countdown}
            pending={actionPending}
            onClick={(): void => void openGate('pause', null)}
          />
          {strictness === 'friction' ? (
            <button
              type="button"
              class="cancel-link"
              disabled={actionPending}
              onClick={(): void => void openGate('cancel', null)}
            >
              End session
            </button>
          ) : null}
        </div>
      )}
      <p class="work-tab-hint">You can step away at any time. Site access uses credit.</p>
      {error !== null ? (
        <p class="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
