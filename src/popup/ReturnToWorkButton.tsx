import type { VNode } from 'preact';

export interface WorkDestination {
  title: string | null;
  hostname?: string;
}

const BACK_TO_WORK_LABEL: string = 'Back to work';
const DESTINATION_UNAVAILABLE_COPY: string = 'Destination unavailable';

/**
 * Styled like the start button, and named after where it goes: the accessible name reads
 * "Back to work: <title> (<host>)", so the destination is announced with the action.
 */
export function ReturnToWorkButton({
  destination,
  secondary = false,
  disabled,
  onClick,
}: {
  destination: WorkDestination;
  secondary?: boolean;
  disabled: boolean;
  onClick: () => void;
}): VNode {
  const title: string = destination.title?.trim() ?? '';
  const hostname: string = destination.hostname ?? '';
  const known: boolean = title !== '' || hostname !== '';
  const name: string = `${BACK_TO_WORK_LABEL}: ${title || hostname || DESTINATION_UNAVAILABLE_COPY}${
    title !== '' && hostname !== '' ? ` (${hostname})` : ''
  }`;
  return (
    <button
      type="button"
      class={`${secondary ? 'secondary-button' : 'start-button'} return-work-button`}
      disabled={disabled || !known}
      aria-label={name}
      title={name}
      onClick={onClick}
    >
      <span>{BACK_TO_WORK_LABEL}</span>
      <span class="return-work-destination">
        <span class="return-work-title">{title || hostname || DESTINATION_UNAVAILABLE_COPY}</span>
        {title !== '' && hostname !== '' ? (
          <span class="return-work-hostname"> ({hostname})</span>
        ) : null}
      </span>
    </button>
  );
}
