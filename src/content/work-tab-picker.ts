import { sendRequest } from '../shared/messages';
import { parseWorkTabsResult, type WorkTab, type WorkTabsResult } from '../shared/work-target';

export interface WorkTabPicker {
  element: HTMLElement;
  close(restoreFocus?: boolean): void;
}

interface PickerControls {
  element: HTMLElement;
  cancel: HTMLButtonElement;
  search: HTMLInputElement;
  clear: HTMLButtonElement;
  refresh: HTMLButtonElement;
  count: HTMLElement;
  body: HTMLElement;
}

interface PickerState {
  generation: number;
  closed: boolean;
  loading: boolean;
  saving: boolean;
  tabs: WorkTab[];
  error: string | null;
}

export function createWorkTabPicker(
  sessionId: string,
  trigger: HTMLElement,
  container: HTMLElement,
  select: (tabId: number) => Promise<string | null>,
  onClose: () => void,
): WorkTabPicker {
  const state: PickerState = {
    generation: 0,
    closed: false,
    loading: false,
    saving: false,
    tabs: [],
    error: null,
  };
  const scrollTop: number = container.scrollTop;
  const { element, cancel, search, clear, refresh, count, body }: PickerControls = pickerControls();
  const close: (restoreFocus?: boolean) => void = (restoreFocus: boolean = true): void => {
    if (state.closed) return;
    state.closed = true;
    state.generation += 1;
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

  const renderMatches: () => void = (): void => {
    clear.disabled = state.saving || search.value.length === 0;
    if (state.closed || state.loading || state.saving) return;
    body.replaceChildren();
    if (state.error !== null) {
      const alert: HTMLElement = status(state.error);
      alert.setAttribute('role', 'alert');
      body.append(alert);
      count.textContent = '';
      return;
    }
    const matches: WorkTab[] = matchingTabs(state.tabs, search.value);
    count.textContent = `${matches.length} of ${state.tabs.length} ${state.tabs.length === 1 ? 'tab' : 'tabs'}`;
    appendMatches(
      body,
      state.tabs.length,
      matches,
      (tabId: number, row: HTMLButtonElement): void => {
        void choose(tabId, row);
      },
    );
  };
  search.addEventListener('input', renderMatches);
  clear.addEventListener('click', (): void => {
    if (state.saving) return;
    search.value = '';
    search.focus({ preventScroll: true });
    renderMatches();
  });

  const load: () => Promise<void> = async (): Promise<void> => {
    if (state.closed || state.loading || state.saving) return;
    const request: number = ++state.generation;
    state.loading = true;
    const root: Node = element.getRootNode();
    if (
      root instanceof ShadowRoot &&
      (body.contains(root.activeElement) || root.activeElement === refresh)
    )
      cancel.focus({ preventScroll: true });
    refresh.disabled = true;
    body.replaceChildren(status('Finding available tabs...'));
    body.setAttribute('aria-busy', 'true');
    count.textContent = '';
    let result: WorkTabsResult | null = null;
    try {
      result = parseWorkTabsResult(await sendRequest({ type: 'getWorkTabs', sessionId }));
    } catch {
      // Render the same retry action for transport failures and invalid replies.
    }
    if (state.closed || request !== state.generation) return;
    state.loading = false;
    refresh.disabled = false;
    state.tabs = result?.ok ? result.tabs : [];
    state.error = result?.ok ? null : (result?.error ?? 'Could not load work tabs. Try again.');
    body.setAttribute('aria-busy', 'false');
    renderMatches();
  };
  refresh.addEventListener('click', (): void => {
    void load();
  });

  const choose: (tabId: number, row: HTMLButtonElement) => Promise<void> = async (
    tabId: number,
    row: HTMLButtonElement,
  ): Promise<void> => {
    if (state.closed || state.loading || state.saving) return;
    const request: number = ++state.generation;
    state.saving = true;
    body.setAttribute('aria-busy', 'true');
    body.querySelector('[role="alert"]')?.remove();
    cancel.focus({ preventScroll: true });
    search.disabled = true;
    clear.disabled = true;
    refresh.disabled = true;
    for (const item of body.querySelectorAll<HTMLButtonElement>('button')) item.disabled = true;
    const pending: HTMLElement = status('Saving work tab...');
    body.append(pending);
    const error: string | null = await select(tabId);
    if (state.closed || request !== state.generation) return;
    state.saving = false;
    body.setAttribute('aria-busy', 'false');
    pending.remove();
    search.disabled = false;
    clear.disabled = search.value.length === 0;
    refresh.disabled = false;
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

function pickerControls(): PickerControls {
  const element: HTMLElement = document.createElement('section');
  element.className = 'work-picker';
  element.setAttribute('aria-label', 'Choose a work tab');
  const header: HTMLElement = document.createElement('div');
  header.className = 'work-picker-header';
  const heading: HTMLElement = document.createElement('h2');
  heading.textContent = 'Choose a work tab';
  const cancel: HTMLButtonElement = button('Cancel', 'work-picker-cancel');
  header.append(heading, cancel);
  const label: HTMLLabelElement = document.createElement('label');
  label.className = 'work-picker-search-label';
  label.textContent = 'Search work tabs';
  const search: HTMLInputElement = document.createElement('input');
  search.className = 'work-picker-search';
  search.type = 'search';
  search.placeholder = 'Search by title or website';
  search.setAttribute('aria-label', 'Search work tabs');
  search.autocomplete = 'off';
  search.spellcheck = false;
  label.append(search);
  const clear: HTMLButtonElement = button('Clear search', 'work-picker-clear');
  clear.disabled = true;
  const count: HTMLElement = status('');
  count.classList.add('work-picker-count');
  const refresh: HTMLButtonElement = button('Refresh tabs', 'work-picker-retry');
  const tools: HTMLElement = document.createElement('div');
  tools.className = 'work-picker-tools';
  tools.append(count, clear, refresh);
  const body: HTMLElement = document.createElement('div');
  body.className = 'work-picker-body';
  element.append(header, label, tools, body);
  return { element, cancel, search, clear, refresh, count, body };
}

function matchingTabs(tabs: WorkTab[], query: string): WorkTab[] {
  const terms: string[] = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return tabs.filter((tab: WorkTab): boolean => {
    const text: string = `${tab.title} ${tab.hostname ?? ''}`.toLocaleLowerCase();
    return terms.every((term: string): boolean => text.includes(term));
  });
}

function appendMatches(
  body: HTMLElement,
  total: number,
  matches: WorkTab[],
  select: (tabId: number, row: HTMLButtonElement) => void,
): void {
  if (matches.length === 0) {
    body.append(
      status(
        total === 0
          ? 'No available work tabs. Open a site allowed by this session, then refresh tabs.'
          : 'No matching tabs. Try another search or clear the search.',
      ),
    );
    return;
  }
  const list: HTMLElement = document.createElement('div');
  list.className = 'work-picker-list';
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'Available work tabs');
  for (const tab of matches) {
    const row: HTMLButtonElement = tabButton(tab);
    row.addEventListener('click', (): void => select(tab.tabId, row));
    list.append(row);
  }
  body.append(list);
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
  const text: HTMLElement = document.createElement('span');
  text.className = 'work-tab-text';
  text.append(title);
  if (tab.hostname !== undefined) {
    const hostname: HTMLElement = document.createElement('span');
    hostname.className = 'work-tab-hostname';
    hostname.textContent = tab.hostname;
    text.append(hostname);
  }
  row.append(icon, text, arrow);
  return row;
}

function navigate(event: KeyboardEvent, body: HTMLElement): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const rows: HTMLButtonElement[] = Array.from(
    body.querySelectorAll<HTMLButtonElement>('.work-tab-option:not(:disabled)'),
  );
  if (event.target instanceof HTMLInputElement && event.key === 'ArrowDown' && rows.length > 0) {
    event.preventDefault();
    rows[0]?.focus();
    return;
  }
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
.panel.panel-picker { max-width: 760px; }
.work-picker { width: 100%; padding: 1rem; border: 1px solid var(--overlay-input-border); border-radius: 1rem; background: var(--overlay-input-bg); text-align: left; }
.work-picker-header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.work-picker-search-label { display: grid; gap: 0.45rem; margin-top: 1rem; font-size: 0.85rem; color: var(--overlay-muted); }
.work-picker-search { width: 100%; min-width: 0; padding: 0.75rem 0.85rem; border: 1px solid var(--overlay-input-border); border-radius: 0.65rem; background: var(--overlay-bg); color: var(--overlay-text); font: inherit; font-size: 1rem; }
.work-picker-tools { display: flex; align-items: center; gap: 0.4rem; margin-block: 0.4rem 0.65rem; }
.work-picker-count { flex: 1; }
.work-picker-clear:disabled, .work-picker-retry:disabled { opacity: 0.55; }
.work-picker h2 { font-size: 1rem; font-weight: 650; }
.work-picker-cancel, .work-picker-retry, .work-picker-clear, .change-work { padding: 0.45rem 0.65rem; border-radius: 0.5rem; background: transparent; color: var(--overlay-muted); font-size: 0.85rem; }
.work-picker-cancel:hover, .work-picker-retry:hover:enabled, .work-picker-clear:hover:enabled, .change-work:hover { background: var(--overlay-pill); color: var(--overlay-text); }
.change-work[hidden] { display: none; }
.work-picker-status { font-size: 0.85rem; line-height: 1.5; color: var(--overlay-muted); margin-block: 0.7rem; overflow-wrap: anywhere; }
.work-picker [role="alert"] { color: var(--overlay-error-text); background: var(--overlay-error-bg); padding: 0.65rem; border-radius: 0.5rem; }
.work-picker-body { display: flow-root; min-height: min(24rem, 45vh); }
.work-picker-list { display: grid; gap: 0.75rem; max-height: min(24rem, 45vh); overflow-y: auto; overscroll-behavior: contain; padding: 0.5rem; margin: -0.5rem; }
.work-tab-option { display: flex; align-items: center; gap: 0.75rem; width: 100%; padding: 0.8rem; border: 1px solid var(--overlay-meter); border-radius: 0.7rem; background: var(--overlay-pill); color: var(--overlay-text); text-align: left; }
.work-tab-option:hover:enabled { background: var(--overlay-pill-hover); border-color: var(--overlay-bank); }
.work-tab-option:disabled { opacity: 0.55; }
.work-tab-text { flex: 1; min-width: 0; display: grid; gap: 0.2rem; }
.work-tab-hostname { color: var(--overlay-muted); font-size: 0.8rem; overflow-wrap: anywhere; }
.work-tab-title { overflow-wrap: anywhere; font-size: 0.9rem; line-height: 1.4; }
.work-tab-icon { width: 1.15rem; height: 1rem; flex-shrink: 0; border: 1.5px solid var(--overlay-muted); border-radius: 0.2rem; box-shadow: inset 0 0.2rem var(--overlay-pill-hover); }
.work-tab-arrow { color: var(--overlay-bank); }
@media (max-width: 400px) { .work-picker { padding: 0.75rem; } .work-tab-option { gap: 0.6rem; padding: 0.7rem; } }
`;
