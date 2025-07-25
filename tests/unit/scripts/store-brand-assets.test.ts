import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

type PromoAsset = {
  path: string;
  width: number;
  height: number;
  sha256: string;
};

type PixelBounds = {
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  touchesEdge: boolean;
};

type PngChunk = {
  type: string;
  dataLength: number;
  offset: number;
  nextOffset: number;
};

const PNG_SIGNATURE: Buffer = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_CRITICAL_CHUNKS: ReadonlySet<string> = new Set(['IHDR', 'IDAT', 'IEND']);

const PROMO_ASSETS: PromoAsset[] = [
  {
    path: 'store/assets/small-promo-440x280.png',
    width: 440,
    height: 280,
    sha256: 'cb76652ea63a9512c1a21ced914d575ea3546757558ff8d08990771054e931c5',
  },
  {
    path: 'store/assets/marquee-1400x560.png',
    width: 1400,
    height: 560,
    sha256: '36f7786341c20954e345899504e94c0e1b3164faf204388f5af7c186999891ef',
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

function crc32(file: Buffer, start: number, end: number): number {
  let crc: number = 0xffffffff;
  for (let index: number = start; index < end; index += 1) {
    crc = (crc ^ (file.at(index) ?? 0)) >>> 0;
    for (let bit: number = 0; bit < 8; bit += 1) {
      crc = ((crc >>> 1) ^ (0xedb88320 & -(crc & 1))) >>> 0;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readPngChunk(file: Buffer, offset: number): PngChunk {
  if (offset + 12 > file.length) throw new Error(`truncated PNG chunk header at byte ${offset}`);
  const dataLength: number = file.readUInt32BE(offset);
  const dataStart: number = offset + 8;
  const crcOffset: number = dataStart + dataLength;
  const nextOffset: number = crcOffset + 4;
  if (nextOffset > file.length) throw new Error(`truncated PNG chunk data at byte ${offset}`);

  const type: string = file.toString('ascii', offset + 4, dataStart);
  if (!/^[A-Za-z]{4}$/.test(type))
    throw new Error(`invalid PNG chunk type ${JSON.stringify(type)}`);
  if (type.charCodeAt(0) & 0x20) throw new Error(`ancillary PNG chunk ${type} is forbidden`);
  if (!PNG_CRITICAL_CHUNKS.has(type)) throw new Error(`unexpected critical PNG chunk ${type}`);

  const expectedCrc: number = file.readUInt32BE(crcOffset);
  const actualCrc: number = crc32(file, offset + 4, crcOffset);
  if (actualCrc !== expectedCrc) throw new Error(`invalid CRC for PNG chunk ${type}`);
  return { type, dataLength, offset, nextOffset };
}

function validatePngStructure(file: Buffer): PngChunk[] {
  if (!file.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('invalid PNG signature');
  }

  const chunks: PngChunk[] = [];
  let offset: number = PNG_SIGNATURE.length;
  while (offset < file.length) {
    const chunk: PngChunk = readPngChunk(file, offset);
    chunks.push(chunk);
    offset = chunk.nextOffset;
    if (chunk.type === 'IEND') break;
  }

  if (offset !== file.length) throw new Error(`PNG has ${file.length - offset} trailing byte(s)`);
  if (chunks.at(0)?.type !== 'IHDR' || chunks.at(0)?.dataLength !== 13) {
    throw new Error('PNG must start with one 13-byte IHDR chunk');
  }
  if (chunks.at(-1)?.type !== 'IEND' || chunks.at(-1)?.dataLength !== 0) {
    throw new Error('PNG must end with one empty IEND chunk');
  }
  if (
    chunks.length < 3 ||
    !chunks.slice(1, -1).every((chunk: PngChunk): boolean => chunk.type === 'IDAT')
  ) {
    throw new Error('PNG must contain only contiguous IDAT chunks between IHDR and IEND');
  }
  return chunks;
}

function createPngChunk(type: string, data: Buffer): Buffer {
  const chunk: Buffer = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk, 4, 8 + data.length), 8 + data.length);
  return chunk;
}

function isDarkGreen(png: PNG, pixelIndex: number): boolean {
  const dataIndex: number = pixelIndex * 4;
  const red: number = png.data.at(dataIndex) ?? 0;
  const green: number = png.data.at(dataIndex + 1) ?? 0;
  const blue: number = png.data.at(dataIndex + 2) ?? 0;
  const luminance: number = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return luminance < 100 && green > red * 2 && green > blue * 1.5;
}

function darkGreenComponent(png: PNG, start: number, visited: Uint8Array): PixelBounds {
  const bounds: PixelBounds = {
    area: 0,
    minX: png.width,
    minY: png.height,
    maxX: -1,
    maxY: -1,
    touchesEdge: false,
  };
  const stack: number[] = [start];
  visited[start] = 1;

  while (stack.length > 0) {
    const pixelIndex: number | undefined = stack.pop();
    if (pixelIndex === undefined) break;
    const x: number = pixelIndex % png.width;
    const y: number = Math.floor(pixelIndex / png.width);
    bounds.area += 1;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
    bounds.touchesEdge ||= x === 0 || y === 0 || x === png.width - 1 || y === png.height - 1;

    const neighbors: number[] = [];
    if (x > 0) neighbors.push(pixelIndex - 1);
    if (x < png.width - 1) neighbors.push(pixelIndex + 1);
    if (y > 0) neighbors.push(pixelIndex - png.width);
    if (y < png.height - 1) neighbors.push(pixelIndex + png.width);
    for (const neighbor of neighbors) {
      if (visited[neighbor] === 1 || !isDarkGreen(png, neighbor)) continue;
      visited[neighbor] = 1;
      stack.push(neighbor);
    }
  }

  return bounds;
}

function largestInteriorDarkGreenComponent(png: PNG): PixelBounds {
  const pixelCount: number = png.width * png.height;
  const visited: Uint8Array = new Uint8Array(pixelCount);
  let largest: PixelBounds | undefined;

  for (let pixelIndex: number = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    if (visited[pixelIndex] === 1 || !isDarkGreen(png, pixelIndex)) continue;
    const component: PixelBounds = darkGreenComponent(png, pixelIndex, visited);
    if (!component.touchesEdge && (!largest || component.area > largest.area)) largest = component;
  }

  if (!largest) throw new Error('marquee has no interior dark-green progress-ring component');
  return largest;
}

describe('Chrome Web Store brand assets', () => {
  it.each(PROMO_ASSETS)('$path is an exact, opaque, green RGBA PNG', (asset: PromoAsset): void => {
    const file: Buffer = readFileSync(asset.path);
    validatePngStructure(file);
    const png: PNG = PNG.sync.read(file);

    expect({ width: png.width, height: png.height, colorType: file.at(25) }).toEqual({
      width: asset.width,
      height: asset.height,
      colorType: 6,
    });

    expect(minimumAlpha(png)).toBe(255);
    expect(saturatedGreenRatio(png)).toBeGreaterThan(0.85);
    expect(createHash('sha256').update(file).digest('hex')).toBe(asset.sha256);
  });

  it('rejects ancillary chunks, bad CRCs, truncation, and trailing bytes', (): void => {
    const file: Buffer = readFileSync(PROMO_ASSETS[0]?.path ?? '');
    const chunks: PngChunk[] = validatePngStructure(file);
    const iendOffset: number = chunks.at(-1)?.offset ?? file.length;
    const ancillary: Buffer = createPngChunk('tEXt', Buffer.from('watermark'));
    const withAncillary: Buffer = Buffer.concat([
      file.subarray(0, iendOffset),
      ancillary,
      file.subarray(iendOffset),
    ]);
    expect((): PngChunk[] => validatePngStructure(withAncillary)).toThrow(
      'ancillary PNG chunk tEXt',
    );

    const firstIdat: PngChunk | undefined = chunks.find(
      (chunk: PngChunk): boolean => chunk.type === 'IDAT',
    );
    if (!firstIdat) throw new Error('test PNG has no IDAT chunk');
    const badCrc: Buffer = Buffer.from(file);
    const firstDataByte: number = firstIdat.offset + 8;
    badCrc[firstDataByte] = (badCrc.at(firstDataByte) ?? 0) ^ 0xff;
    expect((): PngChunk[] => validatePngStructure(badCrc)).toThrow(
      'invalid CRC for PNG chunk IDAT',
    );

    expect((): PngChunk[] => validatePngStructure(file.subarray(0, -1))).toThrow(
      'truncated PNG chunk',
    );
    expect((): PngChunk[] => validatePngStructure(Buffer.concat([file, Buffer.from([0])]))).toThrow(
      'PNG has 1 trailing byte(s)',
    );
  });

  it('keeps the marquee progress ring inside its documented safe area', (): void => {
    const png: PNG = PNG.sync.read(readFileSync('store/assets/marquee-1400x560.png'));
    const ring: PixelBounds = largestInteriorDarkGreenComponent(png);
    const safeWidth: number = png.width * 0.36;
    const safeHeight: number = png.height * 0.62;
    const safeMinX: number = Math.ceil((png.width - safeWidth) / 2);
    const safeMaxX: number = Math.ceil((png.width + safeWidth) / 2) - 1;
    const safeMinY: number = Math.ceil((png.height - safeHeight) / 2);
    const safeMaxY: number = Math.ceil((png.height + safeHeight) / 2) - 1;
    const measurements: string = JSON.stringify({ ring, safeMinX, safeMaxX, safeMinY, safeMaxY });

    expect(ring.minX, measurements).toBeGreaterThanOrEqual(safeMinX);
    expect(ring.maxX, measurements).toBeLessThanOrEqual(safeMaxX);
    expect(ring.minY, measurements).toBeGreaterThanOrEqual(safeMinY);
    expect(ring.maxY, measurements).toBeLessThanOrEqual(safeMaxY);
  });
});
