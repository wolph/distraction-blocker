import type {
  DocumentEnforcementCommand,
  ResetEnforcementEpochCommand,
} from '../shared/enforcement-v2';
import type { Verdict } from '../shared/types';

export interface FrozenDocumentCommand extends DocumentEnforcementCommand {
  tabId: number;
}

export interface FrozenEpochResetCommand extends ResetEnforcementEpochCommand {
  tabId: number;
}

export interface DocumentEnforcementAck {
  version: 1;
  operationId: string;
  enforcementEpoch: string;
  sessionId: string | null;
  reservedSessionId: string | null;
  basePolicyRevision: number;
  runtimeRevision: number;
  tabId: number;
  documentId: string;
  url: string;
  verdict: Verdict;
  handledAt: number;
}

export interface DocumentEpochResetAck {
  version: 1;
  operationId: string;
  enforcementEpoch: string;
  tabId: number;
  documentId: string;
  url: string;
  handledAt: number;
}

export interface EnforcementTargetExclusion {
  tabId: number;
  documentId: string | null;
  url: string;
  reason: 'known-unsupported';
}

export interface EnforcementCheckpoint {
  version: 1;
  operationId: string;
  enforcementEpoch: string;
  sessionId: string;
  basePolicyRevision: number;
  kind: 'activation' | 'recovery' | 'resume-strengthening';
  registrationAuditedAt: number;
  completedAt: number;
  targetGeneration: number;
  documents: DocumentEnforcementAck[];
  exclusions: EnforcementTargetExclusion[];
}
