import { describe, expect, it } from 'vitest';
import { task7PngDimensions } from '../../../scripts/task7-png';

function pngPayload(signature: readonly number[]): Buffer {
  const payload: Buffer = Buffer.alloc(24);
  Buffer.from(signature).copy(payload);
  payload.writeUInt32BE(375, 16);
  payload.writeUInt32BE(667, 20);
  return payload;
}

describe('Task 7 PNG evidence validation', () => {
  it('requires the complete eight-byte PNG signature', (): void => {
    expect(
      task7PngDimensions(pngPayload([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toEqual({ height: 667, width: 375 });
    expect((): { height: number; width: number } =>
      task7PngDimensions(pngPayload([0x00, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toThrow(/PNG signature/i);
    expect((): { height: number; width: number } =>
      task7PngDimensions(pngPayload([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00])),
    ).toThrow(/PNG signature/i);
  });
});
