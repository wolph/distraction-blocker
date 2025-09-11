import { normalizeSessionHostInput } from '../core/matcher';
import { CATEGORY_IDS, rulesFromLists } from '../shared/constants';
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

export interface DraftUpdate<T = SessionDraft> {
  draft: T;
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

export function toggleDraftCategory<const T extends { rules: SessionRuleSnapshot }>(
  draft: T,
  id: CategoryId,
): T {
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

export function rebaseSessionDraft<const T extends { rules: SessionRuleSnapshot }>(
  draft: T,
  lists: ListsConfig,
): T {
  const baseline: SessionRuleSnapshot = rulesFromLists(lists);
  const categories: Record<CategoryId, boolean> = { ...baseline.categories };
  for (const id of CATEGORY_IDS) {
    if (draft.rules.categories[id] !== draft.rules.baselineCategories[id]) {
      categories[id] = draft.rules.categories[id];
    }
  }
  return {
    ...draft,
    rules: {
      ...baseline,
      categories,
      sessionBlacklist: structuredClone(draft.rules.sessionBlacklist),
      sessionAllowlist: structuredClone(draft.rules.sessionAllowlist),
    },
  };
}

export function addDraftAllowHost<const T extends { rules: SessionRuleSnapshot }>(
  draft: T,
  raw: string,
): DraftUpdate<T> {
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
