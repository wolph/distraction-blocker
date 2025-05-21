import type { TargetedEvent, VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import { CATEGORY_IDS } from '../shared/constants';
import { sendRequest, type WebsiteAccessReconciliation } from '../shared/messages';
import { WEBSITE_ORIGINS } from '../shared/permissions';
import { isListsConfig, isSettings, isSetupState } from '../shared/runtime-validation';
import type { CategoryId, ListsConfig, Settings, SetupState } from '../shared/types';
import {
  completeOnboardingDraft,
  createOnboardingDraft,
  type DraftLoadResult,
  loadOnboardingDraft,
  type OnboardingDraft,
  OnboardingDraftConflictError,
  type OnboardingStep,
  removeOnboardingDraft,
  saveOnboardingDraft,
} from './draft-storage';

type PageState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'complete' }
  | { kind: 'draft'; draft: OnboardingDraft; recovered: boolean };

const CATEGORY_LABELS: Record<CategoryId, string> = {
  social: 'Social',
  video: 'Video',
  news: 'News',
  mail: 'Mail',
  shopping: 'Shopping',
  gaming: 'Gaming',
  forums: 'Forums',
};

function SetupComplete(): VNode {
  return (
    <main class="onboarding-card onboarding-complete">
      <p class="eyebrow">Focus Lock</p>
      <h1>Setup complete</h1>
      <p>Your choices are saved. Open Focus Lock from the Chrome toolbar to start a session.</p>
    </main>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }): VNode {
  return (
    <main class="onboarding-card onboarding-error">
      <p class="eyebrow">Focus Lock</p>
      <h1>Setup unavailable</h1>
      <p role="alert">Could not load setup. Try again.</p>
      <button type="button" class="primary-button" onClick={onRetry}>
        Retry
      </button>
    </main>
  );
}

function Progress({ step }: { step: OnboardingStep }): VNode {
  return <p class="progress">Step {step} of 3</p>;
}

function StartingListsStep(props: {
  draft: OnboardingDraft;
  pending: boolean;
  onListsChange: (lists: ListsConfig) => Promise<void>;
  onContinue: () => Promise<void>;
}): VNode {
  const toggleCategory: (categoryId: CategoryId) => Promise<void> = async (
    categoryId: CategoryId,
  ): Promise<void> => {
    const lists: ListsConfig = structuredClone(props.draft.lists);
    lists.categories[categoryId] = !lists.categories[categoryId];
    await props.onListsChange(lists);
  };
  return (
    <section aria-labelledby="starting-lists-heading">
      <h1 id="starting-lists-heading" tabIndex={-1}>
        Choose your starting block list
      </h1>
      <p>Select the categories Focus Lock should use as defaults for future sessions.</p>
      <fieldset class="category-grid" disabled={props.pending}>
        <legend>Website categories</legend>
        {CATEGORY_IDS.map(
          (categoryId: CategoryId): VNode => (
            <label key={categoryId}>
              <input
                type="checkbox"
                checked={props.draft.lists.categories[categoryId]}
                onChange={(): void => void toggleCategory(categoryId)}
              />
              {CATEGORY_LABELS[categoryId]}
            </label>
          ),
        )}
      </fieldset>
      <button
        type="button"
        class="primary-button"
        disabled={props.pending}
        onClick={(): void => void props.onContinue()}
      >
        Continue
      </button>
    </section>
  );
}

function WebsiteAccessStep(props: {
  draft: OnboardingDraft;
  pending: boolean;
  error: string | null;
  onEnable: () => Promise<void>;
  onDefer: () => Promise<void>;
}): VNode {
  const denied: boolean = props.draft.websiteAccessChoice === 'denied';
  return (
    <section aria-labelledby="website-access-heading">
      <h1 id="website-access-heading" tabIndex={-1}>
        Enable website blocking
      </h1>
      <p>
        Focus Lock needs website access before it can match page addresses and show the blocking
        screen.
      </p>
      {denied ? <p role="status">Chrome did not grant website access. You can retry.</p> : null}
      {props.error !== null ? <p role="alert">{props.error}</p> : null}
      <div class="button-row">
        <button
          type="button"
          class="primary-button"
          disabled={props.pending}
          onClick={(): void => void props.onEnable()}
        >
          Enable website blocking
        </button>
        <button
          type="button"
          class="secondary-button"
          disabled={props.pending}
          onClick={(): void => void props.onDefer()}
        >
          Not now
        </button>
      </div>
    </section>
  );
}

