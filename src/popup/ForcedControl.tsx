import type { ComponentChildren, VNode } from 'preact';
import { useId, useRef } from 'preact/hooks';
import { HelpPopover } from '../shared/HelpPopover';

export interface ForcedControlProps {
  label: string;
  explanation: string;
  children: ComponentChildren;
}

const HELP_ROOT_SELECTOR: string = '.help-popover';

/**
 * A forced control keeps its children visible and readable while refusing every value
 * change. Native disabled controls drop hover, keyboard focus, and click disclosure, so
 * the wrapper is a focusable `aria-disabled` group instead: hover, keyboard focus, click,
 * and Enter all reach the same explanation, which `aria-describedby` also carries.
 *
 * A forced child may carry its own help, and in `SessionTypeControl` that help trigger is
 * also the value button. So no child action ever runs, not even a help trigger's. A click
 * or Enter on a nested popover discloses that popover instead, which keeps the per-choice
 * explanation reachable without letting the choice change.
 */
export function ForcedControl({ label, explanation, children }: ForcedControlProps): VNode {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const helpRef = useRef<HTMLSpanElement | null>(null);
  const explanationId: string = `forced-control-${useId()}`;

  /** True while the event target sits in this control's own help, which stays live. */
  const isOwnHelpTarget: (target: EventTarget | null) => boolean = (
    target: EventTarget | null,
  ): boolean => target instanceof Node && (helpRef.current?.contains(target) ?? false);

  /** The help popover a forced child carries around the event target, if it carries one. */
  const nestedHelpRootOf: (target: EventTarget | null) => Element | null = (
    target: EventTarget | null,
  ): Element | null => (target instanceof Element ? target.closest(HELP_ROOT_SELECTOR) : null);

  /**
   * HelpPopover opens from pointer and focus events on its own root, which sits inside
   * this wrapper. Forwarding them keeps hover and keyboard-focus disclosure working from
   * anywhere in the forced control, including its non-interactive children.
   */
  const forwardToHelp: (type: string) => void = (type: string): void => {
    const helpRoot: Element | null = helpRef.current?.querySelector(HELP_ROOT_SELECTOR) ?? null;
    helpRoot?.dispatchEvent(new Event(type));
  };

  const openHelp: () => void = (): void => {
    const trigger: HTMLElement | null = helpRef.current?.querySelector('button') ?? null;
    trigger?.click();
  };

  /**
   * Discloses the help that explains the blocked control: the popover a forced child
   * carries, opened through the same synthetic hover or focus channel used for the
   * wrapper's own help, or the wrapper's explanation when the child carries none.
   */
  const discloseHelpFor: (target: EventTarget | null, channel: string) => void = (
    target: EventTarget | null,
    channel: string,
  ): void => {
    const nested: Element | null = nestedHelpRootOf(target);
    if (nested === null) {
      openHelp();
      return;
    }
    nested.dispatchEvent(new Event(channel));
  };

  /** Capture phase: the child never sees the event, so no value can change. */
  const blockChildInteraction: (event: MouseEvent) => void = (event: MouseEvent): void => {
    if (isOwnHelpTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    discloseHelpFor(event.target, 'pointerenter');
  };

  const openHelpFromEnter: (event: KeyboardEvent) => void = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || isOwnHelpTarget(event.target)) return;
    event.preventDefault();
    discloseHelpFor(event.target, 'focusin');
  };

  const closeHelpOnFocusExit: (event: FocusEvent) => void = (event: FocusEvent): void => {
    const staysInside: boolean =
      event.relatedTarget instanceof Node &&
      (rootRef.current?.contains(event.relatedTarget) ?? false);
    if (staysInside) return;
    forwardToHelp('focusout');
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: the wrapper shells controls that own their fieldset, so a second one would duplicate the group.
    <div
      ref={rootRef}
      class="forced-control"
      role="group"
      aria-label={label}
      aria-disabled="true"
      aria-describedby={explanationId}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the forced group carries the disclosure its inert children can no longer receive.
      tabIndex={0}
      onClickCapture={blockChildInteraction}
      onKeyDown={openHelpFromEnter}
      onPointerEnter={(): void => forwardToHelp('pointerenter')}
      onPointerLeave={(): void => forwardToHelp('pointerleave')}
      onFocusIn={(): void => forwardToHelp('focusin')}
      onFocusOut={closeHelpOnFocusExit}
    >
      <div class="forced-control__body">{children}</div>
      <span ref={helpRef} class="forced-control__help">
        <HelpPopover label={label}>{explanation}</HelpPopover>
      </span>
      <span id={explanationId} class="forced-control__explanation">
        {explanation}
      </span>
    </div>
  );
}
