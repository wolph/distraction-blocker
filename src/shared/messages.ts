import type {
  DailyAgg,
  EventRecord,
  GateKind,
  ListsConfig,
  MonthlyAgg,
  OnboardingDraft,
  SessionConfig,
  SessionSnapshot,
  Settings,
  SetupState,
  StorageMode,
  StreakState,
  ThemeMode,
  Verdict,
} from './types';

export type SoundId = 'sessionComplete' | 'breakStart' | 'breakEnd' | 'scheduleStart';

export type Request =
  | { type: 'getSnapshot' }
  | { type: 'getSetupState' }
  | { type: 'openOnboarding' }
  | { type: 'getOnboardingDraft' }
  | { type: 'cleanupOnboardingDraft' }
  | { type: 'saveOnboardingDraft'; draft: OnboardingDraft }
  | { type: 'completeOnboarding'; revision: number; storageMode: StorageMode }
  | { type: 'reconcileWebsiteAccess' }
  | { type: 'dismissWebsiteAccessNotice' }
  | { type: 'completeSetup'; storageMode: StorageMode; settings: Settings; lists: ListsConfig }
  | { type: 'setStorageMode'; storageMode: StorageMode; deleteRemote: boolean }
  | {
      type: 'clearFocusLockData';
      scope: 'local-history' | 'synced-policy' | 'all';
    }
  /** docState fresh = document_start on a new navigation (worker records the tab as stopped when blocked), loaded = an already-rendered page */
  | { type: 'getBlockState'; url: string; docState: 'fresh' | 'loaded' }
  | { type: 'startSession'; config: SessionConfig }
  | { type: 'openGate'; gate: GateKind; host: string | null }
  | { type: 'confirmGate'; typedPhrase: string | null }
  | { type: 'requestSessionEnd' }
  | { type: 'forceEndGate' }
  | { type: 'abandonGate' }
  | { type: 'resumeFromPause' }
  | { type: 'startNextFocusEarly' }
  | { type: 'updateSettings'; settings: Settings }
  | { type: 'updateTheme'; theme: ThemeMode }
  | { type: 'updateLists'; lists: ListsConfig }
  | { type: 'getSettings' }
  | { type: 'getLists' }
  | { type: 'getStats'; days: number }
  | { type: 'exportEvents' }
  | { type: 'previewSound'; sound: SoundId };

export interface Rejection {
  ok: false;
  error: string;
}
export type Ack = { ok: true } | Rejection;

export type OnboardingOperationalFailure = Rejection & {
  conflict?: never;
  completed?: never;
  draft?: never;
};

export type OnboardingDraftLoadResponse =
  | { ok: true; draft: OnboardingDraft | null; invalid: boolean }
  | OnboardingOperationalFailure;

export type OnboardingDraftConflict = Rejection & {
  conflict: true;
  completed: boolean;
  draft: OnboardingDraft | null;
};

export type OnboardingDraftWriteResponse =
  | { ok: true; draft: OnboardingDraft }
  | OnboardingOperationalFailure
  | OnboardingDraftConflict;

export type OnboardingCleanupResponse = { ok: true } | OnboardingOperationalFailure;
export type OnboardingCompletionResponse =
  | { ok: true }
  | OnboardingDraftConflict
  | OnboardingOperationalFailure;

export type WebsiteAccessReconciliation =
  | { ok: true; granted: true; registration: 'ready' }
  | { ok: true; granted: false; registration: 'unavailable' }
  | (Rejection & { granted?: never; registration?: never })
  | (Rejection & { granted: boolean; registration: 'error' })
  | (Rejection & { granted?: never; registration: 'error' });

export type ClearFocusLockDataResponse =
  | {
      ok: true;
      scope: 'local-history' | 'synced-policy' | 'all';
      status: 'cleared';
    }
  | (Rejection & {
      scope: 'local-history' | 'synced-policy' | 'all';
      status: 'pending' | 'cleared';
    });

export interface StatsBundle {
  /** merged across devices, oldest first */
  days: DailyAgg[];
  months: MonthlyAgg[];
  streak: StreakState;
  /** local machine only, newest first, events for at most 50 session rows */
  recentSessions: EventRecord[];
  totals: {
    focusMsToday: number;
    focusMsWeek: number;
    attemptsToday: number;
    resistedToday: number;
  };
}

export interface ResponseMap {
  getSnapshot: SessionSnapshot;
  getSetupState: SetupState;
  openOnboarding: Ack;
  getOnboardingDraft: OnboardingDraftLoadResponse;
  cleanupOnboardingDraft: OnboardingCleanupResponse;
  saveOnboardingDraft: OnboardingDraftWriteResponse;
  completeOnboarding: OnboardingCompletionResponse;
  reconcileWebsiteAccess: WebsiteAccessReconciliation;
  dismissWebsiteAccessNotice: Ack;
  completeSetup: Ack;
  setStorageMode: Ack;
  clearFocusLockData: ClearFocusLockDataResponse;
  getBlockState: { verdict: Verdict; snapshot: SessionSnapshot };
  startSession: Ack;
  openGate: Ack;
  confirmGate: Ack;
  requestSessionEnd: Ack;
  forceEndGate: Ack;
  abandonGate: Ack;
  resumeFromPause: Ack;
  startNextFocusEarly: Ack;
  updateSettings: Ack;
  updateTheme: Ack;
  updateLists: Ack;
  getSettings: Settings;
  getLists: ListsConfig;
  getStats: StatsBundle;
  exportEvents: { json: string };
  previewSound: Ack;
}

export type Broadcast =
  | { type: 'stateChanged'; snapshot: SessionSnapshot }
  /** content scripts must re-run getBlockState with their current URL */
  | { type: 'reevaluate' };

/** Worker-to-content-script push commands, sent via chrome.tabs.sendMessage. */
export type ContentCommand =
  | { type: 'applyBlock'; verdict: Verdict; snapshot: SessionSnapshot }
  | { type: 'clearBlock'; snapshot: SessionSnapshot }
  | { type: 'reevaluate' };

export async function sendRequest<T extends Request['type']>(
  req: Extract<Request, { type: T }>,
): Promise<ResponseMap[T]> {
  return (await chrome.runtime.sendMessage(req)) as ResponseMap[T];
}