function SyncChoiceStep(props: {
  draft: OnboardingDraft;
  pending: boolean;
  error: string | null;
  onSyncChange: (enabled: boolean) => Promise<void>;
  onComplete: () => Promise<void>;
}): VNode {
  const completionLabel: string = props.draft.syncEnabled
    ? 'Finish setup with sync enabled'
    : 'Finish setup without sync';
  return (
    <section aria-labelledby="sync-choice-heading">
      <h1 id="sync-choice-heading" tabIndex={-1}>
        Choose where your settings are stored
      </h1>
      <label class="sync-choice">
        <input
          type="checkbox"
          role="switch"
          aria-label="Sync across Chrome devices"
          aria-checked={props.draft.syncEnabled}
          checked={props.draft.syncEnabled}
          disabled={props.pending}
          onChange={(event: TargetedEvent<HTMLInputElement>): void =>
            void props.onSyncChange(event.currentTarget.checked)
          }
        />
        <span>
          <strong>Sync across Chrome devices</strong>
          <small>
            Settings and summary statistics use Chrome Sync. Detailed activity stays local.
          </small>
        </span>
      </label>
      {props.error !== null ? <p role="alert">{props.error}</p> : null}
      <button
        type="button"
        class="primary-button"
        disabled={props.pending}
        onClick={(): void => void props.onComplete()}
      >
        {completionLabel}
      </button>
    </section>
  );
}

