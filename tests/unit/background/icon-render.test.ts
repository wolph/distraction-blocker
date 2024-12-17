import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IconSpec } from '../../../src/background/icon';
import { drawIcon, iconSpec } from '../../../src/background/icon';
import { emptySnapshot } from '../../../src/shared/constants';

interface DrawCall {
  name: string;
  args: number[];
}

class RecordingContext {
  public readonly calls: DrawCall[] = [];
  public strokeStyle: string = '';
  public fillStyle: string = '';
  public lineWidth: number = 0;
  public lineCap: CanvasLineCap = 'butt';

  public clearRect(...args: number[]): void {
    this.calls.push({ name: 'clearRect', args });
  }

  public save(): void {
    this.calls.push({ name: 'save', args: [] });
  }

  public restore(): void {
    this.calls.push({ name: 'restore', args: [] });
  }

  public translate(...args: number[]): void {
    this.calls.push({ name: 'translate', args });
  }

  public rotate(...args: number[]): void {
    this.calls.push({ name: 'rotate', args });
  }

  public beginPath(): void {
    this.calls.push({ name: 'beginPath', args: [] });
  }

  public arc(...args: number[]): void {
    this.calls.push({ name: 'arc', args });
  }

  public roundRect(...args: number[]): void {
    this.calls.push({ name: 'roundRect', args });
  }

  public stroke(): void {
    this.calls.push({ name: 'stroke', args: [] });
  }

  public fill(): void {
    this.calls.push({ name: 'fill', args: [] });
  }

  public getImageData(_x: number, _y: number, width: number, height: number): ImageData {
    const body: DrawCall | undefined = this.calls.find(
      (call: DrawCall): boolean => call.name === 'roundRect',
    );
    const data: Uint8ClampedArray = new Uint8ClampedArray(width * height * 4);
    data[0] = Math.round((body?.args[0] ?? 0) * 10);
    return { data, width, height } as unknown as ImageData;
  }
}

class RecordingCanvas {
  public static contexts: RecordingContext[] = [];
  private readonly context: RecordingContext = new RecordingContext();

  public constructor(_width: number, _height: number) {
    RecordingCanvas.contexts.push(this.context);
  }

  public getContext(_kind: '2d'): RecordingContext {
    return this.context;
  }
}

function activeSpec(phase: 'focus' | 'break'): IconSpec {
  return iconSpec({
    ...emptySnapshot(30_000),
    phase,
    phaseStartedAt: 0,
    phaseEndsAt: 60_000,
  });
}

afterEach((): void => {
  RecordingCanvas.contexts = [];
  vi.unstubAllGlobals();
});

describe('break icon pixels', () => {
  it.each([16, 32])('draws a cup body and ring at %i pixels', (size: number): void => {
    vi.stubGlobal('OffscreenCanvas', RecordingCanvas);
    const image: ImageData = drawIcon(size, activeSpec('break'));
    const context: RecordingContext | undefined = RecordingCanvas.contexts.at(-1);
    expect(image.width).toBe(size);
    expect(image.height).toBe(size);
    expect(image.data[0]).toBe(Math.round(3.2 * (size / 16) * 10));
    expect(context?.calls.filter((call: DrawCall): boolean => call.name === 'arc')).toHaveLength(4);
  });

  it('uses a different rendered body for focus', (): void => {
    vi.stubGlobal('OffscreenCanvas', RecordingCanvas);
    const focus: ImageData = drawIcon(16, activeSpec('focus'));
    const rest: ImageData = drawIcon(16, activeSpec('break'));
    expect(focus.data[0]).toBe(35);
    expect(rest.data[0]).toBe(32);
  });
});
