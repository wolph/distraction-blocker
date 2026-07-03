import type { VNode } from 'preact';
import { HelpPopover } from '../shared/HelpPopover';
import { formatGateWait } from '../shared/session-copy';
import type { Strictness } from '../shared/types';

interface SessionTypeChoice {
  value: Strictness;
  label: string;
  consequence: string;
  /** The one-sentence reason this choice cannot be selected, null while it can. */
  unavailableReason: string | null;
}

export interface SessionTypeControlProps {
  value: Strictness;
  frictionDelayMs: number;
  requireTypedPhrase: boolean;
  /**
   * Set while Hard cannot be chosen, which an Until stopped draft asks for. The choice stays
   * visible and disclosable, reads the reason where its consequence would be, and refuses the
   * selection.
   */
  hardUnavailableReason?: string;
  onChange: (value: Strictness) => void;
}

function frictionConsequence(delayMs: number, requireTypedPhrase: boolean): string {
  const wait: string = formatGateWait(delayMs);
  return requireTypedPhrase
    ? `Ending early requires ${wait} and typed confirmation.`
    : `Ending early requires ${wait}. No typing is required.`;
}

export function SessionTypeControl({
  value,
  frictionDelayMs,
  requireTypedPhrase,
  hardUnavailableReason,
  onChange,
}: SessionTypeControlProps): VNode {
  const choices: readonly SessionTypeChoice[] = [
    {
      value: 'flexible',
      label: 'Flexible',
      consequence: 'End the session immediately whenever you choose.',
      unavailableReason: null,
    },
    {
      value: 'friction',
      label: 'Friction',
      consequence: frictionConsequence(frictionDelayMs, requireTypedPhrase),
      unavailableReason: null,
    },
    {
      value: 'hard',
      label: 'Hard lock',
      consequence: 'The session cannot end early. Earned pauses still work.',
      unavailableReason: hardUnavailableReason ?? null,
    },
  ];
  return (
    <fieldset class="session-type-control" aria-label="Session type">
      <legend>Session type</legend>
      <div class="session-type-choices">
        {choices.map((choice: SessionTypeChoice): VNode => {
          const disabled: boolean = choice.unavailableReason !== null;
          const explanation: string = choice.unavailableReason ?? choice.consequence;
          return (
            <HelpPopover
              key={choice.value}
              label={choice.label}
              triggerContent={
                <span class="session-type-choice__content">
                  <span class="session-type-choice__label">{choice.label}</span>
                  <span class="session-type-choice__hint">{explanation}</span>
                </span>
              }
              triggerClassName="session-type-choice"
              triggerPressed={value === choice.value}
              triggerDisabled={disabled}
              onTriggerClick={(): void => onChange(choice.value)}
            >
              {explanation}
            </HelpPopover>
          );
        })}
      </div>
    </fieldset>
  );
}
