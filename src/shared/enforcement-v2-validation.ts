import { CATEGORY_IDS } from './constants';
import type {
  ActiveOverlayCopy,
  DocumentEnforcementCommand,
  DocumentOverlayView,
  EnforcementPresentation,
  StartingOverlayCopy,
} from './enforcement-v2';
import { exactDataEqual, snapshotExactData } from './exact-data';
import { isRelativeMillisecondDuration } from './numeric-validation';
import type { SessionDuration, Strictness, ThemeMode, Verdict } from './types';
import {
  validateDetachedGateState,
  validateDetachedSessionDuration,
  validateDetachedSiteUnlock,
} from './v2-domain-intrinsics';

type UnknownRecord = Record<string, unknown>;

const STARTING_OVERLAY_KEYS: readonly string[] = [
  'version',
  'presentation',
  'capturedAt',
  'theme',
  'stoppedPage',
  'copy',
  'actions',
];
const STARTING_COPY_KEYS: readonly string[] = [
  'title',
  'detail',
  'verdictProvenance',
  'stoppedPage',
];
const ACTIVE_OVERLAY_KEYS: readonly string[] = [
  'version',
  'presentation',
  'theme',
  'sessionId',
  'phase',
  'mode',
  'strictness',
  'duration',
  'timing',
  'economy',
  'gate',
  'activeUnlocks',
  'attemptsToday',
  'stoppedPage',
  'actions',
  'copy',
];
const ACTIVE_TIMING_KEYS: readonly string[] = [
  'capturedAt',
  'phaseStartedAt',
  'phaseEndsAt',
  'sessionEndsAt',
];
const ACTIVE_ECONOMY_KEYS: readonly string[] = [
  'bankMs',
  'bankAccrualPerMs',
  'bankCapMs',
  'pauseCostMs',
  'unlockCostMs',
];
const ACTIVE_ACTION_KEYS: readonly string[] = ['state', 'end', 'pause', 'unlock'];
const ACTIVE_COPY_KEYS: readonly string[] = [
  'status',
  'lockedUntil',
  'intention',
  'attempts',
  'verdictProvenance',
  'stoppedPage',
  'bankUnit',
  'pauseAction',
  'unlockAction',
  'endAction',
  'bankWaitFallback',
  'bankWaitPrefix',
  'gateTitle',
  'gateBack',
  'gatePhraseLabel',
  'gateConfirm',
  'transportError',
];
const STATUS_COPY_KEYS: readonly string[] = ['kind', 'text'];
const VERDICT_KEYS: readonly string[] = ['blocked', 'reason', 'categoryId', 'matchedPattern'];
const COMMAND_KEYS: readonly string[] = [
  'version',
  'command',
  'operationId',
  'enforcementEpoch',
  'sessionId',
  'reservedSessionId',
  'basePolicyRevision',
  'runtimeRevision',
  'documentId',
  'expectedUrl',
  'presentation',
  'verdict',
  'overlay',
];
const STARTING_TITLE: StartingOverlayCopy['title'] = 'Focus Lock is starting';
const STARTING_DETAIL: StartingOverlayCopy['detail'] = 'Applying your selected rules.';
const STOPPED_PAGE_COPY: NonNullable<StartingOverlayCopy['stoppedPage']> =
  'This page did not load. It will load by itself when the session ends.';
const UNTIL_STOPPED_STATUS_TEXT: Extract<
  ActiveOverlayCopy['status'],
  { kind: 'until-stopped' }
>['text'] = 'Focus Lock is active until you end it from the popup.';
const FIXED_ACTIVE_COPY: Readonly<
  Pick<
    ActiveOverlayCopy,
    | 'bankUnit'
    | 'endAction'
    | 'bankWaitFallback'
    | 'bankWaitPrefix'
    | 'gateBack'
    | 'gatePhraseLabel'
    | 'transportError'
  >
