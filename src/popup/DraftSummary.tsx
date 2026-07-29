import type { VNode } from 'preact';
import type { Strictness } from '../shared/types';
import { effectiveStrictness, type StartDraft } from './start-draft';

/** The current draft's consequences stay beside Start even while its controls are closed. */
export function DraftSummary({
  draft,
  durationHint,
}: {
  draft: StartDraft;
  durationHint: string | null;
}): VNode {
  const categories: number = Object.values(draft.rules.categories).filter(Boolean).length;
  const blocked: number =
    draft.rules.permanentBlacklist.length + draft.rules.sessionBlacklist.length;
  const allowed: number =
    draft.rules.permanentAllowlist.length + draft.rules.sessionAllowlist.length;
  const blocking: string =
    draft.mode === 'whitelist'
      ? `Only ${allowed} allowed site rules. Other websites blocked.`
      : `${categories} blocked categories, ${blocked} extra rules.`;
  const strictness: Strictness = effectiveStrictness(draft);
  const stop: string =
    strictness === 'hard'
      ? 'Hard lock. Cannot end early.'
      : draft.duration.kind === 'until-stopped'
        ? ''
        : strictness === 'flexible'
          ? 'Can end at any time.'
          : `End after a ${draft.frictionGate.delayMs / 1000}s wait${draft.frictionGate.requireTypedPhrase ? ' and confirmation phrase' : ''}.`;
  return (
    <p class="draft-summary">
      <span>{blocking}</span>
      {durationHint !== null ? (
        <span class="session-timing" role="status">
          {durationHint}
        </span>
      ) : null}
      {stop !== '' ? <span>{stop}</span> : null}
    </p>
  );
}
