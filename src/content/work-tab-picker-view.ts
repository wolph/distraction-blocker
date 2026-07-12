/**
 * The work tab picker's static shell and its stylesheet. The strings here are renderer-owned
 * lookup labels and picker chrome, never session state: the worker's frozen view carries every
 * word that depends on the session, and this block carries the rest in one place.
 */

/** Every label the lock screen and its picker author locally, in one block. */
export const WORK_TARGET_COPY: Readonly<{
  pickerHeading: string;
  cancel: string;
  searchLabel: string;
  searchPlaceholder: string;
  clearSearch: string;
  refreshTabs: string;
  availableTabs: string;
  finding: string;
  searching: string;
  saving: string;
  noTabs: string;
  noMatches: string;
  loadFailed: string;
  checking: string;
  pickOne: string;
  sessionUnavailable: string;
  lookupFailed: string;
  reconnect: string;
  pageChanged: string;
  transportError: string;
}> = {
  pickerHeading: 'Choose a work tab',
  cancel: 'Cancel',
  searchLabel: 'Search work tabs',
  searchPlaceholder: 'Search by title or website',
  clearSearch: 'Clear search',
  refreshTabs: 'Refresh tabs',
  availableTabs: 'Available work tabs',
  finding: 'Finding available tabs...',
  searching: 'Searching work tabs...',
  saving: 'Saving work tab...',
  noTabs: 'No available work tabs. Open a site allowed by this session, then refresh tabs.',
  noMatches: 'No matching tabs. Try another search or clear the search.',
  loadFailed: 'Could not load work tabs. Try again.',
  checking: 'Checking available work tabs...',
  pickOne: 'Pick an open tab to continue your task.',
  sessionUnavailable: 'Your focus session is not available. Try again, or reload this page.',
  lookupFailed: 'Could not load your work tab. Try again, or reload this page.',
  reconnect: 'Reload this page to reconnect to Focus Lock.',
  pageChanged: 'The requesting page has changed. Reload the page.',
  transportError: 'Could not reach Focus Lock. Try again.',
};

export interface PickerControls {
  element: HTMLElement;
  cancel: HTMLButtonElement;
  search: HTMLInputElement;
  clear: HTMLButtonElement;
  refresh: HTMLButtonElement;
  count: HTMLElement;
  body: HTMLElement;
}

export function pickerControls(): PickerControls {
  const element: HTMLElement = document.createElement('section');
  element.className = 'work-picker';
  element.setAttribute('aria-label', WORK_TARGET_COPY.pickerHeading);
  const header: HTMLElement = document.createElement('div');
  header.className = 'work-picker-header';
  const heading: HTMLElement = document.createElement('h2');
  heading.textContent = WORK_TARGET_COPY.pickerHeading;
  const cancel: HTMLButtonElement = button(WORK_TARGET_COPY.cancel, 'work-picker-cancel');
  header.append(heading, cancel);
  const label: HTMLLabelElement = document.createElement('label');
  label.className = 'work-picker-search-label';
  label.textContent = WORK_TARGET_COPY.searchLabel;
  const search: HTMLInputElement = document.createElement('input');
  search.className = 'work-picker-search';
  search.type = 'search';
  search.placeholder = WORK_TARGET_COPY.searchPlaceholder;
  search.setAttribute('aria-label', WORK_TARGET_COPY.searchLabel);
  search.autocomplete = 'off';
  search.spellcheck = false;
  label.append(search);
  const clear: HTMLButtonElement = button(WORK_TARGET_COPY.clearSearch, 'work-picker-clear');
  clear.disabled = true;
  const count: HTMLElement = status('');
  count.classList.add('work-picker-count');
  const refresh: HTMLButtonElement = button(WORK_TARGET_COPY.refreshTabs, 'work-picker-retry');
  const tools: HTMLElement = document.createElement('div');
  tools.className = 'work-picker-tools';
  tools.append(count, clear, refresh);
  const body: HTMLElement = document.createElement('div');
  body.className = 'work-picker-body';
  element.append(header, label, tools, body);
  return { element, cancel, search, clear, refresh, count, body };
}

function button(text: string, className: string): HTMLButtonElement {
  const element: HTMLButtonElement = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = text;
  return element;
}

