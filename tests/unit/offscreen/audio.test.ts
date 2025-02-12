import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayMsg } from '../../../src/background/audio';

type AudioListener = (message: PlayMsg) => undefined;

class FakeAudioParam {
  public value: number = 0;

  public setValueAtTime(_value: number, _startTime: number): AudioParam {
    return this as unknown as AudioParam;
  }

  public linearRampToValueAtTime(_value: number, _endTime: number): AudioParam {
    return this as unknown as AudioParam;
  }

  public exponentialRampToValueAtTime(_value: number, _endTime: number): AudioParam {
    return this as unknown as AudioParam;
  }
}

class FakeOscillator {
  public type: OscillatorType = 'sine';
  public readonly frequency: FakeAudioParam = new FakeAudioParam();

  public connect(destination: AudioNode): AudioNode {
    return destination;
  }

  public start(_when?: number): void {}

  public stop(_when?: number): void {}
}

class FakeGain {
  public readonly gain: FakeAudioParam = new FakeAudioParam();

  public connect(destination: AudioNode): AudioNode {
    return destination;
  }
}

class FakeAudioContext {
  public static readonly instances: FakeAudioContext[] = [];
  public readonly currentTime: number = 0;
  public readonly destination: AudioNode = {} as AudioNode;
  public readonly state: AudioContextState = 'running';

  public constructor() {
    FakeAudioContext.instances.push(this);
  }

  public createOscillator(): OscillatorNode {
    return new FakeOscillator() as unknown as OscillatorNode;
  }

  public createGain(): GainNode {
    return new FakeGain() as unknown as GainNode;
  }
}

afterEach((): void => {
  FakeAudioContext.instances.length = 0;
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('offscreen audio', (): void => {
  it('reuses one AudioContext across repeated chimes', async (): Promise<void> => {
    let listener: AudioListener | null = null;
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: {
          addListener: vi.fn((next: AudioListener): void => {
            listener = next;
          }),
        },
      },
    });
    await import('../../../src/offscreen/audio');
    const play: AudioListener = listener as unknown as AudioListener;

    play({ type: 'playSound', sound: 'breakStart', volume: 0.5 });
    play({ type: 'playSound', sound: 'breakEnd', volume: 0.5 });

    expect(FakeAudioContext.instances).toHaveLength(1);
  });
});
