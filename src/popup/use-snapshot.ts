import { useEffect, useState } from 'preact/hooks';
import { sendRequest } from '../shared/messages';
import type { SessionSnapshot } from '../shared/types';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isCycleConfig(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeNumber(value.focusMin) &&
    isNonNegativeNumber(value.shortBreakMin) &&
    isNonNegativeNumber(value.longBreakMin) &&
    Number.isInteger(value.longEvery) &&
    isNonNegativeNumber(value.longEvery)
  );
}

function isSessionConfig(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.mode === 'blacklist' || value.mode === 'whitelist') &&
    (value.strictness === 'hard' || value.strictness === 'friction') &&
    isNonNegativeNumber(value.durationMin) &&
    (value.cycling === null || isCycleConfig(value.cycling)) &&
    typeof value.intention === 'string' &&
    (value.source === 'manual' || value.source === 'schedule') &&
    isNullableString(value.scheduleEntryId)
  );
}

function isGate(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.kind === 'pause' || value.kind === 'unlockSite' || value.kind === 'cancel') &&
    isNullableString(value.host) &&
    isFiniteNumber(value.openedAt) &&
    isFiniteNumber(value.readyAt) &&
    isNullableString(value.requiredPhrase)
  );
}

function isUnlock(value: unknown): boolean {
  return isRecord(value) && typeof value.host === 'string' && isFiniteNumber(value.until);
}

function isNextSchedule(value: unknown): boolean {
  return isRecord(value) && typeof value.entryId === 'string' && isFiniteNumber(value.startsAt);
}

function hasCoherentPhase(value: UnknownRecord): boolean {
  if (value.phase === 'idle') {
    return (
      value.config === null &&
      value.startedAt === null &&
      value.phaseStartedAt === null &&
      value.phaseEndsAt === null &&
      value.sessionEndsAt === null
    );
  }
  return (
    (value.phase === 'focus' || value.phase === 'break' || value.phase === 'paused') &&
    isSessionConfig(value.config) &&
    isFiniteNumber(value.startedAt) &&
    isFiniteNumber(value.phaseStartedAt) &&
    isFiniteNumber(value.phaseEndsAt) &&
    isFiniteNumber(value.sessionEndsAt)
  );
}

function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  if (!isRecord(value) || !hasCoherentPhase(value)) return false;
  return (
    isFiniteNumber(value.at) &&
    Number.isInteger(value.cycleIndex) &&
    isNonNegativeNumber(value.cycleIndex) &&
    isNonNegativeNumber(value.bankMs) &&
    isNonNegativeNumber(value.bankAccrualPerMs) &&
    isNonNegativeNumber(value.bankCapMs) &&
    isNonNegativeNumber(value.pauseCostMs) &&
    isNonNegativeNumber(value.unlockCostMs) &&
    Array.isArray(value.activeUnlocks) &&
    value.activeUnlocks.every(isUnlock) &&
    (value.gate === null || isGate(value.gate)) &&
    Number.isInteger(value.attemptsToday) &&
    isNonNegativeNumber(value.attemptsToday) &&
    typeof value.scheduleActive === 'boolean' &&
    (value.nextSchedule === null || isNextSchedule(value.nextSchedule))
  );
}

/**
 * Subscribe to the worker's session snapshot. The initial value comes from a
 * getSnapshot request, updates arrive as stateChanged broadcasts, and `now`
 * ticks every 250 ms so views can extrapolate with src/shared/live.ts.
 */
export function useSnapshot(): {
  snapshot: SessionSnapshot | null;
  now: number;
  error: boolean;
} {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const [error, setError] = useState<boolean>(false);

  useEffect((): (() => void) => {
    void sendRequest({ type: 'getSnapshot' })
      .then((value: unknown): void => {
        if (isSessionSnapshot(value)) {
          setSnapshot(value);
          setError(false);
          return;
        }
        setSnapshot(null);
        setError(true);
      })
      .catch((): void => {
        setSnapshot(null);
        setError(true);
      });
    const onMsg = (msg: unknown): void => {
      if (!isRecord(msg) || msg.type !== 'stateChanged') return;
      if (isSessionSnapshot(msg.snapshot)) {
        setSnapshot(msg.snapshot);
        setError(false);
        return;
      }
      setSnapshot(null);
      setError(true);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    const timer: ReturnType<typeof setInterval> = setInterval((): void => setNow(Date.now()), 250);
    return (): void => {
      chrome.runtime.onMessage.removeListener(onMsg);
      clearInterval(timer);
    };
  }, []);

  return { snapshot, now, error };
}
