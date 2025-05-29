import type { ComponentChildren, JSX, RefObject } from 'preact';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import './help-popover.css';

const VIEWPORT_GUTTER_PX: number = 16;
const POPOVER_GAP_PX: number = 8;

type PopoverPosition = {
  inlineStart: number;
  blockStart: number;
};

function calculatePopoverPosition(
  triggerRect: DOMRect,
  contentRect: DOMRect,
  viewportWidth: number,
  viewportHeight: number,
  direction: string,
): PopoverPosition {
  const maximumLeft: number = Math.max(
    VIEWPORT_GUTTER_PX,
    viewportWidth - VIEWPORT_GUTTER_PX - contentRect.width,
  );
  const desiredLeft: number = triggerRect.left + (triggerRect.width - contentRect.width) / 2;
  const physicalLeft: number = Math.min(Math.max(desiredLeft, VIEWPORT_GUTTER_PX), maximumLeft);
  const maximumTop: number = Math.max(
    VIEWPORT_GUTTER_PX,
    viewportHeight - VIEWPORT_GUTTER_PX - contentRect.height,
  );
  const belowTrigger: number = triggerRect.bottom + POPOVER_GAP_PX;
  const aboveTrigger: number = triggerRect.top - POPOVER_GAP_PX - contentRect.height;
  const desiredTop: number =
    belowTrigger + contentRect.height <= viewportHeight - VIEWPORT_GUTTER_PX
      ? belowTrigger
      : aboveTrigger;
  const blockStart: number = Math.min(Math.max(desiredTop, VIEWPORT_GUTTER_PX), maximumTop);
  const inlineStart: number =
    direction === 'rtl' ? viewportWidth - physicalLeft - contentRect.width : physicalLeft;
  return { inlineStart, blockStart };
}

function usePopoverPosition(
  open: boolean,
  rootRef: RefObject<HTMLSpanElement>,
  triggerRef: RefObject<HTMLButtonElement>,
  contentRef: RefObject<HTMLSpanElement>,
): PopoverPosition | null {
  const [position, setPosition] = useState<PopoverPosition | null>(null);

  useLayoutEffect((): (() => void) | undefined => {
    if (!open) return undefined;

    const updatePosition = (): void => {
      const root: HTMLSpanElement | null = rootRef.current;
      const trigger: HTMLButtonElement | null = triggerRef.current;
      const content: HTMLSpanElement | null = contentRef.current;
      if (!root || !trigger || !content) return;

      const next: PopoverPosition = calculatePopoverPosition(
        trigger.getBoundingClientRect(),
        content.getBoundingClientRect(),
        window.innerWidth,
        window.innerHeight,
        getComputedStyle(root).direction,
      );
      setPosition((current: PopoverPosition | null): PopoverPosition => {
        if (current?.inlineStart === next.inlineStart && current.blockStart === next.blockStart)
          return current;
        return next;
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return (): void => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [contentRef, open, rootRef, triggerRef]);

  return position;
}

export type HelpPopoverProps = {
  label: string;
  children: ComponentChildren;
};

export function HelpPopover({ label, children }: HelpPopoverProps): JSX.Element {
  const [open, setOpen] = useState<boolean>(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLSpanElement | null>(null);
  const pointerInsideRef = useRef<boolean>(false);
  const generatedId: string = useId();
  const contentId: string = `help-popover-${generatedId}`;
  const position: PopoverPosition | null = usePopoverPosition(
    open,
    rootRef,
    triggerRef,
    contentRef,
  );

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
        ref={triggerRef}
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
        <span
          ref={contentRef}
          class="help-popover__content"
          id={contentId}
          role="tooltip"
          style={{
            visibility: position === null ? 'hidden' : 'visible',
            insetInlineStart: position === null ? undefined : `${position.inlineStart}px`,
            insetBlockStart: position === null ? undefined : `${position.blockStart}px`,
          }}
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}
