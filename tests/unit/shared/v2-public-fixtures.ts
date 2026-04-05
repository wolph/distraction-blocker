import { endAuthorityV2 } from '../../../src/background/lifecycle-projection-v2';
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
  const sessionEndsAt: number | null =
    config.duration.kind === 'timed' ? NOW + Math.round(config.duration.minutes * 60_000) : null;
  const phaseEndsAt: number | null =
    config.duration.kind === 'until-stopped'
      ? null
      : config.cycling === null
        ? sessionEndsAt
        : Math.min(
            NOW + Math.round(config.cycling.focusMin * 60_000),
            NOW + Math.round(config.duration.minutes * 60_000),
          );
  return {
    ...emptySnapshotV2(NOW + 10_000),
    lifecycle: {
      kind: 'active',
      // Derived rather than restated. This is the same rule the production projection applies,
      // and a fixture that spells it out by hand is how the wrong end action was frozen into nine
      // suites at once: the fixture agreed with the code until the code was corrected.
      endAuthority: endAuthorityV2(config.strictness, null, config.intention),
    },
    phase: 'focus',
    config,
    startedAt: NOW,
    phaseStartedAt: NOW,
    phaseEndsAt,
    sessionEndsAt,
    sessionFocusedMs: 10_000,
  };
}
