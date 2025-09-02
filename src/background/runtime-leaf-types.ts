export interface DeferredBlockClaim {
  attemptAt: number;
  documentId?: string;
  kind: 'navigation' | 'existing';
  sessionId: string;
  stage: 'attempt' | 'stopped';
  tabId: number;
  url: string;
}

export interface RuntimeTabState {
  muteUrl: string | null;
  priorMuted: boolean | null;
  stoppedDocumentId: string | null;
}
