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

/**
 * What the runtime keeps of an epoch reset acknowledgement. Every reader of `epochResetAcks` asks
 * one question, whether this document acknowledged this epoch, so the record is the document and
 * the epoch. The page address the transport's acknowledgement echoes stays out of it: a record is
 * kept for as long as its tab is open, in and between sessions, and an address kept that long is
 * browsing history the runtime has no use for.
 */
export interface EpochResetAckRecord {
  version: 1;
  operationId: string;
  enforcementEpoch: string;
  tabId: number;
  documentId: string;
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
