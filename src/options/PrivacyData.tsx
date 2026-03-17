import type { TargetedEvent, TargetedMouseEvent, VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useRef, useState } from 'preact/hooks';
import { sendRequest } from '../shared/messages';
import { WEBSITE_ORIGINS } from '../shared/permissions';
import { LOCAL_ONLY_DATA_ITEMS, SYNCED_DATA_ITEMS } from '../shared/privacy-copy';
import { parseEventExportResponse } from '../shared/runtime-validation';
import { localDateStr } from '../shared/time';
import type { SetupState, StorageMode } from '../shared/types';

type Confirmation = 'local-history' | 'synced-policy' | null;

export interface PrivacyDataProps {
  setup: SetupState;
  onReconcileWebsiteAccess: () => Promise<string | null>;
  onStorageModeChange: (next: StorageMode) => Promise<string | null>;
  onRetrySync: () => Promise<string | null>;
  onClearData: (scope: 'local-history' | 'synced-policy' | 'all') => Promise<string | null>;
  onRetryDataClear: () => Promise<string | null>;
}

interface WebsiteAccessPresentation {
  action: 'enable' | 'retry' | null;
  actionLabel: string | null;
  detail: string;
  title: string;
}

function websiteAccessPresentation(setup: SetupState): WebsiteAccessPresentation {
  if (setup.websiteAccess !== 'granted') {
    return {
      action: 'enable',
      actionLabel: 'Enable website blocking',
      title: 'Website access is off',
      detail: 'Focus Lock cannot block websites until you grant access.',
    };
  }
  if (setup.blockingRegistration !== 'ready') {
    return {
      action: 'retry',
      actionLabel: 'Retry website blocking',
      title: 'Website access is granted, but blocking is not active',
      detail: 'Chrome granted access, but Focus Lock could not register its blocking script.',
    };
  }
  return {
    action: null,
    actionLabel: null,
    title: 'Website blocking is enabled',
    detail: 'Focus Lock can apply your active blocking rules on regular website pages.',
  };
}

function DataScope(props: { items: readonly string[]; title: string }): VNode {
  return (
    <section class="privacy-data-scope">
      <h4>{props.title}</h4>
      <ul>
        {props.items.map(
          (item: string): VNode => (
            <li key={item}>{item}</li>
          ),
        )}
      </ul>
    </section>
  );
}

