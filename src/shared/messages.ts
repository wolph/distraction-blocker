import type {
  DailyAgg,
  EventRecord,
  GateKind,
  ListsConfig,
  MonthlyAgg,
  SessionConfig,
  SessionSnapshot,
  Settings,
  StreakState,
  ThemeMode,
  Verdict,
} from './types';

import type { WorkTabsResult, WorkTargetResult } from './work-target';

export type SoundId = 'sessionComplete' | 'breakStart' | 'breakEnd' | 'scheduleStart';

export type Request =
  | { type: 'getSnapshot' }
  /** docState fresh = document_start on a new navigation (worker records the tab as stopped when blocked), loaded = an already-rendered page */
  | { type: 'getBlockState'; url: string; docState: 'fresh' | 'loaded' }
  | { type: 'startSession'; config: SessionConfig; workTabId?: number; windowId?: number }
  | { type: 'getWorkTabs'; mode: SessionConfig['mode']; windowId: number }
  | { type: 'getWorkTarget'; windowId?: number }
  | { type: 'setWorkTarget'; sessionId: string; tabId: number; windowId: number }
  | { type: 'returnToWork'; sessionId: string; windowId?: number }
  | { type: 'openGate'; gate: GateKind; host: string | null }
  | { type: 'confirmGate'; typedPhrase: string | null }
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

export type StartSessionResult = Ack | (Rejection & { sessionStarted: true });

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
  getBlockState: { verdict: Verdict; snapshot: SessionSnapshot };
  startSession: StartSessionResult;
  getWorkTabs: WorkTabsResult;
  getWorkTarget: WorkTargetResult;
  setWorkTarget: Ack;
  returnToWork: Ack;
  openGate: Ack;
  confirmGate: Ack;
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
  | { type: 'workTargetChanged' }
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
