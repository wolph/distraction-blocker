import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { getDomain } from 'tldts';
import { MIN_BREAK_BEFORE_EARLY_MS } from '../shared/constants';
import { extrapolatedBank } from '../shared/live';
import type { StatsBundle } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import { formatClock } from '../shared/time';
import type { GateKind, SessionSnapshot } from '../shared/types';
import { GatePanel } from './GatePanel';
import { Ring } from './Ring';

function useActiveHost(): string | null {
  const [host, setHost] = useState<string | null>(null);
  useEffect((): void => {
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs: chrome.tabs.Tab[]): void => {
        const url: string | undefined = tabs[0]?.url;
        if (url === undefined || !url.startsWith('http')) return;
        try {
          const hostname: string = new URL(url).hostname;
          setHost(getDomain(hostname) ?? hostname);
        } catch {
          // Unparseable tab URL: leave the unlock button host-less.
        }
      });
  }, []);
  return host;
}

function useFocusedTodayMs(): number | null {
  const [ms, setMs] = useState<number | null>(null);
  useEffect((): void => {
    void sendRequest({ type: 'getStats', days: 1 }).then((bundle: StatsBundle): void =>
      setMs(bundle.totals.focusMsToday),
    );
  }, []);
  return ms;
}

function SpendButton({
  label,
  sub,
  affordable,
  countdown,
  onClick,
}: {
  label: string;
  sub: string | null;
  affordable: boolean;
  countdown: string | null;
  onClick: () => void;
}): VNode {
  return (
    <button type="button" class="spend-button" disabled={!affordable} onClick={onClick}>
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
  const [error, setError] = useState<string | null>(null);
  const activeHost: string | null = useActiveHost();
  const focusedTodayMs: number | null = useFocusedTodayMs();

  const bankMs: number = extrapolatedBank(snapshot, now);
  const bankFill: number = snapshot.bankCapMs > 0 ? Math.min(1, bankMs / snapshot.bankCapMs) : 0;
  const intention: string = snapshot.config?.intention ?? '';
  const strictness: string = snapshot.config?.strictness ?? 'friction';

  const openGate = (gate: GateKind, host: string | null): void => {
    void sendRequest({ type: 'openGate', gate, host }).then((ack): void => {
      if (!ack.ok) setError(ack.error);
    });
  };

  const act = (req: { type: 'resumeFromPause' } | { type: 'startNextFocusEarly' }): void => {
    void sendRequest(req).then((ack): void => {
      if (!ack.ok) setError(ack.error);
    });
  };

  const affordability = (costMs: number): { affordable: boolean; countdown: string | null } => {
    if (bankMs >= costMs) return { affordable: true, countdown: null };
    if (snapshot.bankAccrualPerMs <= 0) return { affordable: false, countdown: null };
    const waitMs: number = (costMs - bankMs) / snapshot.bankAccrualPerMs;
    return { affordable: false, countdown: `enough in ${formatClock(waitMs)}` };
  };

  const unlockAfford = affordability(snapshot.unlockCostMs);
  const pauseAfford = affordability(snapshot.pauseCostMs);
  const costMin = (ms: number): number => Math.round(ms / 60_000);
  const breakEarlyVisible: boolean =
    snapshot.phase === 'break' &&
    snapshot.phaseStartedAt !== null &&
    now - snapshot.phaseStartedAt >= MIN_BREAK_BEFORE_EARLY_MS;

  return (
    <section class="view active-view">
      <Ring snapshot={snapshot} now={now} />
      {intention !== '' ? <p class="intention-line">{intention}</p> : null}
      {focusedTodayMs !== null ? (
        <p class="today-line">{Math.floor(focusedTodayMs / 60_000)} min focused today</p>
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
          onClick={(): void => act({ type: 'resumeFromPause' })}
        >
          Resume now
        </button>
      ) : (
        <div class="actions">
          <SpendButton
            label={`Unlock this site (${costMin(snapshot.unlockCostMs)} min)`}
            sub={activeHost}
            affordable={unlockAfford.affordable && activeHost !== null}
            countdown={unlockAfford.countdown}
            onClick={(): void => openGate('unlockSite', activeHost)}
          />
          <SpendButton
            label={`Pause everything (${costMin(snapshot.pauseCostMs)} min)`}
            sub={null}
            affordable={pauseAfford.affordable}
            countdown={pauseAfford.countdown}
            onClick={(): void => openGate('pause', null)}
          />
          {breakEarlyVisible ? (
            <button
              type="button"
              class="spend-button"
              onClick={(): void => act({ type: 'startNextFocusEarly' })}
            >
              Start next focus early
            </button>
          ) : null}
          {strictness === 'friction' ? (
            <button
              type="button"
              class="cancel-link"
              onClick={(): void => openGate('cancel', null)}
            >
              End session early
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
