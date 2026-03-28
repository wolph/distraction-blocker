/**
 * Indefinite-session fixtures for the two restart suites, and one builder that does not invent a
 * runtime at all.
 *
 * Two reasons this file exists beside `runtime-v2-fixtures.ts` rather than inside it.
 *
 * The first is coverage. An until-stopped session owns no phase alarm while it is focusing,
 * because `planPhaseAlarmV2` answers `null` for that shape, so nothing wakes the worker on its
 * behalf. Every other session shape has a timer that will eventually fire and repair a bad
 * recovery. This one has only boot and recovery, which is the layer neither restart suite reached.
 *
 * The second is the seam. `runtime-v2-fixtures.ts` says in its own header that it never calls a
 * production builder, which is the right rule for a validation suite: a rejection case must differ
 * from an accepted one by exactly one field, and only a hand-built graph can do that. The cost is
 * that no test hands recovery a runtime a runner actually wrote, so the shape recovery reads is
 * held together by the parser alone, and the parser does not pin stage semantics.
 * `startedIndefiniteRuntime` closes that: it drives the real start transition and returns what the
 * runner committed.
 */

import type { RuntimePortsV2 } from '../../../src/background/runtime-ports-v2';
import type {
  RuntimeStateV2,
  SessionStartCandidate,
} from '../../../src/background/runtime-v2-types';
import {
  driveTransitionV2,
  type PreparedTransitionV2,
  prepareStartTransitionV2,
  type TransitionDriveResultV2,
} from '../../../src/background/transition-runner-v2';
import { startSessionV2 } from '../../../src/core/session-v2';
import type { SessionConfigV2, SessionStateV2 } from '../../../src/shared/types';
import { canonicalRules, SESSION_ID } from './runtime-v2-fixtures';

/** The only strictness and cycling an until-stopped session may carry, per `startSessionV2`. */
export function indefiniteConfig(overrides: Partial<SessionConfigV2> = {}): SessionConfigV2 {
  return {
    mode: 'blacklist',
    strictness: 'flexible',
    duration: { kind: 'until-stopped' },
    cycling: null,
    intention: 'Read the whole paper',
    source: 'manual',
    scheduleOccurrence: null,
    rules: canonicalRules(),
    ...overrides,
  };
}

/**
 * Built through `startSessionV2` rather than by hand, so the null session and phase ends come from
 * the production rule instead of from a fixture author remembering to write them.
 */
export function indefiniteFocusSession(
  startedAt: number,
  overrides: Partial<SessionStateV2> = {},
): SessionStateV2 {
  return { ...startSessionV2(indefiniteConfig(), startedAt, SESSION_ID), ...overrides };
}

/** The same session paused, which is the one indefinite phase that does own a boundary. */
export function indefinitePausedSession(
  startedAt: number,
  pausedAt: number,
  pauseMs: number,
): SessionStateV2 {
  return indefiniteFocusSession(startedAt, {
    phase: 'paused',
    phaseStartedAt: pausedAt,
    phaseEndsAt: pausedAt + pauseMs,
    // The focus it will return to has no end, which is what makes this shape different from every
    // paused timed session: resuming restores a phase with a null boundary.
    pausedFrom: { phase: 'focus', phaseEndsAt: null },
    focusedMs: pausedAt - startedAt,
  });
}

/**
 * The runtime a real start leaves behind. Drives `prepareStartTransitionV2` and `driveTransitionV2`
 * against the caller's ports and answers what the runner committed, so a test starting here is
 * reading a runtime the production path wrote rather than one a fixture invented.
 */
export async function startedIndefiniteRuntime(
  ports: RuntimePortsV2,
  overrides: Partial<SessionConfigV2> = {},
): Promise<RuntimeStateV2> {
  const config: SessionConfigV2 = indefiniteConfig(overrides);
  const candidate: SessionStartCandidate = {
    mode: config.mode,
    strictness: config.strictness,
    duration: { kind: 'until-stopped' },
    cycling: config.cycling,
    intention: config.intention,
    source: 'manual',
    scheduleOccurrence: null,
    scheduleWindow: null,
    rules: config.rules,
  };
  const prepared: PreparedTransitionV2 = await prepareStartTransitionV2(ports, candidate, 'manual');
  const driven: TransitionDriveResultV2 = await driveTransitionV2(ports, prepared.matcher);
  if (driven.kind !== 'published') {
    throw new Error(`the start reached ${driven.kind} rather than publishing`);
  }
  return driven.runtime;
}
