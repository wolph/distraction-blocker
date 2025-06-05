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
  SessionSnapshot,
  Settings,
  SetupState,
  SoundSettings,
  StorageMode,
  Verdict,
} from '../shared/types';
import { playSound } from './audio';
import type { Engine } from './engine';
import type { PolicyStorage } from './policy-storage';
import { fetchStats } from './stats-service';
import { readEvents } from './stores';

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
      return engine.snapshotPersisted();
    case 'getSetupState':
      return requirePolicyStorage(policyStorage).loadSetup();
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
        await storage.deleteRemoteData(msg.scope);
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
      const tabId: number | undefined = sender.tab?.id;
      const senderOwnsUrl: boolean = sender.url === msg.url && sender.tab?.url === msg.url;
      const kind: 'navigation' | 'existing' = msg.docState === 'fresh' ? 'navigation' : 'existing';
      const duringTransition = (
        stage: 'attempt' | 'stopped' | null,
      ): Promise<{ verdict: Verdict; snapshot: SessionSnapshot }> | null =>
        engine.blockStateDuringTransition?.(
          msg.url,
          tabId,
          senderOwnsUrl,
          kind,
          stage,
          sender.documentId,
        ) ?? null;
      const initialTransitionState = duringTransition('attempt');
      if (initialTransitionState !== null) return await initialTransitionState;
      const verdict: Verdict = engine.verdictFor(msg.url);
      if (verdict.blocked && tabId !== undefined && senderOwnsUrl) {
        await engine.recordAttempt(msg.url, tabId, kind);
        const remainingStage: 'stopped' | null =
          msg.docState === 'fresh' &&
          typeof sender.documentId === 'string' &&
          sender.documentId !== ''
            ? 'stopped'
            : null;
        const admittedTransitionState = duringTransition(remainingStage);
        if (admittedTransitionState !== null) return await admittedTransitionState;
        if (msg.docState === 'fresh' && sender.documentId !== undefined) {
          await engine.markStopped(tabId, msg.url, sender.documentId);
        }
      }
      const finalTransitionState = duringTransition(null);
      if (finalTransitionState !== null) return await finalTransitionState;
      return { verdict, snapshot: await engine.snapshotPersisted() };
    }
    case 'startSession':
      return engine.startSession(msg.config);
    case 'openGate':
      return engine.openGate(msg.gate, msg.host);
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
      return { json: JSON.stringify(await readEvents(), null, 2) };
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