export function status(text: string): HTMLElement {
  const element: HTMLElement = document.createElement('p');
  element.className = 'work-picker-status';
  element.setAttribute('role', 'status');
  element.textContent = text;
  return element;
}

export const WORK_PICKER_CSS: string = `
.work-picker { position: fixed; inset: clamp(8px, 2vw, 24px); z-index: 1; padding: clamp(12px, 2vw, 24px); border: 1px solid var(--overlay-input-border); border-radius: 1rem; background: var(--overlay-opaque); color: var(--overlay-text); text-align: left; display: flex; flex-direction: column; min-height: 0; box-shadow: 0 16px 60px #0003; }
.work-picker-header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-shrink: 0; }
.work-picker h2 { font-size: 1.2rem; font-weight: 650; }
.work-picker-search-label { display: grid; gap: 0.45rem; margin-top: 0.8rem; font-size: 0.85rem; color: var(--overlay-muted); flex-shrink: 0; }
.work-picker-search { width: 100%; min-width: 0; padding: 0.75rem 0.85rem; border: 1px solid var(--overlay-input-border); border-radius: 0.65rem; background: var(--overlay-input-bg); color: var(--overlay-text); font: inherit; font-size: 1rem; }
.work-picker-tools { display: flex; align-items: center; gap: 0.4rem; margin-block: 0.4rem; flex-shrink: 0; }
.work-picker-count { flex: 1; }
.work-picker-cancel, .work-picker-retry, .work-picker-clear, .change-work { padding: 0.45rem 0.65rem; border-radius: 0.5rem; background: transparent; color: var(--overlay-muted); font-size: 0.85rem; }
.work-picker-cancel:hover, .work-picker-retry:hover:enabled, .work-picker-clear:hover:enabled, .change-work:hover { background: var(--overlay-pill); color: var(--overlay-text); }
.work-picker-clear:disabled, .work-picker-retry:disabled { opacity: 0.55; }
.change-work[hidden] { display: none; }
.work-picker-status { font-size: 0.85rem; line-height: 1.5; color: var(--overlay-muted); margin-block: 0.5rem; overflow-wrap: anywhere; }
.work-picker [role="alert"] { color: var(--overlay-error-text); background: var(--overlay-error-bg); padding: 0.65rem; border-radius: 0.5rem; }
.work-picker-body { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.work-picker-feedback[hidden] { display: none; }
.work-picker-list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.work-picker-space { position: relative; min-width: 0; }
.work-tab-option { position: absolute; left: 8px; right: 8px; height: 72px; display: flex; align-items: center; gap: 0.85rem; padding: 0.55rem 0.8rem; border: 1px solid var(--overlay-meter); border-left: 3px solid var(--tab-colour); border-radius: 0.7rem; background: var(--overlay-pill); color: var(--overlay-text); text-align: left; }
.work-tab-option:hover:enabled { background: var(--overlay-pill-hover); border-color: var(--tab-colour); }
.work-tab-option:disabled { opacity: 0.55; }
.work-tab-text { flex: 1; min-width: 0; display: grid; gap: 0.1rem; }
.work-tab-title { font-size: 0.95rem; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.work-tab-hostname { color: var(--overlay-muted); font-size: 0.75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.work-tab-icon { position: relative; width: 36px; height: 36px; flex-shrink: 0; display: grid; place-items: center; border: 1px solid var(--tab-colour); border-radius: 0.5rem; background: color-mix(in srgb, var(--tab-colour) 18%, var(--overlay-opaque)); color: var(--overlay-text); font-size: 0.9rem; font-weight: 650; }
.work-tab-icon img { position: absolute; width: 24px; height: 24px; object-fit: contain; }
.work-tab-icon.has-icon { font-size: 0; }
.return-work .work-action-label, .return-work .work-action-title, .return-work .work-action-host { display: block; }
.return-work .work-action-title { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; font-size: 0.9rem; font-weight: 500; margin-top: 0.3rem; overflow-wrap: anywhere; }
.return-work .work-action-host { font-size: 0.75rem; font-weight: 400; margin-top: 0.15rem; overflow-wrap: anywhere; }
`;
