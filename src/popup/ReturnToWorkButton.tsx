import type { VNode } from 'preact';

export interface WorkDestination {
  title: string | null;
  hostname?: string;
}

export function ReturnToWorkButton({
  destination,
  disabled,
  onClick,
}: {
  destination: WorkDestination;
  disabled: boolean;
  onClick: () => void;
}): VNode {
  const title: string = destination.title?.trim() ?? '';
  const hostname: string = destination.hostname ?? '';
  const known: boolean = title !== '' || hostname !== '';
  const name: string = `Back to work: ${title || hostname || 'Destination unavailable'}${
    title !== '' && hostname !== '' ? ` (${hostname})` : ''
  }`;
  return (
    <button
      type="button"
      class="start-button return-work-button"
      disabled={disabled || !known}
      aria-label={name}
      title={name}
      onClick={onClick}
    >
      <span>Back to work</span>
      <span class="return-work-title">{title || hostname || 'Destination unavailable'}</span>
      {title !== '' && hostname !== '' ? (
        <span class="return-work-hostname">{hostname}</span>
      ) : null}
    </button>
  );
}
