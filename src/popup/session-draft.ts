import { normalizeSessionHostInput } from '../core/matcher';
import { rulesFromLists } from '../shared/constants';
import type {
  CategoryId,
  CycleConfig,
  ListsConfig,
  SessionConfig,
  SessionMode,
  SessionRuleSnapshot,
  Settings,
  Strictness,
} from '../shared/types';

export interface SessionDraft {
  mode: SessionMode;
  strictness: Strictness;
  frictionGate: {
    delayMs: number;
    requireTypedPhrase: boolean;
  };
  durationMin: number;
  cycling: CycleConfig | null;
  intention: string;
  rules: SessionRuleSnapshot;
}

export interface DraftUpdate {
  draft: SessionDraft;
  error: string | null;
}

export function createSessionDraft(settings: Settings, lists: ListsConfig): SessionDraft {
  return {
    mode: settings.defaultMode,
    strictness: settings.defaultStrictness,
    frictionGate: {
      delayMs: settings.gate.delayMs,
      requireTypedPhrase: settings.gate.requireTypedPhrase,
    },
    durationMin: settings.presetsMin[1],
    cycling: settings.cyclingOnByDefault ? structuredClone(settings.defaultCycling) : null,
    intention: '',
    rules: rulesFromLists(lists),
  };
}

export function toggleDraftCategory(draft: SessionDraft, id: CategoryId): SessionDraft {
  return {
    ...draft,
    rules: {
      ...draft.rules,
      categories: {
        ...draft.rules.categories,
        [id]: !draft.rules.categories[id],
      },
    },
  };
}

export function addDraftAllowHost(draft: SessionDraft, raw: string): DraftUpdate {
  const host: string | null = normalizeSessionHostInput(raw);
  if (host === null) {
    return {
      draft,
      error: 'Enter a valid domain such as docs.example.com.',
    };
  }

  const alreadyAllowed: boolean = [
    ...draft.rules.permanentAllowlist,
    ...draft.rules.sessionAllowlist,
  ]
    .filter((rule): rule is { kind: 'host'; pattern: string } => rule.kind === 'host')
    .some((rule: { kind: 'host'; pattern: string }): boolean => rule.pattern === host);
  if (alreadyAllowed) return { draft, error: null };

  return {
    draft: {
      ...draft,
      rules: {
        ...draft.rules,
        sessionAllowlist: [...draft.rules.sessionAllowlist, { kind: 'host', pattern: host }],
      },
    },
    error: null,
  };
}

export function toSessionConfig(draft: SessionDraft): SessionConfig {
  return {
    mode: draft.mode,
    strictness: draft.strictness,
    durationMin: draft.durationMin,
    cycling: draft.cycling === null ? null : structuredClone(draft.cycling),
    intention: draft.intention.trim(),
    source: 'manual',
    scheduleEntryId: null,
    rules: structuredClone(draft.rules),
  };
}