function ConfirmationDialog(props: {
  kind: Exclude<Confirmation, null>;
  localOnlyAggregates: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): VNode {
  const dialog: { current: HTMLDialogElement | null } = useRef<HTMLDialogElement>(null);
  const cancelButton: { current: HTMLButtonElement | null } = useRef<HTMLButtonElement>(null);
  useEffect((): (() => void) => {
    const current: HTMLDialogElement | null = dialog.current;
    if (current === null) return (): void => {};
    if (typeof current.showModal === 'function') current.showModal();
    else current.setAttribute('open', '');
    cancelButton.current?.focus();
    return (): void => {
      if (current.open && typeof current.close === 'function') current.close();
    };
  }, []);
  useEffect((): (() => void) => {
    const onKeyDown: (event: KeyboardEvent) => void = (event: KeyboardEvent): void => {
      const current: HTMLDialogElement | null = dialog.current;
      if (current === null) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!props.pending) props.onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls: HTMLButtonElement[] = Array.from(
        current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
      );
      event.preventDefault();
      if (controls.length === 0) {
        current.focus();
        return;
      }
      const first: HTMLButtonElement | undefined = controls[0];
      const last: HTMLButtonElement | undefined = controls.at(-1);
      if (first === undefined || last === undefined) {
        current.focus();
        return;
      }
      const active: Element | null = document.activeElement;
      if (event.shiftKey) {
        (active === first || !current.contains(active) ? last : first).focus();
      } else {
        (active === last || !current.contains(active) ? first : last).focus();
      }
    };
    const blockBackgroundClick: (event: MouseEvent) => void = (event: MouseEvent): void => {
      const current: HTMLDialogElement | null = dialog.current;
      const target: Node | null = event.target instanceof Node ? event.target : null;
      if (current === null || (target !== null && current.contains(target))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('click', blockBackgroundClick, true);
    return (): void => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('click', blockBackgroundClick, true);
    };
  }, [props.onCancel, props.pending]);
  const local: boolean = props.kind === 'local-history';
  const title: string = local ? 'Delete local history?' : 'Delete remote Sync data?';
  const confirmLabel: string = local
    ? 'Confirm delete local history'
    : 'Confirm delete remote Sync data';
  return (
    <dialog
      ref={dialog}
      class="privacy-confirmation"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      onCancel={(event: TargetedEvent<HTMLDialogElement>): void => {
        event.preventDefault();
        if (!props.pending) props.onCancel();
      }}
    >
      <h4>{title}</h4>
      {local ? (
        <p>
          This permanently deletes full URLs, focus intentions, and detailed session events from
          this device
          {props.localOnlyAggregates ? ', plus local-only aggregate statistics' : ''}. It does not
          clear a running session, which keeps its intention and the address of every website tab
          open while it runs.
        </p>
      ) : (
        <p>
          This permanently deletes remote settings, block and allow lists, pause balance, streaks,
          and domain-level blocked-attempt aggregates from Chrome Sync. Local settings and
          statistics stay on this device.
        </p>
      )}
      <div class="privacy-confirmation-actions">
        <button
          ref={cancelButton}
          type="button"
          class="secondary"
          disabled={props.pending}
          onClick={props.onCancel}
        >
          Cancel
        </button>
        <button type="button" class="danger" disabled={props.pending} onClick={props.onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

function durableError(setup: SetupState): string | null {
  if (setup.dataClear.status === 'error') {
    if (setup.dataClear.scope === 'local-history') {
      return 'Local history could not be deleted. Try again.';
    }
    if (setup.dataClear.scope === 'synced-policy') {
      return 'Remote Chrome Sync data could not be deleted. Try again.';
    }
    return 'All Focus Lock data could not be deleted. Try again.';
  }
  if (setup.syncWriteStatus === 'error') {
    return 'Chrome Sync could not save your latest changes. Your local save is safe.';
  }
  return null;
}

export function PrivacyData(props: PrivacyDataProps): VNode {
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [confirmation, setConfirmation]: [Confirmation, Dispatch<StateUpdater<Confirmation>>] =
    useState<Confirmation>(null);
  const [actionError, setActionError]: [string | null, Dispatch<StateUpdater<string | null>>] =
    useState<string | null>(null);
  const [status, setStatus]: [string, Dispatch<StateUpdater<string>>] = useState<string>('');
  const actionLocked: { current: boolean } = useRef<boolean>(false);
  const confirmationOrigin: { current: HTMLButtonElement | null } = useRef<HTMLButtonElement>(null);
  const previousConfirmation: { current: Confirmation } = useRef<Confirmation>(null);

  useEffect((): void => {
    const previous: Confirmation = previousConfirmation.current;
    previousConfirmation.current = confirmation;
    if (previous === null || confirmation !== null) return;
    const active: Element | null = document.activeElement;
    if (active === document.body || active?.closest('.privacy-confirmation') !== null) {
      confirmationOrigin.current?.focus();
    }
  }, [confirmation]);

  const runAction: (action: () => Promise<string | null>, success: string) => Promise<void> =
    async (action: () => Promise<string | null>, success: string): Promise<void> => {
      if (actionLocked.current) return;
      actionLocked.current = true;
      setPending(true);
      setActionError(null);
      setStatus('');
      try {
        const error: string | null = await action();
        if (error === null) setStatus(success);
        else setActionError(error);
      } catch {
        setActionError('The request could not be completed. Try again.');
      } finally {
        actionLocked.current = false;
        setPending(false);
      }
    };

  const enableWebsiteBlocking: () => Promise<void> = async (): Promise<void> => {
    if (actionLocked.current) return;
    actionLocked.current = true;
    setPending(true);
    setActionError(null);
    setStatus('');
    try {
      const granted: boolean = await chrome.permissions.request({ origins: [...WEBSITE_ORIGINS] });
      const error: string | null = await props.onReconcileWebsiteAccess();
      if (error === null) {
        setStatus(granted ? 'Website access updated.' : 'Website access was not granted.');
      } else setActionError(error);
    } catch {
      setActionError('Website access could not be updated. Try again.');
    } finally {
      actionLocked.current = false;
      setPending(false);
    }
  };

  const exportLocalEvents: () => Promise<string | null> = async (): Promise<string | null> => {
    try {
      const response: unknown = await sendRequest({ type: 'exportEvents' });
      if (parseEventExportResponse(response) === null) return 'Could not export the event log.';
      const exportResponse: { json: string } = response as { json: string };
      const blob: Blob = new Blob([exportResponse.json], { type: 'application/json' });
      const url: string = URL.createObjectURL(blob);
      const anchor: HTMLAnchorElement = document.createElement('a');
      anchor.href = url;
      anchor.download = `focus-lock-events-${localDateStr(Date.now())}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      return null;
    } catch {
      return 'Could not export the event log. Try again.';
    }
  };

  const confirmDeletion: () => void = (): void => {
    const scope: Confirmation = confirmation;
    if (scope === null) return;
    void runAction(
      async (): Promise<string | null> => {
        const error: string | null = await props.onClearData(scope);
        if (error === null) setConfirmation(null);
        return error;
      },
      scope === 'local-history' ? 'Local history deleted.' : 'Remote Chrome Sync data deleted.',
    );
  };

  const openConfirmation: (kind: Exclude<Confirmation, null>, origin: HTMLButtonElement) => void = (
    kind: Exclude<Confirmation, null>,
    origin: HTMLButtonElement,
  ): void => {
    confirmationOrigin.current = origin;
    setConfirmation(kind);
  };

  const website: WebsiteAccessPresentation = websiteAccessPresentation(props.setup);
  const syncing: boolean = props.setup.storageMode === 'sync';
  const localMode: boolean = props.setup.storageMode === 'local';
  const syncPending: boolean = props.setup.syncWriteStatus === 'pending';
  const syncFailure: boolean =
    props.setup.syncWriteStatus === 'error' && props.setup.dataClear.status === 'idle';
  const firstSyncFailure: boolean = syncFailure && props.setup.storageMode !== 'sync';
  const dataClearFailure: Exclude<SetupState['dataClear']['scope'], null> | null =
    props.setup.dataClear.status === 'error' ? props.setup.dataClear.scope : null;
  const visibleError: string | null = actionError ?? durableError(props.setup);

  return (
    <div class="privacy-data">
      <section class="privacy-card" aria-labelledby="website-access-heading">
        <h3 id="website-access-heading">Website access</h3>
        <strong class="privacy-card-status">{website.title}</strong>
        <p>{website.detail}</p>
        <div class="privacy-actions">
          {website.actionLabel === null ? null : (
            <button
              type="button"
              class="primary"
              disabled={pending}
              onClick={(): void => {
                if (website.action === 'enable') void enableWebsiteBlocking();
                else void runAction(props.onReconcileWebsiteAccess, 'Website blocking enabled.');
              }}
            >
              {website.actionLabel}
            </button>
          )}
          <button
            type="button"
            class="secondary"
            disabled={pending}
            onClick={(): void => {
              void runAction(async (): Promise<string | null> => {
                try {
                  await chrome.tabs.create({
                    url: `chrome://extensions/?id=${chrome.runtime.id}`,
                  });
                  return null;
                } catch {
                  return 'Could not open Chrome permission settings. Try again.';
                }
              }, 'Chrome permission settings opened.');
            }}
          >
            Open Chrome permission settings
          </button>
        </div>
      </section>

      <section class="privacy-card" aria-labelledby="chrome-sync-heading">
        <h3 id="chrome-sync-heading">Chrome Sync</h3>
        <label class="privacy-switch">
          <input
            type="checkbox"
            role="switch"
            aria-checked={syncing}
            checked={syncing}
            disabled={pending || syncPending || props.setup.storageMode === null}
            onChange={(event: TargetedEvent<HTMLInputElement>): void => {
              const next: StorageMode = event.currentTarget.checked ? 'sync' : 'local';
              void runAction(
                (): Promise<string | null> => props.onStorageModeChange(next),
                next === 'sync' ? 'Chrome Sync enabled.' : 'Chrome Sync disabled.',
              );
            }}
          />
          <span>Sync Focus Lock data across Chrome devices</span>
        </label>
        {syncPending ? (
          <p>Chrome Sync is still saving your latest changes.</p>
        ) : syncFailure ? null : (
          <p>{syncing ? 'Chrome Sync is on.' : 'Chrome Sync is off.'}</p>
        )}
        {syncFailure ? (
          <button
            type="button"
            class="secondary"
            disabled={pending}
            onClick={(): void => {
              void runAction(
                firstSyncFailure
                  ? (): Promise<string | null> => props.onStorageModeChange('sync')
                  : props.onRetrySync,
                firstSyncFailure ? 'Chrome Sync enabled.' : 'Chrome Sync changes saved.',
              );
            }}
          >
            {firstSyncFailure ? 'Retry enabling Chrome Sync' : 'Retry Chrome Sync'}
          </button>
        ) : null}
        <div class="privacy-data-grid">
          <DataScope title="Synced" items={SYNCED_DATA_ITEMS} />
          <DataScope title="Local only" items={LOCAL_ONLY_DATA_ITEMS} />
        </div>
        <p class="privacy-developer-note">Nothing is sent to the Focus Lock developer.</p>
      </section>

      <section class="privacy-card" aria-labelledby="local-log-heading">
        <h3 id="local-log-heading">Local event log</h3>
        <p>Export the detailed local log or delete local browsing and session history.</p>
        <div class="privacy-actions">
          <button
            type="button"
            class="secondary"
            disabled={pending}
            onClick={(): void => {
              void runAction(exportLocalEvents, 'Local event log exported.');
            }}
          >
            Export local event log
          </button>
          <button
            type="button"
            class="danger"
            disabled={pending}
            onClick={(event: TargetedMouseEvent<HTMLButtonElement>): void =>
              openConfirmation('local-history', event.currentTarget)
            }
          >
            Delete local history
          </button>
        </div>
      </section>

      {!localMode ? null : (
        <section class="privacy-card" aria-labelledby="remote-data-heading">
          <h3 id="remote-data-heading">Remote Sync data</h3>
          <p>Delete the Focus Lock copies left in Chrome Sync without changing this device.</p>
          <button
            type="button"
            class="danger"
            disabled={pending}
            onClick={(event: TargetedMouseEvent<HTMLButtonElement>): void =>
              openConfirmation('synced-policy', event.currentTarget)
            }
          >
            Delete remote Sync data
          </button>
        </section>
      )}

      {confirmation === null ? null : (
        <ConfirmationDialog
          kind={confirmation}
          localOnlyAggregates={localMode}
          pending={pending}
          onCancel={(): void => setConfirmation(null)}
          onConfirm={confirmDeletion}
        />
      )}
      {visibleError === null ? null : (
        <p class="save-error privacy-message" role="alert">
          {visibleError}
        </p>
      )}
      {dataClearFailure === null ? null : (
        <button
          type="button"
          class="secondary privacy-retry"
          disabled={pending}
          onClick={(): void => {
            // An all-data deletion in progress is retried, never started again. Asking for a new
            // deletion runs no phase of the one that is already stuck and answers success for it.
            if (dataClearFailure === 'all') {
              void runAction(props.onRetryDataClear, 'Resuming deletion of all Focus Lock data.');
              return;
            }
            const success: string =
              dataClearFailure === 'local-history'
                ? 'Local history deleted.'
                : 'Remote Chrome Sync data deleted.';
            void runAction(
              (): Promise<string | null> => props.onClearData(dataClearFailure),
              success,
            );
          }}
        >
          {dataClearFailure === 'local-history'
            ? 'Retry local history deletion'
            : dataClearFailure === 'synced-policy'
              ? 'Retry remote Sync deletion'
              : 'Retry all data deletion'}
        </button>
      )}
      <p class="privacy-live-region" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
