function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: object | null = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalStorageValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalStorageValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left]: [string, unknown], [right]: [string, unknown]): number =>
        left === right ? 0 : left < right ? -1 : 1,
      )
      .map(([key, nested]: [string, unknown]): [string, unknown] => [
        key,
        canonicalStorageValue(nested),
      ]),
  );
}

export function storageValuesEqual(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(canonicalStorageValue(left)) === JSON.stringify(canonicalStorageValue(right))
  );
}