export function App(): VNode {
  const [page, setPage]: [PageState, Dispatch<StateUpdater<PageState>>] = useState<PageState>({
    kind: 'loading',
  });
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [actionError, setActionError]: [string | null, Dispatch<StateUpdater<string | null>>] =
    useState<string | null>(null);
  const [loadAttempt, setLoadAttempt]: [number, Dispatch<StateUpdater<number>>] =
    useState<number>(0);

  useEffect((): (() => void) => {
    let active: boolean = true;
    const load: () => Promise<void> = async (): Promise<void> => {
      setPage({ kind: 'loading' });
      setActionError(null);
      try {
        const setup: SetupState = await sendRequest({ type: 'getSetupState' });
        if (!isSetupState(setup)) throw new Error('invalid setup response');
        if (setup.completed) {
          try {
            await removeOnboardingDraft();
          } catch (error: unknown) {
            console.error('could not remove stale onboarding draft', error);
          }
          if (active) setPage({ kind: 'complete' });
          return;
        }
        const [settings, lists, storedDraft]: [Settings, ListsConfig, DraftLoadResult] =
          await Promise.all([
            sendRequest({ type: 'getSettings' }),
            sendRequest({ type: 'getLists' }),
            loadOnboardingDraft(),
          ]);
        if (!isSettings(settings) || !isListsConfig(lists)) {
          throw new Error('invalid setup policy response');
        }
        let draft: OnboardingDraft = storedDraft.draft ?? createOnboardingDraft(settings, lists);
        if (storedDraft.draft === null) {
          try {
            draft = await saveOnboardingDraft(draft);
          } catch (error: unknown) {
            if (error instanceof OnboardingDraftConflictError && error.completed) {
              if (active) setPage({ kind: 'complete' });
              return;
            }
            if (!(error instanceof OnboardingDraftConflictError) || error.draft === null) {
              throw error;
            }
            draft = error.draft;
          }
        }
        if (active) setPage({ kind: 'draft', draft, recovered: storedDraft.invalid });
      } catch {
        if (active) setPage({ kind: 'error' });
      }
    };
    void load();
    return (): void => {
      active = false;
    };
  }, [loadAttempt]);

  const commitDraft: (draft: OnboardingDraft) => Promise<boolean> = async (
    draft: OnboardingDraft,
  ): Promise<boolean> => {
    try {
      const saved: OnboardingDraft = await saveOnboardingDraft(draft);
      setPage(
        (current: PageState): PageState =>
          current.kind === 'draft' ? { ...current, draft: saved } : current,
      );
      return true;
    } catch (error: unknown) {
      if (error instanceof OnboardingDraftConflictError) {
        if (error.completed) setPage({ kind: 'complete' });
        else if (error.draft !== null) {
          const authoritative: OnboardingDraft = error.draft;
          setPage(
            (current: PageState): PageState =>
              current.kind === 'draft' ? { ...current, draft: authoritative } : current,
          );
        }
        setActionError(error.message);
      } else {
        setActionError('Could not save setup progress. Try again.');
      }
      return false;
    }
  };

  const persist: (draft: OnboardingDraft) => Promise<boolean> = async (
    draft: OnboardingDraft,
  ): Promise<boolean> => {
    setPending(true);
    setActionError(null);
    try {
      return await commitDraft(draft);
    } finally {
      setPending(false);
    }
  };

  if (page.kind === 'loading') {
    return <main class="onboarding-card" aria-busy="true" />;
  }
  if (page.kind === 'error') {
    return <LoadError onRetry={(): void => setLoadAttempt((value: number): number => value + 1)} />;
  }
  if (page.kind === 'complete') return <SetupComplete />;

  const navigate: (
    step: OnboardingStep,
    choice?: OnboardingDraft['websiteAccessChoice'],
  ) => Promise<void> = async (
    step: OnboardingStep,
    choice?: OnboardingDraft['websiteAccessChoice'],
  ): Promise<void> => {
    const next: OnboardingDraft = {
      ...page.draft,
      step,
      websiteAccessChoice: choice ?? page.draft.websiteAccessChoice,
    };
    await persist(next);
  };

  const enableWebsiteAccess: () => Promise<void> = async (): Promise<void> => {
    setPending(true);
    setActionError(null);
    try {
      const granted: boolean = await chrome.permissions.request({ origins: [...WEBSITE_ORIGINS] });
      if (!granted) {
        await commitDraft({ ...page.draft, websiteAccessChoice: 'denied' });
        return;
      }
      const response: WebsiteAccessReconciliation = await sendRequest({
        type: 'reconcileWebsiteAccess',
      });
      if (!response.ok || !response.granted || response.registration !== 'ready') {
        const failed: OnboardingDraft = {
          ...page.draft,
          websiteAccessChoice: 'registration-error',
        };
        if (!(await commitDraft(failed))) return;
        setActionError(
          response.ok
            ? 'Website access is available, but blocking could not start. Retry setup.'
            : response.error,
        );
        return;
      }
      const next: OnboardingDraft = {
        ...page.draft,
        step: 3,
        websiteAccessChoice: 'granted',
      };
      await commitDraft(next);
    } catch {
      setActionError('Could not enable website blocking. Try again.');
    } finally {
      setPending(false);
    }
  };

  const completeSetup: () => Promise<void> = async (): Promise<void> => {
    setPending(true);
    setActionError(null);
    try {
      await completeOnboardingDraft(page.draft.revision, page.draft.syncEnabled ? 'sync' : 'local');
      try {
        await removeOnboardingDraft();
      } catch (error: unknown) {
        console.error('could not remove completed onboarding draft', error);
      }
      setPage({ kind: 'complete' });
    } catch (error: unknown) {
      if (error instanceof OnboardingDraftConflictError) {
        if (error.completed) setPage({ kind: 'complete' });
        else if (error.draft !== null) {
          const authoritative: OnboardingDraft = error.draft;
          setPage(
            (current: PageState): PageState =>
              current.kind === 'draft' ? { ...current, draft: authoritative } : current,
          );
        }
        setActionError(error.message);
      } else {
        setActionError('Could not complete setup. Your choices are still saved. Try again.');
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <main class="onboarding-card">
      <p class="eyebrow">Focus Lock setup</p>
      <Progress step={page.draft.step} />
      {page.recovered ? (
        <p class="recovery-notice" role="status">
          Your saved setup progress could not be restored. Starting again with your current
          defaults.
        </p>
      ) : null}
      {page.draft.step === 1 ? (
        <StartingListsStep
          draft={page.draft}
          pending={pending}
          onListsChange={async (lists: ListsConfig): Promise<void> =>
            void (await persist({ ...page.draft, lists }))
          }
          onContinue={async (): Promise<void> => navigate(2)}
        />
      ) : page.draft.step === 2 ? (
        <WebsiteAccessStep
          draft={page.draft}
          pending={pending}
          error={actionError}
          onEnable={enableWebsiteAccess}
          onDefer={async (): Promise<void> => navigate(3, 'deferred')}
        />
      ) : (
        <SyncChoiceStep
          draft={page.draft}
          pending={pending}
          error={actionError}
          onSyncChange={async (syncEnabled: boolean): Promise<void> =>
            void (await persist({ ...page.draft, syncEnabled }))
          }
          onComplete={completeSetup}
        />
      )}
      {page.draft.step === 1 && actionError !== null ? <p role="alert">{actionError}</p> : null}
    </main>
  );
}
