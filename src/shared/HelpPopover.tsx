import type { ComponentChildren, JSX, RefObject } from 'preact';
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import './help-popover.css';

const VIEWPORT_GUTTER_PX: number = 16;
const POPOVER_GAP_PX: number = 8;
const HOVER_EXIT_GRACE_MS: number = 100;

type PopoverPosition = {
  inlineStart: number;
  blockStart: number;
  placement: 'above' | 'below';
};

type InteractionSources = {
  pointerInside: boolean;
  focusInside: boolean;
  clickOpen: boolean;
  hoverCloseTimer: number | null;
};

type PopoverInteraction = {
  open: boolean;
  handleClick: () => void;
};

function cancelHoverClose(sources: InteractionSources): void {
  if (sources.hoverCloseTimer === null) return;
  window.clearTimeout(sources.hoverCloseTimer);
  sources.hoverCloseTimer = null;
}

function dismissPopover(sources: InteractionSources, setOpen: (open: boolean) => void): void {
  cancelHoverClose(sources);
  sources.pointerInside = false;
  sources.focusInside = false;
  sources.clickOpen = false;
  setOpen(false);
}

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
  const placement: 'above' | 'below' =
    belowTrigger + contentRect.height <= viewportHeight - VIEWPORT_GUTTER_PX ? 'below' : 'above';
  const desiredTop: number = placement === 'below' ? belowTrigger : aboveTrigger;
  const blockStart: number = Math.min(Math.max(desiredTop, VIEWPORT_GUTTER_PX), maximumTop);
  const inlineStart: number =
    direction === 'rtl' ? viewportWidth - physicalLeft - contentRect.width : physicalLeft;
  return { inlineStart, blockStart, placement };
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
        if (
          current?.inlineStart === next.inlineStart &&
          current.blockStart === next.blockStart &&
          current.placement === next.placement
        )
          return current;
        return next;
      });
    };
    let frameId: number | null = null;
    const updateOnAnimationFrame = (): void => {
      frameId = null;
      updatePosition();
    };
    const schedulePositionUpdate = (): void => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(updateOnAnimationFrame);
    };

    updatePosition();
    window.addEventListener('resize', schedulePositionUpdate);
    window.addEventListener('scroll', schedulePositionUpdate, true);
    return (): void => {
      window.removeEventListener('resize', schedulePositionUpdate);
      window.removeEventListener('scroll', schedulePositionUpdate, true);
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [contentRef, open, rootRef, triggerRef]);

  return position;
}

function usePointerDismissal(
  rootRef: RefObject<HTMLSpanElement>,
  sources: InteractionSources,
  setOpen: (open: boolean) => void,
): void {
  useLayoutEffect((): (() => void) => {
    const root: HTMLSpanElement | null = rootRef.current;
    const openFromPointer = (): void => {
      cancelHoverClose(sources);
      sources.pointerInside = true;
      setOpen(true);
    };
    const closeFromPointer = (event: PointerEvent): void => {
      if (event.relatedTarget instanceof Node && (root?.contains(event.relatedTarget) ?? false)) {
        cancelHoverClose(sources);
        return;
      }
      sources.pointerInside = false;
      if (sources.focusInside || sources.clickOpen) return;
      cancelHoverClose(sources);
      sources.hoverCloseTimer = window.setTimeout((): void => {
        sources.hoverCloseTimer = null;
        if (!sources.pointerInside && !sources.focusInside && !sources.clickOpen) setOpen(false);
      }, HOVER_EXIT_GRACE_MS);
    };
    const closeFromOutsideClick = (event: MouseEvent): void => {
      if (event.target instanceof Node && root?.contains(event.target)) return;
      dismissPopover(sources, setOpen);
    };
    root?.addEventListener('pointerenter', openFromPointer);
    root?.addEventListener('pointerleave', closeFromPointer);
    document.addEventListener('click', closeFromOutsideClick);
    return (): void => {
      cancelHoverClose(sources);
      root?.removeEventListener('pointerenter', openFromPointer);
      root?.removeEventListener('pointerleave', closeFromPointer);
      document.removeEventListener('click', closeFromOutsideClick);
    };
  }, [rootRef, setOpen, sources]);
}

