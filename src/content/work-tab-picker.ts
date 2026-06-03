import { sendRequest } from '../shared/messages';
import { parseWorkTabsResult, type WorkTab, type WorkTabsResult } from '../shared/work-target';

export interface WorkTabPicker {
  element: HTMLElement;
  close(restoreFocus?: boolean): void;
}

export function createWorkTabPicker(
  sessionId: string,
  trigger: HTMLElement,
  container: HTMLElement,
  select: (tabId: number) => Promise<string | null>,
  onClose: () => void,
): WorkTabPicker {
  let generation: number = 0;
  let closed: boolean = false;
  const scrollTop: number = container.scrollTop;
  const element: HTMLElement = document.createElement('section');
  element.className = 'work-picker';
  element.setAttribute('aria-label', 'Choose a work tab');
  const header: HTMLElement = document.createElement('div');
  header.className = 'work-picker-header';
  const heading: HTMLElement = document.createElement('h2');
  heading.textContent = 'Choose a work tab';
  const cancel: HTMLButtonElement = button('Cancel', 'work-picker-cancel');
  header.append(heading, cancel);
  const body: HTMLElement = document.createElement('div');
  body.className = 'work-picker-body';
  element.append(header, body);
  const close: (restoreFocus?: boolean) => void = (restoreFocus: boolean = true): void => {
    if (closed) return;
    closed = true;
    generation += 1;
    element.remove();
    trigger.setAttribute('aria-expanded', 'false');
    onClose();
    if (restoreFocus) {
      restorePickerFocus(trigger, container);
      container.scrollTop = scrollTop;
    }
  };
  cancel.addEventListener('click', (): void => close());
  element.addEventListener('keydown', (event: KeyboardEvent): void => navigate(event, body));
  trigger.setAttribute('aria-expanded', 'true');

  const load: () => Promise<void> = async (): Promise<void> => {
    const request: number = ++generation;
    const root: Node = element.getRootNode();
    if (root instanceof ShadowRoot && body.contains(root.activeElement))
      cancel.focus({ preventScroll: true });
    body.replaceChildren(status('Finding available tabs...'));
    body.setAttribute('aria-busy', 'true');
    let result: WorkTabsResult | null = null;
    try {
      result = parseWorkTabsResult(await sendRequest({ type: 'getWorkTabs', sessionId }));
    } catch {
      // Render the same retry action for transport failures and invalid replies.
    }
    if (closed || request !== generation) return;
    body.setAttribute('aria-busy', 'false');
    body.replaceChildren();
    if (!result?.ok || result.tabs.length === 0) {
      const message: HTMLElement = status(
        result?.ok
          ? 'No available work tabs. Open a site allowed by this session, then try again.'
          : (result?.error ?? 'Could not load work tabs. Try again.'),
      );
      if (!result?.ok) message.setAttribute('role', 'alert');
      const retry: HTMLButtonElement = button('Refresh tabs', 'work-picker-retry');
      retry.addEventListener('click', (): void => {
        void load();
      });
      body.append(message, retry);
      return;
    }
    const hint: HTMLElement = status('Select a tab to return to your task.');
    const list: HTMLElement = document.createElement('div');
    list.className = 'work-picker-list';
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', 'Available work tabs');
    for (const tab of result.tabs) {
      const row: HTMLButtonElement = tabButton(tab);
      row.addEventListener('click', (): void => {
        void choose(tab.tabId, row);
      });
      list.append(row);
    }
    body.append(hint, list);
  };

  const choose: (tabId: number, row: HTMLButtonElement) => Promise<void> = async (
    tabId: number,
    row: HTMLButtonElement,
  ): Promise<void> => {
    if (body.getAttribute('aria-busy') === 'true') return;
    const request: number = ++generation;
    body.setAttribute('aria-busy', 'true');
    body.querySelector('[role="alert"]')?.remove();
    cancel.focus({ preventScroll: true });
    for (const item of body.querySelectorAll<HTMLButtonElement>('button')) item.disabled = true;
    const pending: HTMLElement = status('Saving work tab...');
    body.append(pending);
    const error: string | null = await select(tabId);
    if (closed || request !== generation) return;
    body.setAttribute('aria-busy', 'false');
    pending.remove();
    for (const item of body.querySelectorAll<HTMLButtonElement>('button')) item.disabled = false;
    if (error !== null) {
      const alert: HTMLElement = status(error);
      alert.setAttribute('role', 'alert');
      body.append(alert);
      row.focus({ preventScroll: true });
    }
  };
  void load();
  return { element, close };
}

