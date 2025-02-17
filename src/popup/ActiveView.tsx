import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import { getDomain } from 'tldts';
import { msUntilNextEarnedMinute } from '../core/budget';
import { MIN_BREAK_BEFORE_EARLY_MS } from '../shared/constants';
import { extrapolatedBank } from '../shared/live';
import type { Ack, StatsBundle } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { formatClock } from '../shared/time';
import type { GateKind, SessionSnapshot } from '../shared/types';
import { GatePanel } from './GatePanel';
import { Ring } from './Ring';

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
        setMs(bundle.totals.focusMsToday);
        setError(false);
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
        <span class="spend-sub">{countdown ?? 'earn pause time by focusing'}</span>
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
      if (!ack.ok) setError(ack.error);
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
        if (!ack.ok) setError(ack.error);
      } catch {
        setError('Could not request that action. Try again.');
      } finally {
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
  const costMin: (ms: number) => number = (ms: number): number => Math.round(ms / 60_000);
  const breakEarlyVisible: boolean =
    snapshot.phase === 'break' &&
    snapshot.phaseStartedAt !== null &&
    now - snapshot.phaseStartedAt >= MIN_BREAK_BEFORE_EARLY_MS;

  return (
    <section class="view active-view">
      <Ring snapshot={snapshot} now={now} />
      {intention !== '' ? <p class="intention-line">{intention}</p> : null}
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
        <span class="meter-label">{formatClock(bankMs)} pause banked</span>
      </div>

      {snapshot.gate !== null ? (
        <GatePanel gate={snapshot.gate} now={now} intention={intention} />
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
            label={`Unlock this site ${costMin(snapshot.unlockCostMs)} min`}
            sub={activeHost}
            affordable={unlockAfford.affordable && activeHost !== null}
            countdown={unlockAfford.countdown}
            pending={actionPending}
            onClick={(): void => void openGate('unlockSite', activeHost)}
          />
          <SpendButton
            label={`Pause everything ${costMin(snapshot.pauseCostMs)} min`}
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
      {error !== null ? (
        <p class="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
