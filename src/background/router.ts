import type { Ack, Request } from '../shared/messages';
import type {
  BlockingRegistrationStatus,
  SessionSnapshot,
  SetupState,
  SoundSettings,
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
  removeOnboardingDraft(): Promise<void>;
  reportError(error: unknown): void;
  setupCompleted?(completed: boolean): void;
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
    case 'reconcileWebsiteAccess': {
      const capability =
        await requireOnboardingServices(onboardingServices).reconcileWebsiteAccess();
      const granted: boolean = capability.permission === 'granted';
      if (granted && capability.status === 'error') {
        return {
          ok: false,
          error:
            'Website access is granted, but Focus Lock could not enable blocking. Retry setup or reload the extension.',
          granted,
          registration: capability.status,
        };
      }
      if (capability.permission === 'unknown') {
        return {
          ok: false,
          error: 'Focus Lock could not check website access. Retry setup or reload the extension.',
          registration: capability.status,
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
      if (msg.storageMode === 'local') await storage.selectLocalMode();
      const settingsResult: Ack = await engine.updateSettings(msg.settings);
      if (!settingsResult.ok) return settingsResult;
      const listsResult: Ack = await engine.updateLists(msg.lists);
      if (!listsResult.ok) return listsResult;
      if (msg.storageMode === 'sync') await storage.enableSync();
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
      const duringTransition = (): { verdict: Verdict; snapshot: SessionSnapshot } | null =>
        engine.blockStateDuringTransition?.(
          msg.url,
          tabId,
          senderOwnsUrl,
          kind,
          sender.documentId,
        ) ?? null;
      const initialTransitionState = duringTransition();
      if (initialTransitionState !== null) return initialTransitionState;
      const verdict: Verdict = engine.verdictFor(msg.url);
      if (verdict.blocked && tabId !== undefined && senderOwnsUrl) {
        await engine.recordAttempt(msg.url, tabId, kind);
        const admittedTransitionState = duringTransition();
        if (admittedTransitionState !== null) return admittedTransitionState;
        if (msg.docState === 'fresh' && sender.documentId !== undefined) {
          await engine.markStopped(tabId, msg.url, sender.documentId);
        }
      }
      const finalTransitionState = duringTransition();
      if (finalTransitionState !== null) return finalTransitionState;
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
    case 'forceEndGate':
      return {
        ok: false,
        error: 'Force end is no longer available. Choose a Flexible session before starting.',
      };
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
