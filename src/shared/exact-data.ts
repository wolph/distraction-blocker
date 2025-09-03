type UnknownRecord = Record<string, unknown>;

const MAX_EXACT_DATA_DEPTH: number = 128;

export interface ExactDataSnapshot {
  value: unknown;
}

interface ExactDataContext {
  snapshots: WeakMap<object, object>;
  visiting: WeakSet<object>;
}

interface ExactValueContext {
  pairs: WeakMap<object, WeakSet<object>>;
}

export function snapshotExactData(value: unknown): ExactDataSnapshot | null {
  try {
    return snapshotExactDataAtDepth(value, newExactDataContext(), 0);
  } catch {
    return null;
  }
}

export function exactDataEqual(left: unknown, right: unknown): boolean {
  try {
    return exactValueEqual(left, right, {
      pairs: new WeakMap<object, WeakSet<object>>(),
    });
  } catch {
    return false;
  }
}

function snapshotExactDataAtDepth(
  value: unknown,
  context: ExactDataContext,
  depth: number,
): ExactDataSnapshot | null {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' ? null : { value };
  }
  if (depth > MAX_EXACT_DATA_DEPTH || context.visiting.has(value)) return null;
  const existing: object | undefined = context.snapshots.get(value);
  if (existing !== undefined) return { value: existing };

  const array: boolean = Array.isArray(value);
  if (!hasExactDataPrototype(value, array)) return null;
  const ownKeys: PropertyKey[] = Reflect.ownKeys(value);
  if (ownKeys.some((key: PropertyKey): boolean => typeof key !== 'string')) return null;
  return detachOwnDataObject(value, array, ownKeys, context, depth);
}

function newExactDataContext(): ExactDataContext {
  return {
    snapshots: new WeakMap<object, object>(),
    visiting: new WeakSet<object>(),
  };
}

function hasExactDataPrototype(value: object, array: boolean): boolean {
  return array
    ? Object.getPrototypeOf(value) === Array.prototype
    : Object.getPrototypeOf(value) === Object.prototype;
}

function detachOwnDataObject(
  value: object,
  array: boolean,
  ownKeys: readonly PropertyKey[],
  context: ExactDataContext,
  depth: number,
): ExactDataSnapshot | null {
  const detached: object = array ? [] : {};
  context.snapshots.set(value, detached);
  context.visiting.add(value);
  let lengthDescriptor: PropertyDescriptor | null = null;
  for (const key of ownKeys) {
    const descriptor: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return null;
    const child: ExactDataSnapshot | null = snapshotExactDataAtDepth(
      descriptor.value,
      context,
      depth + 1,
    );
    if (child === null) return null;
    const detachedDescriptor: PropertyDescriptor = { ...descriptor, value: child.value };
    if (array && key === 'length') {
      lengthDescriptor = detachedDescriptor;
    } else if (!Reflect.defineProperty(detached, key, detachedDescriptor)) {
      return null;
    }
  }
  if (lengthDescriptor !== null && !Reflect.defineProperty(detached, 'length', lengthDescriptor)) {
    return null;
  }
  context.visiting.delete(value);

  const liveClone: unknown = structuredClone(value);
  return exactDataEqual(detached, liveClone) ? { value: detached } : null;
}

function exactValueEqual(left: unknown, right: unknown, context: ExactValueContext): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return exactArraysEqual(left, right, context);
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  return exactRecordsEqual(left, right, context);
}

function exactArraysEqual(left: unknown[], right: unknown[], context: ExactValueContext): boolean {
  if (exactPairSeen(left, right, context)) return true;
  const leftLength: number | null = exactDenseArrayLength(left);
  const rightLength: number | null = exactDenseArrayLength(right);
  if (leftLength === null || rightLength === null || leftLength !== rightLength) return false;
  for (let index: number = 0; index < leftLength; index++) {
    if (!exactValueEqual(left[index], right[index], context)) return false;
  }
  return true;
}

function exactRecordsEqual(
  left: UnknownRecord,
  right: UnknownRecord,
  context: ExactValueContext,
): boolean {
  if (exactPairSeen(left, right, context)) return true;
  const leftKeys: PropertyKey[] = Reflect.ownKeys(left);
  const rightKeys: PropertyKey[] = Reflect.ownKeys(right);
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key: PropertyKey): boolean => typeof key !== 'string') ||
    rightKeys.some((key: PropertyKey): boolean => typeof key !== 'string')
  ) {
    return false;
  }
  const rightKeySet: Set<PropertyKey> = new Set<PropertyKey>(rightKeys);
  for (const key of leftKeys) {
    if (typeof key !== 'string' || !rightKeySet.has(key)) return false;
    const leftDescriptor: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(
      left,
      key,
    );
    const rightDescriptor: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(
      right,
      key,
    );
    if (
      leftDescriptor === undefined ||
      rightDescriptor === undefined ||
      !Object.hasOwn(leftDescriptor, 'value') ||
      !Object.hasOwn(rightDescriptor, 'value') ||
      !exactValueEqual(leftDescriptor.value, rightDescriptor.value, context)
    ) {
      return false;
    }
  }
  return true;
}

function exactPairSeen(left: object, right: object, context: ExactValueContext): boolean {
  const rights: WeakSet<object> | undefined = context.pairs.get(left);
  if (rights?.has(right) === true) return true;
  if (rights === undefined) {
    context.pairs.set(left, new WeakSet<object>([right]));
  } else {
    rights.add(right);
  }
  return false;
}

function exactDenseArrayLength(value: unknown[]): number | null {
  const lengthDescriptor: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(
    value,
    'length',
  );
  if (
    lengthDescriptor === undefined ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return null;
  }
  const length: number = lengthDescriptor.value;
  if (Reflect.ownKeys(value).length !== length + 1) return null;
  for (let index: number = 0; index < length; index++) {
    if (!Object.hasOwn(value, index)) return null;
  }
  return length;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
