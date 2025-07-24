import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

type PromoAsset = {
  path: string;
  width: number;
  height: number;
};

const PROMO_ASSETS: PromoAsset[] = [
  {
    path: 'store/assets/small-promo-440x280.png',
    width: 440,
    height: 280,
  },
  {
    path: 'store/assets/marquee-1400x560.png',
    width: 1400,
    height: 560,
  },
];

function saturatedGreenRatio(png: PNG): number {
  let saturatedGreenPixels: number = 0;
  const totalPixels: number = png.width * png.height;

  for (let index: number = 0; index < png.data.length; index += 4) {
    const red: number = png.data.at(index) ?? 0;
    const green: number = png.data.at(index + 1) ?? 0;
    const blue: number = png.data.at(index + 2) ?? 0;
    if (green >= 100 && green >= red * 1.35 && green >= blue * 1.2) {
      saturatedGreenPixels += 1;
    }
  }

  return saturatedGreenPixels / totalPixels;
}

function minimumAlpha(png: PNG): number {
  let alpha: number = 255;
  for (let index: number = 3; index < png.data.length; index += 4) {
    alpha = Math.min(alpha, png.data.at(index) ?? 0);
  }
  return alpha;
}

function pngChunkTypes(file: Buffer): string[] {
  const chunkTypes: string[] = [];
  let offset: number = 8;
  while (offset + 12 <= file.length) {
    const dataLength: number = file.readUInt32BE(offset);
    const chunkType: string = file.toString('ascii', offset + 4, offset + 8);
    chunkTypes.push(chunkType);
    offset += dataLength + 12;
    if (chunkType === 'IEND') break;
  }
  return chunkTypes;
}

describe('Chrome Web Store brand assets', () => {
  it.each(PROMO_ASSETS)('$path is an exact, opaque, green RGBA PNG', (asset: PromoAsset): void => {
    const file: Buffer = readFileSync(asset.path);
    const png: PNG = PNG.sync.read(file);

    expect({ width: png.width, height: png.height, colorType: file.at(25) }).toEqual({
      width: asset.width,
      height: asset.height,
      colorType: 6,
    });

    expect(minimumAlpha(png)).toBe(255);
    expect(saturatedGreenRatio(png)).toBeGreaterThan(0.85);
    expect(pngChunkTypes(file)).not.toContain('tEXt');
    expect(pngChunkTypes(file)).not.toContain('zTXt');
    expect(pngChunkTypes(file)).not.toContain('iTXt');
  });
});
