import type { DocumentContentCommand } from '../shared/enforcement-v2';
import type {
  Ack,
  OnboardingDraftConflict,
  OnboardingDraftLoadResponse,
  OnboardingDraftWriteResponse,
  OnboardingOperationalFailure,
  Request,
} from '../shared/messages';
import type {
  BlockingRegistrationStatus,
  ListsConfig,
  OnboardingDraft,
  Settings,
  SetupState,
  SoundSettings,
  StorageMode,
} from '../shared/types';
import { playSound } from './audio';
import type { AllDataClearPublicState } from './data-clear-journal';
import type { Engine } from './engine';
import { readEventsV2 } from './event-log-v2';
import type { PolicyStorage } from './policy-storage';
import { fetchStats } from './stats-service';

export interface OnboardingRouterServices {
  reconcileWebsiteAccess(): Promise<{
    permission: 'granted' | 'denied' | 'unknown';
    status: BlockingRegistrationStatus;
  }>;
  dismissWebsiteAccessNotice?(): Promise<void>;
  openOnboarding?(): Promise<void>;
  loadOnboardingDraft?(): Promise<OnboardingDraftLoadResponse>;
  saveOnboardingDraft?(draft: OnboardingDraft): Promise<OnboardingDraftWriteResponse>;
  removeOnboardingDraft(): Promise<void>;
  reportError(error: unknown): void;
  setupCompleted?(completed: boolean): void;
  /** The phase-aware manual retry of an exhausted all-data clear, through Main's dispatcher. */
  retryDataClear?(): Promise<'ok' | 'retry-not-available'>;
  /**
   * Runs whatever the all-data clear owes after the creation seam has done the phases it owns.
   * Main's dispatcher is the only caller of the browser reset and of finalization.
   */
  continueAllDataClear?(): Promise<void>;
}

async function completeSetupPolicy(
  engine: Engine,
  storage: PolicyStorage,
  storageMode: StorageMode,
  settings: Settings,
  lists: ListsConfig,
  onboardingServices?: OnboardingRouterServices,
): Promise<Ack> {
  if (storageMode === 'local') await storage.selectLocalMode();
  const settingsResult: Ack = await engine.updateSettings(settings);
  if (!settingsResult.ok) return settingsResult;
  const listsResult: Ack = await engine.updateLists(lists);
  if (!listsResult.ok) return listsResult;
  if (storageMode === 'sync') await storage.enableSync();
  await storage.markSetupCompleted();
  onboardingServices?.setupCompleted?.(true);
  if (onboardingServices !== undefined) {
    try {
      await onboardingServices.removeOnboardingDraft();
    } catch (error: unknown) {
      onboardingServices.reportError(error);
    }
  }
  return { ok: true };
}

function requirePolicyStorage(storage: PolicyStorage | undefined): PolicyStorage {
  if (storage === undefined) throw new Error('policy storage is unavailable');
  return storage;
}

function requireOnboardingServices(
  services: OnboardingRouterServices | undefined,
): OnboardingRouterServices {
  if (services === undefined) throw new Error('onboarding services are unavailable');
  return services;
}

function onboardingDraftConflict(
  draft: OnboardingDraft | null,
  completed: boolean,
): OnboardingDraftConflict {
  return {
    ok: false,
    error: completed
      ? 'Setup was completed in another tab.'
      : 'Setup changed in another tab. Reload setup before finishing.',
    conflict: true,
    completed,
    draft,
  };
}

function onboardingOperationalFailure(error: unknown): OnboardingOperationalFailure {
  const message: string = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: message.trim().length > 0 ? message : 'Onboarding operation failed.',
  };
}

/** Whether the commands this document must apply leave it blocked, which is what stops the page. */
/**
 * One exhaustive switch from typed requests to engine calls. The never
 * check at the bottom keeps it exhaustive when the message union grows.
 */