function useFocusDismissal(
  rootRef: RefObject<HTMLSpanElement>,
  triggerRef: RefObject<HTMLButtonElement>,
  sources: InteractionSources,
  setOpen: (open: boolean) => void,
): void {
  useLayoutEffect((): (() => void) => {
    const root: HTMLSpanElement | null = rootRef.current;
    const openFromFocus = (): void => {
      cancelHoverClose(sources);
      sources.focusInside = true;
      setOpen(true);
    };
    const closeFromFocus = (event: FocusEvent): void => {
      if (event.relatedTarget instanceof Node && (root?.contains(event.relatedTarget) ?? false))
        return;
      sources.focusInside = false;
      const leftContent: boolean =
        event.target instanceof Element && event.target.closest('.help-popover__content') !== null;
      if (leftContent) sources.clickOpen = false;
      if (!sources.pointerInside && !sources.clickOpen) setOpen(false);
    };
    const closeFromEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (event.target !== triggerRef.current) triggerRef.current?.focus();
      dismissPopover(sources, setOpen);
    };
    root?.addEventListener('focusin', openFromFocus);
    root?.addEventListener('focusout', closeFromFocus);
    root?.addEventListener('keydown', closeFromEscape);
    return (): void => {
      root?.removeEventListener('focusin', openFromFocus);
      root?.removeEventListener('focusout', closeFromFocus);
      root?.removeEventListener('keydown', closeFromEscape);
    };
  }, [rootRef, setOpen, sources, triggerRef]);
}

function usePopoverInteraction(
  rootRef: RefObject<HTMLSpanElement>,
  triggerRef: RefObject<HTMLButtonElement>,
): PopoverInteraction {
  const [open, setOpen] = useState<boolean>(false);
  const sourcesRef = useRef<InteractionSources>({
    pointerInside: false,
    focusInside: false,
    clickOpen: false,
    hoverCloseTimer: null,
  });
  const sources: InteractionSources = sourcesRef.current;
  usePointerDismissal(rootRef, sources, setOpen);
  useFocusDismissal(rootRef, triggerRef, sources, setOpen);
  const handleClick = (): void => {
    cancelHoverClose(sources);
    sources.clickOpen = true;
    setOpen(true);
  };
  return { open, handleClick };
}

export type HelpPopoverProps = {
  label: string;
  children: ComponentChildren;
};

export function HelpPopover({ label, children }: HelpPopoverProps): JSX.Element {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLSpanElement | null>(null);
  const generatedId: string = useId();
  const contentId: string = `help-popover-${generatedId}`;
  const interaction: PopoverInteraction = usePopoverInteraction(rootRef, triggerRef);
  const position: PopoverPosition | null = usePopoverPosition(
    interaction.open,
    rootRef,
    triggerRef,
    contentRef,
  );

  return (
    <span ref={rootRef} class="help-popover">
      <button
        ref={triggerRef}
        class="help-popover__trigger"
        type="button"
        aria-label={label}
        aria-controls={contentId}
        aria-describedby={interaction.open ? contentId : undefined}
        aria-expanded={interaction.open}
        onClick={interaction.handleClick}
      >
        <span aria-hidden="true">?</span>
      </button>
      {interaction.open ? (
        <span
          ref={contentRef}
          class="help-popover__content"
          data-placement={position?.placement}
          id={contentId}
          role="tooltip"
          style={{
            visibility: position === null ? 'hidden' : 'visible',
            insetInlineStart: position === null ? undefined : `${position.inlineStart}px`,
            insetBlockStart: position === null ? undefined : `${position.blockStart}px`,
          }}
        >
          <span class="help-popover__body">{children}</span>
        </span>
      ) : null}
    </span>
  );
}