function restorePickerFocus(trigger: HTMLElement, container: HTMLElement): void {
  const available: boolean =
    trigger.isConnected && trigger.closest('[hidden]') === null && !trigger.matches(':disabled');
  const destination: HTMLElement = available
    ? trigger
    : (container.querySelector<HTMLElement>('.return-work:not([disabled]):not([hidden])') ??
      container);
  destination.focus({ preventScroll: true });
  const root: Node = container.getRootNode();
  if (root instanceof ShadowRoot && root.activeElement !== destination)
    container.focus({ preventScroll: true });
}

function button(text: string, className: string): HTMLButtonElement {
  const element: HTMLButtonElement = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = text;
  return element;
}

function status(text: string): HTMLElement {
  const element: HTMLElement = document.createElement('p');
  element.className = 'work-picker-status';
  element.setAttribute('role', 'status');
  element.textContent = text;
  return element;
}

function tabButton(tab: WorkTab): HTMLButtonElement {
  const row: HTMLButtonElement = button('', 'work-tab-option');
  const icon: HTMLElement = document.createElement('span');
  icon.className = 'work-tab-icon';
  icon.setAttribute('aria-hidden', 'true');
  const title: HTMLElement = document.createElement('span');
  title.className = 'work-tab-title';
  title.textContent = tab.title;
  const arrow: HTMLElement = document.createElement('span');
  arrow.className = 'work-tab-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '\u2192';
  row.append(icon, title, arrow);
  return row;
}

function navigate(event: KeyboardEvent, body: HTMLElement): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const rows: HTMLButtonElement[] = Array.from(
    body.querySelectorAll<HTMLButtonElement>('.work-tab-option:not(:disabled)'),
  );
  const index: number = rows.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const next: number =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rows.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
  rows[next]?.focus();
}

export const WORK_PICKER_CSS: string = `
.work-picker { width: 100%; padding: 1rem; border: 1px solid var(--overlay-input-border); border-radius: 1rem; background: var(--overlay-input-bg); text-align: left; }
.work-picker-header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.work-picker h2 { font-size: 1rem; font-weight: 650; }
.work-picker-cancel, .work-picker-retry, .change-work { padding: 0.45rem 0.65rem; border-radius: 0.5rem; background: transparent; color: var(--overlay-muted); font-size: 0.85rem; }
.work-picker-cancel:hover, .work-picker-retry:hover, .change-work:hover { background: var(--overlay-pill); color: var(--overlay-text); }
.change-work[hidden] { display: none; }
.work-picker-status { font-size: 0.85rem; line-height: 1.5; color: var(--overlay-muted); margin-block: 0.7rem; overflow-wrap: anywhere; }
.work-picker [role="alert"] { color: var(--overlay-error-text); background: var(--overlay-error-bg); padding: 0.65rem; border-radius: 0.5rem; }
.work-picker-list { display: grid; gap: 0.5rem; max-height: 19rem; overflow-y: auto; overscroll-behavior: contain; padding: 0.3rem; margin: -0.3rem; }
.work-tab-option { display: flex; align-items: center; gap: 0.75rem; width: 100%; padding: 0.8rem; border: 1px solid var(--overlay-meter); border-radius: 0.7rem; background: var(--overlay-pill); color: var(--overlay-text); text-align: left; }
.work-tab-option:hover:enabled { background: var(--overlay-pill-hover); border-color: var(--overlay-bank); }
.work-tab-option:disabled { opacity: 0.55; }
.work-tab-title { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 0.9rem; line-height: 1.4; }
.work-tab-icon { width: 1.15rem; height: 1rem; flex-shrink: 0; border: 1.5px solid var(--overlay-muted); border-radius: 0.2rem; box-shadow: inset 0 0.2rem var(--overlay-pill-hover); }
.work-tab-arrow { color: var(--overlay-bank); }
@media (max-width: 400px) { .work-picker { padding: 0.75rem; } .work-tab-option { gap: 0.6rem; padding: 0.7rem; } }
`;
