import type { VNode } from 'preact';
import { HelpPopover } from '../shared/HelpPopover';
import type { Strictness } from '../shared/types';

interface SessionTypeChoice {
  value: Strictness;
  label: string;
  consequence: string;
}

const SESSION_TYPES: readonly SessionTypeChoice[] = [
  {
    value: 'flexible',
    label: 'Flexible',
    consequence: 'End the session immediately whenever you choose.',
  },
  {
    value: 'friction',
    label: 'Friction',
    consequence: 'Ending early requires a 30-second wait and typed confirmation.',
  },
  {
    value: 'hard',
    label: 'Hard lock',
    consequence: 'The session cannot end early. Earned pauses still work.',
  },
];

export interface SessionTypeControlProps {
  value: Strictness;
  onChange: (value: Strictness) => void;
}

export function SessionTypeControl({ value, onChange }: SessionTypeControlProps): VNode {
  return (
    <fieldset class="session-type-control" aria-label="Session type">
      <legend>Session type</legend>
      <div class="session-type-choices">
        {SESSION_TYPES.map(
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
