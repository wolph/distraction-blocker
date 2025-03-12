import { SYNC_QUOTA_BYTES_PER_ITEM, SyncQuotaError } from './sync-quota-shared';

function serializeChromiumDouble(value: number): string {
  // Chromium and JavaScript produce the same shortest digits. Chromium uses
  // exponential notation outside [-6, 12), while JavaScript's upper bound is 21.
  const exponential: string = value.toExponential();
  const exponentMarker: number = exponential.lastIndexOf('e');
  const exponent: number = Number(exponential.slice(exponentMarker + 1));
  const token: string = exponent >= -6 && exponent < 12 ? value.toString() : exponential;
  return token.includes('.') || token.includes('e') || token.includes('E') ? token : `${token}.0`;
}

function serializeChromiumNumberTokens(serialized: string): string {
  let output: string = '';
  let index: number = 0;
  let inString: boolean = false;
  while (index < serialized.length) {
    const character: string = serialized[index] as string;
    if (inString && character === '\\') {
      output += serialized.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      output += character;
      index += 1;
      continue;
    }
    const isNumberStart: boolean =
      !inString && (character === '-' || (character >= '0' && character <= '9'));
    if (!isNumberStart) {
      output += character;
      index += 1;
      continue;
    }
    const match: RegExpMatchArray | null = serialized
      .slice(index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (match === null) throw new SyncQuotaError('Cannot sync value: invalid JSON number.');
    const token: string = match[0] as string;
    const number: number = Number(token);
    const isInt32: boolean =
      Number.isInteger(number) && number >= -2_147_483_648 && number <= 2_147_483_647;
    output += isInt32 ? token : serializeChromiumDouble(number);
    index += token.length;
  }
  return output;
}

export function serializeSyncValue(key: string, value: unknown): string {
  try {
    const serialized: string | undefined = JSON.stringify(value);
    if (serialized !== undefined) {
      return serializeChromiumNumberTokens(serialized)
        .replaceAll('<', '\\u003C')
        .replaceAll('\u2028', '\\u2028')
        .replaceAll('\u2029', '\\u2029');
    }
  } catch (_error: unknown) {
    // Normalize JSON.stringify failures into one stable boundary error.
  }
  throw new SyncQuotaError(
    `Cannot sync item ${JSON.stringify(key)}: value cannot be serialized as JSON.`,
  );
}

export function syncItemBytes(key: string, value: unknown): number {
  const serialized: string = serializeSyncValue(key, value);
  const encoder: TextEncoder = new TextEncoder();
  return encoder.encode(key).byteLength + encoder.encode(serialized).byteLength;
}

export function assertSyncItemWithinQuota(key: string, value: unknown): void {
  const bytes: number = syncItemBytes(key, value);
  if (bytes <= SYNC_QUOTA_BYTES_PER_ITEM) return;
  throw new SyncQuotaError(
    `Cannot sync item ${JSON.stringify(key)}: ${bytes} bytes exceeds the ${SYNC_QUOTA_BYTES_PER_ITEM}-byte limit.`,
  );
}
