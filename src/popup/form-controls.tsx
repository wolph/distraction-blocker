import type { VNode } from 'preact';

/** Toggle chip: preset lengths and category pills share this control. */
export function Chip({
  label,
  accessibleLabel,
  selected,
  onClick,
}: {
  label: string;
  accessibleLabel?: string;
  selected: boolean;
  onClick: () => void;
}): VNode {
  return (
    <button
      type="button"
      class={selected ? 'chip chip-selected' : 'chip'}
      aria-pressed={selected}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** Radio with a one-line hint under the label. */
export function RadioRow({
  name,
  label,
  hint,
  checked,
  onSelect,
  disabled = false,
  describedBy,
}: {
  name: string;
  label: string;
  hint: string;
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
  describedBy?: string;
}): VNode {
  return (
    <label class="radio-row">
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={onSelect}
      />
      <span class="radio-text">
        <span class="radio-label">{label}</span>
        <span class="radio-hint">{hint}</span>
      </span>
    </label>
  );
}