> = {
  bankUnit: 'pause banked',
  endAction: 'End session',
  bankWaitFallback: 'earn pause time by focusing',
  bankWaitPrefix: 'ready in',
  gateBack: 'Never mind, back to work',
  gatePhraseLabel: 'Type this to confirm:',
  transportError: 'Focus Lock could not update this action. Try again.',
};
const CANONICAL_CLEAR_VERDICT: Verdict = {
  blocked: false,
  reason: 'no-session',
  categoryId: null,
  matchedPattern: null,
};
const VERDICT_REASONS: ReadonlySet<string> = new Set<string>([
  'no-session',
  'always-allow',
  'unlock',
  'excluded',
  'category',
  'custom',
  'whitelist',
  'whitelist-miss',
  'default',
]);
const CATEGORY_ID_VALUES: ReadonlySet<string> = new Set<string>(CATEGORY_IDS);
const UUID_RE: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseDocumentOverlayView(value: unknown): DocumentOverlayView | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedDocumentOverlayView(snapshot) ? snapshot : null;
}

export function parseDocumentEnforcementCommand(value: unknown): DocumentEnforcementCommand | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedDocumentEnforcementCommand(snapshot) ? snapshot : null;
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedDocumentOverlayView(value: unknown): value is DocumentOverlayView {
  const starting: UnknownRecord | null = exactRecord(value, STARTING_OVERLAY_KEYS);
  if (starting !== null) return validateDetachedStartingOverlay(starting);
  const active: UnknownRecord | null = exactRecord(value, ACTIVE_OVERLAY_KEYS);
  return active !== null && validateDetachedActiveOverlay(active);
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedVerdict(value: unknown): value is Verdict {
  const candidate: UnknownRecord | null = exactRecord(value, VERDICT_KEYS);
  return (
    candidate !== null &&
    typeof candidate.blocked === 'boolean' &&
    typeof candidate.reason === 'string' &&
    VERDICT_REASONS.has(candidate.reason) &&
    (candidate.categoryId === null ||
      (typeof candidate.categoryId === 'string' && CATEGORY_ID_VALUES.has(candidate.categoryId))) &&
    (candidate.matchedPattern === null || typeof candidate.matchedPattern === 'string')
  );
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedDocumentEnforcementCommand(
  value: unknown,
): value is DocumentEnforcementCommand {
  const candidate: UnknownRecord | null = exactRecord(value, COMMAND_KEYS);
  return candidate !== null && validateDetachedDocumentEnforcementCommandFields(candidate);
}

/**
 * Validates command fields on an already-detached record whose root key set the caller owns,
 * such as a background frozen command that adds its own worker-owned keys.
 */
export function validateDetachedDocumentEnforcementCommandFields(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const verdict: unknown = value.verdict;
  if (
    value.version !== 1 ||
    value.command !== 'apply-enforcement' ||
    !isUuid(value.operationId) ||
    !isUuid(value.enforcementEpoch) ||
    !hasSingleSessionIdentity(value.sessionId, value.reservedSessionId) ||
    !isNonNegativeInteger(value.basePolicyRevision) ||
    !isNonNegativeInteger(value.runtimeRevision) ||
    !isNonBlankString(value.documentId) ||
    !isNonBlankString(value.expectedUrl) ||
    !isEnforcementPresentation(value.presentation) ||
    !validateDetachedVerdict(verdict)
  ) {
    return false;
  }
  return validateDetachedCommandPresentation(
    value.presentation,
    verdict,
    value.overlay,
    value.sessionId,
  );
}

function validateDetachedCommandPresentation(
  presentation: EnforcementPresentation,
  verdict: Verdict,
  overlay: unknown,
  sessionId: unknown,
): boolean {
  if (presentation === 'clear') {
    return overlay === null && exactDataEqual(verdict, CANONICAL_CLEAR_VERDICT);
  }
  if (!verdict.blocked) return overlay === null;
  if (!validateDetachedDocumentOverlayView(overlay) || overlay.presentation !== presentation) {
    return false;
  }
  return overlay.presentation === 'starting' || overlay.sessionId === sessionId;
}

function hasSingleSessionIdentity(sessionId: unknown, reservedSessionId: unknown): boolean {
  return sessionId === null
    ? isUuid(reservedSessionId)
    : isUuid(sessionId) && reservedSessionId === null;
}

function validateDetachedStartingOverlay(value: UnknownRecord): boolean {
  const copy: UnknownRecord | null = exactRecord(value.copy, STARTING_COPY_KEYS);
  const actions: UnknownRecord | null = exactRecord(value.actions, ['end']);
  return (
    value.version === 1 &&
    value.presentation === 'starting' &&
    isSafeTimestamp(value.capturedAt) &&
    isThemeMode(value.theme) &&
    typeof value.stoppedPage === 'boolean' &&
    copy !== null &&
    copy.title === STARTING_TITLE &&
    copy.detail === STARTING_DETAIL &&
    isNonBlankString(copy.verdictProvenance) &&
    hasStoppedPageCopy(value.stoppedPage, copy.stoppedPage) &&
    actions !== null &&
    actions.end === 'hidden'
  );
}

function validateDetachedActiveOverlay(value: UnknownRecord): boolean {
  const duration: unknown = value.duration;
  const strictness: unknown = value.strictness;
  const stoppedPage: unknown = value.stoppedPage;
  if (
    value.version !== 1 ||
    value.presentation !== 'active' ||
    !isThemeMode(value.theme) ||
    !isUuid(value.sessionId) ||
    value.phase !== 'focus' ||
    (value.mode !== 'blacklist' && value.mode !== 'whitelist') ||
    !isStrictness(strictness) ||
    !validateDetachedSessionDuration(duration) ||
    !hasDurationCompatibleStrictness(duration, strictness) ||
    !isNonNegativeInteger(value.attemptsToday) ||
    typeof stoppedPage !== 'boolean'
  ) {
    return false;
  }

  const timing: UnknownRecord | null = exactRecord(value.timing, ACTIVE_TIMING_KEYS);
  const capturedAt: number | null =
    timing === null ? null : activeTimingCapturedAt(timing, duration);
  if (capturedAt === null) return false;

  const gate: unknown = value.gate;
  if (gate !== null) {
    if (!validateDetachedGateState(gate) || gate.openedAt > capturedAt) return false;
  }

  const gated: boolean = gate !== null;
  return (
    validateDetachedActiveEconomy(value.economy) &&
    validateDetachedActiveUnlocks(value.activeUnlocks, capturedAt) &&
    validateDetachedActiveActions(
      value.actions,
      gated,
      expectedEndAction(duration, strictness, gated),
    ) &&
    validateDetachedActiveCopy(value.copy, duration, gated, stoppedPage)
  );
}

/** Until-stopped sessions are Flexible only, matching the SessionConfigV2 duration invariant. */
function hasDurationCompatibleStrictness(
  duration: SessionDuration,
  strictness: Strictness,
): boolean {
  return duration.kind === 'timed' || strictness === 'flexible';
}

function expectedEndAction(
  duration: SessionDuration,
  strictness: Strictness,
  gated: boolean,
): 'hidden' | 'request-end' {
  if (gated || duration.kind === 'until-stopped' || strictness === 'hard') return 'hidden';
  return 'request-end';
}

/** Returns capturedAt when the whole active timing row is valid, otherwise null. */
function activeTimingCapturedAt(timing: UnknownRecord, duration: SessionDuration): number | null {
  const capturedAt: unknown = timing.capturedAt;
  const phaseStartedAt: unknown = timing.phaseStartedAt;
  if (
    !isSafeTimestamp(capturedAt) ||
    !isSafeTimestamp(phaseStartedAt) ||
    phaseStartedAt > capturedAt
  ) {
    return null;
  }
  if (duration.kind === 'until-stopped') {
    return timing.phaseEndsAt === null && timing.sessionEndsAt === null ? capturedAt : null;
  }
  const phaseEndsAt: unknown = timing.phaseEndsAt;
  const sessionEndsAt: unknown = timing.sessionEndsAt;
  if (!isSafeTimestamp(phaseEndsAt) || !isSafeTimestamp(sessionEndsAt)) return null;
  return capturedAt < phaseEndsAt && phaseEndsAt <= sessionEndsAt ? capturedAt : null;
}

function validateDetachedActiveEconomy(value: unknown): boolean {
  const economy: UnknownRecord | null = exactRecord(value, ACTIVE_ECONOMY_KEYS);
  if (economy === null) return false;
  const bankMs: unknown = economy.bankMs;
  const bankCapMs: unknown = economy.bankCapMs;
  return (
    isFiniteNonNegativeNumber(bankMs) &&
    isFiniteNonNegativeNumber(economy.bankAccrualPerMs) &&
    isNonNegativeInteger(bankCapMs) &&
    bankMs <= bankCapMs &&
    isRelativeMillisecondDuration(economy.pauseCostMs, true) &&
    isRelativeMillisecondDuration(economy.unlockCostMs, true)
  );
}

function validateDetachedActiveUnlocks(value: unknown, capturedAt: number): boolean {
  if (!isDenseArray(value)) return false;
  return value.every(
    (unlock: unknown): boolean => validateDetachedSiteUnlock(unlock) && unlock.until > capturedAt,
  );
}

function validateDetachedActiveActions(
  value: unknown,
  gated: boolean,
  end: 'hidden' | 'request-end',
): boolean {
  const actions: UnknownRecord | null = exactRecord(value, ACTIVE_ACTION_KEYS);
  if (actions === null || actions.end !== end) return false;
  return gated
    ? actions.state === 'gate' && actions.pause === 'hidden' && actions.unlock === 'hidden'
    : actions.state === 'ready' &&
        actions.pause === 'request-gate' &&
        actions.unlock === 'request-gate';
}

function validateDetachedActiveCopy(
  value: unknown,
  duration: SessionDuration,
  gated: boolean,
  stoppedPage: boolean,
): boolean {
  const copy: UnknownRecord | null = exactRecord(value, ACTIVE_COPY_KEYS);
  if (
    copy === null ||
    !hasFixedActiveCopy(copy) ||
    !isNonBlankString(copy.attempts) ||
    !isNonBlankString(copy.pauseAction) ||
    !isNonBlankString(copy.unlockAction) ||
    !isNonBlankString(copy.verdictProvenance) ||
    !isNullableNonBlankString(copy.intention) ||
    !hasStoppedPageCopy(stoppedPage, copy.stoppedPage)
  ) {
    return false;
  }
  if (!validateDetachedStatusCopy(copy.status, copy.lockedUntil, duration)) return false;
  return gated
    ? isNonBlankString(copy.gateTitle) && isNonBlankString(copy.gateConfirm)
    : copy.gateTitle === null && copy.gateConfirm === null;
}

function hasFixedActiveCopy(copy: UnknownRecord): boolean {
  return Object.entries(FIXED_ACTIVE_COPY).every(
    ([key, text]: [string, string]): boolean => copy[key] === text,
  );
}

function validateDetachedStatusCopy(
  value: unknown,
  lockedUntil: unknown,
  duration: SessionDuration,
): boolean {
  const status: UnknownRecord | null = exactRecord(value, STATUS_COPY_KEYS);
  if (status === null) return false;
  if (duration.kind === 'until-stopped') {
    return (
      status.kind === 'until-stopped' &&
      status.text === UNTIL_STOPPED_STATUS_TEXT &&
      lockedUntil === null
    );
  }
  return status.kind === 'timed' && isNonBlankString(status.text) && isNonBlankString(lockedUntil);
}

function hasStoppedPageCopy(stoppedPage: boolean, copy: unknown): boolean {
  return stoppedPage ? copy === STOPPED_PAGE_COPY : copy === null;
}

function exactRecord(value: unknown, keys: readonly string[]): UnknownRecord | null {
  return isRecord(value) && hasExactKeys(value, keys) ? value : null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual: PropertyKey[] = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key: PropertyKey): boolean => typeof key === 'string' && keys.includes(key))
  );
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index: number = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function isEnforcementPresentation(value: unknown): value is EnforcementPresentation {
  return value === 'starting' || value === 'active' || value === 'clear';
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'auto' || value === 'light' || value === 'dark';
}

function isStrictness(value: unknown): value is Strictness {
  return value === 'flexible' || value === 'friction' || value === 'hard';
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isSafeTimestamp(value: unknown): value is number {
  return isNonNegativeInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && /\S/.test(value);
}

function isNullableNonBlankString(value: unknown): value is string | null {
  return value === null || isNonBlankString(value);
}