export async function routeMessage(
  engine: Engine,
  msg: Request,
  sender: chrome.runtime.MessageSender,
  policyStorage?: PolicyStorage,
  onboardingServices?: OnboardingRouterServices,
): Promise<unknown> {
  switch (msg.type) {
    case 'getSnapshot':
      // The read model is a settle at an instant, so it is read rather than committed. Waiting on
      // the mutation queue made this reject for the whole of any storage transition, which is
      // exactly the window the popup has to render the clear it is waiting on.
      return engine.snapshot();
    case 'getSetupState': {
      const storage: PolicyStorage = requirePolicyStorage(policyStorage);
      const setup: SetupState = await storage.loadSetup();
      // The journal outranks the Setup record it mirrors. Browser reset materializes an idle Setup
      // from the journal's own projection, so a clear that is still running would otherwise
      // publish as finished for exactly as long as it has left to run.
      const allData: AllDataClearPublicState = await storage.allDataClearPublicState();
      return allData.status === 'idle' ? setup : { ...setup, dataClear: allData };
    }
    case 'openOnboarding': {
      const open: (() => Promise<void>) | undefined =
        requireOnboardingServices(onboardingServices).openOnboarding;
      if (open === undefined) throw new Error('onboarding tab service is unavailable');
      await open();
      return { ok: true };
    }
    case 'getOnboardingDraft': {
      const load: (() => Promise<OnboardingDraftLoadResponse>) | undefined =
        requireOnboardingServices(onboardingServices).loadOnboardingDraft;
      if (load === undefined) throw new Error('onboarding draft service is unavailable');
      return load();
    }
    case 'cleanupOnboardingDraft': {
      try {
        const storage: PolicyStorage = requirePolicyStorage(policyStorage);
        if (!(await storage.loadSetup()).completed) {
          return { ok: false, error: 'Setup is not complete.' };
        }
        await requireOnboardingServices(onboardingServices).removeOnboardingDraft();
        return { ok: true };
      } catch (error: unknown) {
        return onboardingOperationalFailure(error);
      }
    }
    case 'saveOnboardingDraft': {
      const save: ((draft: OnboardingDraft) => Promise<OnboardingDraftWriteResponse>) | undefined =
        requireOnboardingServices(onboardingServices).saveOnboardingDraft;
      if (save === undefined) throw new Error('onboarding draft service is unavailable');
      return save(msg.draft);
    }
    case 'completeOnboarding': {
      try {
        const storage: PolicyStorage = requirePolicyStorage(policyStorage);
        const setup: SetupState = await storage.loadSetup();
        if (setup.completed) return onboardingDraftConflict(null, true);
        const load: (() => Promise<OnboardingDraftLoadResponse>) | undefined =
          requireOnboardingServices(onboardingServices).loadOnboardingDraft;
        if (load === undefined) throw new Error('onboarding draft service is unavailable');
        const loaded: OnboardingDraftLoadResponse = await load();
        if (!loaded.ok) return loaded;
        const draft: OnboardingDraft | null = loaded.draft;
        if (draft === null || draft.revision !== msg.revision) {
          return onboardingDraftConflict(draft, false);
        }
        if (draft.step !== 3) return { ok: false, error: 'Setup is not ready to finish.' };
        const selectedMode: StorageMode = draft.syncEnabled ? 'sync' : 'local';
        if (msg.storageMode !== selectedMode) {
          return {
            ok: false,
            error: 'Setup storage choice changed. Reload setup before finishing.',
          };
        }
        return await completeSetupPolicy(
          engine,
          storage,
          selectedMode,
          draft.settings,
          draft.lists,
          onboardingServices,
        );
      } catch (error: unknown) {
        return onboardingOperationalFailure(error);
      }
    }
    case 'reconcileWebsiteAccess': {
      const capability =
        await requireOnboardingServices(onboardingServices).reconcileWebsiteAccess();
      const granted: boolean = capability.permission === 'granted';
      if (capability.status === 'error') {
        if (capability.permission === 'unknown') {
          return {
            ok: false,
            error:
              'Focus Lock could not check website access. Retry setup or reload the extension.',
            registration: 'error',
          };
        }
        return {
          ok: false,
          error: granted
            ? 'Website access is granted, but Focus Lock could not enable blocking. Retry setup or reload the extension.'
            : 'Website access is unavailable, and Focus Lock could not finish blocking cleanup. Retry setup or reload the extension.',
          granted,
          registration: 'error',
        };
      }
      if (capability.permission === 'unknown') {
        return {
          ok: false,
          error: 'Focus Lock could not check website access. Retry setup or reload the extension.',
        };
      }
      if (
        (capability.permission === 'granted' && capability.status !== 'ready') ||
        (capability.permission === 'denied' && capability.status !== 'unavailable')
      ) {
        return {
          ok: false,
          error:
            'Focus Lock received an inconsistent website access state. Retry setup or reload the extension.',
        };
      }
      return { ok: true, granted, registration: capability.status };
    }
    case 'dismissWebsiteAccessNotice':
      if (requireOnboardingServices(onboardingServices).dismissWebsiteAccessNotice === undefined) {
        throw new Error('website access notice dismissal is unavailable');
      }
      await onboardingServices?.dismissWebsiteAccessNotice?.();
      return { ok: true };
    case 'completeSetup': {
      const storage: PolicyStorage = requirePolicyStorage(policyStorage);
      return completeSetupPolicy(
        engine,
        storage,
        msg.storageMode,
        msg.settings,
        msg.lists,
        onboardingServices,
      );
    }
    case 'setStorageMode': {
      const storage: PolicyStorage = requirePolicyStorage(policyStorage);
      if (msg.storageMode === 'sync') await storage.enableSync();
      else {
        await storage.selectLocalMode();
        if (msg.deleteRemote) await storage.deleteRemoteData('synced-policy');
      }
      return { ok: true };
    }
    case 'retrySync': {
      const storage: PolicyStorage = requirePolicyStorage(policyStorage);
      await storage.retrySync();
      const setup: SetupState = await storage.loadSetup();
      if (setup.storageMode !== 'sync' || setup.syncWriteStatus !== 'idle') {
        throw new Error('Chrome Sync retry did not complete durably');
      }
      return { ok: true, syncWriteStatus: 'idle' };
    }
    case 'clearFocusLockData': {
      const storage: PolicyStorage = requirePolicyStorage(policyStorage);
      if (msg.scope === 'local-history') {
        try {
          await engine.runWithLocalHistoryClear(
            (): Promise<boolean> => storage.clearLocalHistory(),
            (): Promise<void> => storage.finishLocalHistoryClear(),
          );
          return { ok: true, scope: msg.scope, status: 'cleared' };
        } catch (error: unknown) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            scope: msg.scope,
            status: 'pending',
          };
        }
      }
      if (msg.scope === 'synced-policy') {
        try {
          if ((await storage.storageMode()) !== 'local') {
            return {
              ok: false,
              error: 'Disable Sync before deleting synced data',
              scope: msg.scope,
              status: 'pending',
            };
          }
          await storage.deleteRemoteData(msg.scope);
          return { ok: true, scope: msg.scope, status: 'cleared' };
        } catch (error: unknown) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            scope: msg.scope,
            status: 'pending',
          };
        }
      }
      try {
        if ((await storage.storageMode()) === 'sync') await storage.selectLocalMode();
        // The creation seam opens the journal and runs the phases Policy Storage owns. Everything
        // after them, the browser reset and the finalization, belongs to Main's dispatcher.
        await storage.deleteRemoteData(msg.scope);
        await onboardingServices?.continueAllDataClear?.();
      } catch (error: unknown) {
        try {
          const setup: SetupState = await storage.loadSetup();
          const allDataClearPending: boolean =
            setup.dataClear.status !== 'idle' && setup.dataClear.scope === 'all';
          onboardingServices?.setupCompleted?.(setup.completed && !allDataClearPending);
        } catch (setupError: unknown) {
          onboardingServices?.reportError(setupError);
        }
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          scope: msg.scope,
          status: 'pending',
        };
      }
      onboardingServices?.setupCompleted?.(false);
      if (onboardingServices !== undefined) {
        try {
          await onboardingServices.reconcileWebsiteAccess();
        } catch (error: unknown) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            scope: msg.scope,
            status: 'cleared',
          };
        }
      }
      return { ok: true, scope: msg.scope, status: 'cleared' };
    }
    case 'getBlockState': {
      // The worker owns the target, so it is derived from the sender rather than trusted from the
      // message, and a document that cannot prove which page it is gets nothing to apply.
      const tabId: number | null = sender.tab?.id ?? null;
      const documentId: string | null = sender.documentId ?? null;
      if (sender.url !== msg.url || tabId === null || documentId === null) return { commands: [] };
      const target: { tabId: number; documentId: string; url: string } = {
        tabId,
        documentId,
        url: msg.url,
      };
      const kind: 'navigation' | 'existing' = msg.docState === 'fresh' ? 'navigation' : 'existing';
      // The controller records the blocked attempt on this path exactly as the v1 engine did.
      // The pull is the delivery: this answer is what the document applies, so it is the one call
      // that may hand over the epoch reset and record the acknowledgement for it.
      // The stopped claim is taken inside this call, before the view is frozen, so the page that
      // is stopped receives the sentence explaining it in the same answer.
      const commands: DocumentContentCommand[] = await engine.documentCommandsFor(
        target,
        kind,
        'deliver',
      );
      return { commands };
    }
    case 'startSession':
      return engine.startSession(msg.config);
    case 'openGate':
      return engine.openGate(msg.gate, msg.host);
    case 'openEndGate':
      return engine.openEndGate();
    case 'confirmGate':
      return engine.confirmGate(msg.typedPhrase);
    case 'requestSessionEnd':
      return engine.requestSessionEnd();
    case 'abandonGate':
      return engine.abandonGate();
    case 'resumeFromPause':
      return engine.resumeFromPause();
    case 'startNextFocusEarly':
      return engine.startNextFocusEarly();
    case 'retryTransitionCleanup':
      return engine.retryTransitionCleanup();
    case 'retryClosureCleanup':
      return engine.retryClosureCleanup();
    case 'retryDataClear': {
      const retry: (() => Promise<'ok' | 'retry-not-available'>) | undefined =
        onboardingServices?.retryDataClear;
      // A worker with no dispatcher bound has no clear to retry, which is the same answer an
      // unexhausted journal gets: there is nothing here for the button to begin.
      if (retry === undefined || (await retry()) === 'retry-not-available') {
        return {
          ok: false,
          code: 'retry-not-available',
          error: 'Data clear retry is not available.',
        };
      }
      return { ok: true, code: 'ok' };
    }
    case 'updateSettings':
      return engine.updateSettings(msg.settings);
    case 'updateTheme':
      return engine.updateTheme(msg.theme);
    case 'updateLists':
      return engine.updateLists(msg.lists);
    case 'getSettings':
      return engine.getSettings();
    case 'getLists':
      return engine.getLists();
    case 'getStats':
      return policyStorage === undefined
        ? fetchStats(msg.days, Date.now(), engine.statsOverlay())
        : policyStorage.withAggregateStorage((storage) =>
            fetchStats(msg.days, Date.now(), engine.statsOverlay(), storage),
          );
    case 'exportEvents':
      return { json: JSON.stringify(await readEventsV2(), null, 2) };
    case 'previewSound': {
      // Previews ignore the per-event toggle: the options page needs to
      // demo a sound the user is about to enable.
      const sounds: SoundSettings = engine.getSettings().sounds;
      await playSound(msg.sound, { ...sounds, [msg.sound]: true });
      return { ok: true };
    }
    default: {
      const exhaustive: never = msg;
      return { ok: false, error: `unhandled message ${JSON.stringify(exhaustive)}` };
    }
  }
}
