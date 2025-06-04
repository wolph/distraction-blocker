import type { VNode } from 'preact';
import { HelpPopover } from '../shared/HelpPopover';
import type { Strictness } from '../shared/types';

interface SessionTypeChoice {
  value: Strictness;
  label: string;
  consequence: string;
}

export interface SessionTypeControlProps {
  value: Strictness;
  frictionDelayMs: number;
  requireTypedPhrase: boolean;
  onChange: (value: Strictness) => void;
}

function formatDelaySeconds(delayMs: number): string {
  const seconds: number = delayMs / 1_000;
  return Number.isInteger(seconds) ? String(seconds) : String(Number(seconds.toFixed(3)));
}

function frictionConsequence(delayMs: number, requireTypedPhrase: boolean): string {
  const wait: string = delayMs === 0 ? 'no wait' : `a ${formatDelaySeconds(delayMs)}-second wait`;
  return requireTypedPhrase
    ? `Ending early requires ${wait} and typed confirmation.`
    : `Ending early requires ${wait}. No typing is required.`;
}

export function SessionTypeControl({
  value,
  frictionDelayMs,
  requireTypedPhrase,
  onChange,
}: SessionTypeControlProps): VNode {
  const choices: readonly SessionTypeChoice[] = [
    {
      value: 'flexible',
      label: 'Flexible',
      consequence: 'End the session immediately whenever you choose.',
    },
    {
      value: 'friction',
      label: 'Friction',
      consequence: frictionConsequence(frictionDelayMs, requireTypedPhrase),
    },
    {
      value: 'hard',
      label: 'Hard lock',
      consequence: 'The session cannot end early. Earned pauses still work.',
    },
  ];
  return (
    <fieldset class="session-type-control" aria-label="Session type">
      <legend>Session type</legend>
      <div class="session-type-choices">
        {choices.map(
          (choice: SessionTypeChoice): VNode => (
            <HelpPopover
              key={choice.value}
              label={choice.label}
              triggerContent={
                <span class="session-type-choice__content">
                  <span class="session-type-choice__label">{choice.label}</span>
                  <span class="session-type-choice__hint">{choice.consequence}</span>
                </span>
              }
              triggerClassName="session-type-choice"
              triggerPressed={value === choice.value}
              onTriggerClick={(): void => onChange(choice.value)}
            >
              {choice.consequence}
            </HelpPopover>
          ),
        )}
      </div>
    </fieldset>
  );
}
