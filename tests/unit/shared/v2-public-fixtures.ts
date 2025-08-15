import { emptySnapshotV2 } from '../../../src/shared/constants';
import type { EndAuthorityV2, SessionConfigV2, SessionSnapshotV2 } from '../../../src/shared/types';
import { MANUAL_TIMED_CONFIG, NOW } from './v2-runtime-fixtures';

export const HIDDEN_AUTHORITY: Extract<EndAuthorityV2, { kind: 'hidden' }> = { kind: 'hidden' };
export const IMMEDIATE_AUTHORITY: Extract<EndAuthorityV2, { kind: 'immediate' }> = {
  kind: 'immediate',
  actionLabel: 'End session',
};
export const CLOSED_FRICTION_AUTHORITY: Extract<EndAuthorityV2, { gate: null }> = {
  kind: 'friction-gate',
  gate: null,
  copy: { actionLabel: 'End session' },
  actions: { open: 'open-end-gate' },
};
export const OPEN_FRICTION_AUTHORITY: Extract<
  EndAuthorityV2,
  { copy: { title: 'End this session' } }
> = {
  kind: 'friction-gate',
  gate: {
    kind: 'cancel',
    host: null,
    openedAt: NOW,
    readyAt: NOW + 10_000,
    requiredPhrase: 'I am ending this session before: Review the release',
  },
  copy: {
    title: 'End this session',
    back: 'Never mind, back to work',
    phraseLabel: 'Type this to confirm:',
    confirm: 'End the session',
    intentionReminder: 'Review the release',
  },
  actions: { abandon: 'abandon-gate', confirm: 'confirm-gate' },
};

export function activeSnapshotV2(config: SessionConfigV2 = MANUAL_TIMED_CONFIG): SessionSnapshotV2 {
  return {
    ...emptySnapshotV2(NOW + 10_000),
    lifecycle: {
      kind: 'active',
      endAuthority:
        config.strictness === 'hard'
          ? HIDDEN_AUTHORITY
          : config.strictness === 'friction'
            ? CLOSED_FRICTION_AUTHORITY
            : IMMEDIATE_AUTHORITY,
    },
    phase: 'focus',
    config,
    startedAt: NOW,
    phaseStartedAt: NOW,
    phaseEndsAt: config.duration.kind === 'timed' ? NOW + 25 * 60_000 : null,
    sessionEndsAt: config.duration.kind === 'timed' ? NOW + 25 * 60_000 : null,
    sessionFocusedMs: 10_000,
  };
}
