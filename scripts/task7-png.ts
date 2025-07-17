const PNG_SIGNATURE: Uint8Array = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function task7PngDimensions(payload: Uint8Array): { height: number; width: number } {
  if (
    payload.byteLength < 24 ||
    PNG_SIGNATURE.some((byte: number, index: number): boolean => payload[index] !== byte)
  ) {
    throw new Error('Invalid Task 7 PNG signature.');
  }
  const view: DataView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { height: view.getUint32(20), width: view.getUint32(16) };
}
