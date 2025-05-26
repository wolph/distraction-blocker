import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import './help-popover.css';

export type HelpPopoverProps = {
  label: string;
  children: ComponentChildren;
};

export function HelpPopover({ label, children }: HelpPopoverProps): JSX.Element {
  const [open, setOpen] = useState<boolean>(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const pointerInsideRef = useRef<boolean>(false);
  const generatedId: string = useId();
  const contentId: string = `help-popover-${generatedId}`;

  useEffect((): (() => void) => {
    const root: HTMLSpanElement | null = rootRef.current;
    const closeFromOutsideClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || !root?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('click', closeFromOutsideClick);
    return (): void => {
      document.removeEventListener('click', closeFromOutsideClick);
    };
  }, []);

  const handleBlur = (event: JSX.TargetedFocusEvent<HTMLButtonElement>): void => {
    const nextTarget: EventTarget | null = event.relatedTarget;
    const focusRemainsInside: boolean =
      nextTarget instanceof Node && (rootRef.current?.contains(nextTarget) ?? false);
    if (!pointerInsideRef.current && !focusRemainsInside) setOpen(false);
  };

  const handleKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
  };

  const handlePointerEnter = (): void => {
    pointerInsideRef.current = true;
    setOpen(true);
  };

  const handlePointerLeave = (): void => {
    pointerInsideRef.current = false;
    const focusInside: boolean = rootRef.current?.contains(document.activeElement) ?? false;
    if (!focusInside) setOpen(false);
  };

  return (
    <span ref={rootRef} class="help-popover">
      <button
        class="help-popover__trigger"
        type="button"
        aria-label={label}
        aria-controls={contentId}
        aria-describedby={open ? contentId : undefined}
        aria-expanded={open}
        onBlur={handleBlur}
        onClick={(): void => setOpen(true)}
        onFocus={(): void => setOpen(true)}
        onKeyDown={handleKeyDown}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <span aria-hidden="true">?</span>
      </button>
      {open ? (
        <span class="help-popover__content" id={contentId} role="tooltip">
          {children}
        </span>
      ) : null}
    </span>
  );
}
