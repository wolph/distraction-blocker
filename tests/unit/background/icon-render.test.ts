import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IconSpec } from '../../../src/background/icon';
import { drawIcon, iconSpec, updateIcon } from '../../../src/background/icon';
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
  it.each([16, 32])(
    'draws closed lock, cup, and ring geometry at %i pixels',
    (size: number): void => {
      vi.stubGlobal('OffscreenCanvas', RecordingCanvas);
      const image: ImageData = drawIcon(size, activeSpec('break'));
      const context: RecordingContext | undefined = RecordingCanvas.contexts.at(-1);
      const calls: DrawCall[] = context?.calls ?? [];
      const unit: number = size / 16;
      expect(image.width).toBe(size);
      expect(image.height).toBe(size);
      expect(calls).toContainEqual({
        name: 'arc',
        args: [8 * unit, 7 * unit, 3.2 * unit, Math.PI, 2 * Math.PI],
      });
      expect(calls).toContainEqual({
        name: 'roundRect',
        args: [3.5 * unit, 7 * unit, 9 * unit, 7 * unit, 1.2 * unit],
      });
      expect(calls).toContainEqual({
        name: 'roundRect',
        args: [5 * unit, 8.4 * unit, 4.5 * unit, 3.2 * unit, unit],
      });
      expect(calls).toContainEqual({
        name: 'arc',
        args: [8 * unit, 8 * unit, 7.2 * unit, -Math.PI / 2, Math.PI / 2],
      });
    },
  );

  it('draws the cup only for breaks while both phases retain the lock body', (): void => {
    vi.stubGlobal('OffscreenCanvas', RecordingCanvas);
    const focus: ImageData = drawIcon(16, activeSpec('focus'));
    const rest: ImageData = drawIcon(16, activeSpec('break'));
    const focusCalls: DrawCall[] = RecordingCanvas.contexts[0]?.calls ?? [];
    const breakCalls: DrawCall[] = RecordingCanvas.contexts[1]?.calls ?? [];
    expect(focus.width).toBe(16);
    expect(rest.width).toBe(16);
    expect(focusCalls).toContainEqual({ name: 'roundRect', args: [3.5, 7, 9, 7, 1.2] });
    expect(focusCalls).not.toContainEqual({ name: 'roundRect', args: [5, 8.4, 4.5, 3.2, 1] });
    expect(breakCalls).toContainEqual({ name: 'roundRect', args: [3.5, 7, 9, 7, 1.2] });
    expect(breakCalls).toContainEqual({ name: 'roundRect', args: [5, 8.4, 4.5, 3.2, 1] });
  });

  it('attaches rejection handlers to every action update', async (): Promise<void> => {
    vi.stubGlobal('OffscreenCanvas', RecordingCanvas);
    const rejections: Promise<void>[] = [
      Promise.reject(new Error('icon unavailable')),
      Promise.reject(new Error('badge text unavailable')),
      Promise.reject(new Error('badge color unavailable')),
    ];
    const catches: Array<ReturnType<typeof vi.spyOn>> = rejections.map(
      (rejection: Promise<void>): ReturnType<typeof vi.spyOn> => vi.spyOn(rejection, 'catch'),
    );
    vi.stubGlobal('chrome', {
      action: {
        setIcon: vi.fn((): Promise<void> => rejections[0] as Promise<void>),
        setBadgeText: vi.fn((): Promise<void> => rejections[1] as Promise<void>),
        setBadgeBackgroundColor: vi.fn((): Promise<void> => rejections[2] as Promise<void>),
      },
    });

    try {
      updateIcon(emptySnapshot(0), true);
      expect(
        catches.every(
          (catchHandler: ReturnType<typeof vi.spyOn>): boolean =>
            catchHandler.mock.calls.length === 1,
        ),
      ).toBe(true);
      await Promise.resolve();
    } finally {
      await Promise.all(
        rejections.map(
          (rejection: Promise<void>): Promise<void> => rejection.catch((): undefined => undefined),
        ),
      );
    }
  });
});
