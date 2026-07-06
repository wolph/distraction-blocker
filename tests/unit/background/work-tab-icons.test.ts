import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  chromeWorkTabIconPorts,
  type IconTarget,
  type WorkTabIconPorts,
  WorkTabIconService,
} from '../../../src/background/work-tab-icons';

const encoded: string =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Tf8AAAAASUVORK5CYII=';
const png: Uint8Array = Uint8Array.from(atob(encoded), (value: string): number =>
  value.charCodeAt(0),
);
const target: IconTarget = {
  url: 'https://work.example/private?token=secret',
  incognito: false,
  favicon: 'https://remote.example/favicon.ico',
};
function response(bytes: Uint8Array = png, headers?: HeadersInit): Response {
  return new Response(bytes as BodyInit, { headers });
}
function harness(
  fetch: WorkTabIconPorts['fetch'] = async (): Promise<Response> => response(),
): WorkTabIconService {
  return new WorkTabIconService({
    url: (page: string): string =>
      `chrome-extension://extension/_favicon/?pageUrl=${encodeURIComponent(page)}&size=32`,
    fetch,
  });
}
afterEach((): void => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('bounded worker favicon delivery', (): void => {
  it('uses only the local endpoint and accepts legitimate absent MIME', async (): Promise<void> => {
    const fetch: Mock<WorkTabIconPorts['fetch']> = vi.fn(async (): Promise<Response> => response());
    const validate: Mock<() => Promise<IconTarget>> = vi.fn(
      async (): Promise<IconTarget> => target,
    );
    const service: WorkTabIconService = harness(fetch);
    expect(await service.get(validate)).toBe(`data:image/png;base64,${encoded}`);
    expect(fetch).toHaveBeenCalledOnce();
    const requested: URL = new URL(fetch.mock.calls[0]?.[0] as string);
    expect(requested.origin).toBe('null');
    expect(requested.protocol).toBe('chrome-extension:');
    expect(requested.hostname).toBe('extension');
    expect(requested.searchParams.get('pageUrl')).toBe(target.url);
    expect(requested.searchParams.get('size')).toBe('32');
    expect(validate).toHaveBeenCalledTimes(3);
    await service.get(validate);
    expect(fetch).toHaveBeenCalledOnce();
    expect(validate).toHaveBeenCalledTimes(5);
  });
  it('constructs its endpoint from runtime.getURL and never remote favicon URLs', (): void => {
    vi.stubGlobal('chrome', {
      runtime: { getURL: (path: string): string => `chrome-extension://extension${path}` },
    });
    const url: URL = new URL(chromeWorkTabIconPorts().url(target.url));
    expect(url.pathname).toBe('/_favicon/');
    expect(url.searchParams.get('pageUrl')).toBe(target.url);
  });
  it('partitions cache by privacy, page and favicon identity', async (): Promise<void> => {
    const fetch: Mock<WorkTabIconPorts['fetch']> = vi.fn(async (): Promise<Response> => response());
    const service: WorkTabIconService = harness(fetch);
    for (const value of [
      target,
      { ...target, incognito: true },
      { ...target, url: 'https://other.example' },
      { ...target, favicon: 'new' },
    ])
      await service.get(async (): Promise<IconTarget> => value);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('rejects an identity change during fetching and does not cache it', async (): Promise<void> => {
    let current: IconTarget = target;
    const fetch: Mock<WorkTabIconPorts['fetch']> = vi.fn(async (): Promise<Response> => {
      current = { ...target, url: 'https://changed.example' };
      return response();
    });
    const service: WorkTabIconService = harness(fetch);
    await expect(service.get(async (): Promise<IconTarget> => current)).rejects.toThrow();
    current = target;
    await expect(service.get(async (): Promise<IconTarget> => current)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('validates cached requests and propagates revocation without fetching', async (): Promise<void> => {
    const fetch: Mock<WorkTabIconPorts['fetch']> = vi.fn(async (): Promise<Response> => response());
    const service: WorkTabIconService = harness(fetch);
    await service.get(async (): Promise<IconTarget> => target);
    let calls: number = 0;
    await expect(
      service.get(async (): Promise<IconTarget> => {
        if (++calls === 2) throw new Error('Revoked');
        return target;
      }),
    ).rejects.toThrow('Revoked');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('bounds active fetches and queued requests, returning fallback on overflow', async (): Promise<void> => {
    vi.useFakeTimers();
    const fetch: Mock<WorkTabIconPorts['fetch']> = vi.fn(
      async (): Promise<Response> => new Promise<Response>((): void => {}),
    );
    const service: WorkTabIconService = harness(fetch);
    const pending: Promise<string | null>[] = Array.from(
      { length: 37 },
      (_value: unknown, index: number): Promise<string | null> =>
        service.get(
          async (): Promise<IconTarget> => ({ ...target, url: `https://work.example/${index}` }),
        ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(await pending[36]).toBeNull();
    await vi.runAllTimersAsync();
    expect(await Promise.all(pending)).toEqual(Array(37).fill(null));
    expect(fetch).toHaveBeenCalledTimes(36);
  });
  it('aborts after two seconds and limits the cache to 256 entries', async (): Promise<void> => {
    const fetch: Mock<WorkTabIconPorts['fetch']> = vi.fn(async (): Promise<Response> => response());
    const service: WorkTabIconService = harness(fetch);
    for (let index: number = 0; index < 257; index += 1)
      await service.get(
        async (): Promise<IconTarget> => ({ ...target, url: `https://work.example/${index}` }),
      );
    await service.get(
      async (): Promise<IconTarget> => ({ ...target, url: 'https://work.example/0' }),
    );
    expect(fetch).toHaveBeenCalledTimes(258);
    vi.useFakeTimers();
    let signal: AbortSignal | null = null;
    const stalled: WorkTabIconService = harness(
      async (_url: string, requestedSignal: AbortSignal): Promise<Response> => {
        signal = requestedSignal;
        return new Promise<Response>((): void => {});
      },
    );
    const result: Promise<string | null> = stalled.get(async (): Promise<IconTarget> => target);
    await vi.advanceTimersByTimeAsync(2001);
    expect(await result).toBeNull();
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
  });
  it('falls back for oversized, non-PNG, incompatible MIME and excessive dimensions', async (): Promise<void> => {
    const oversized: Uint8Array = new Uint8Array(32769);
    const huge: Uint8Array = png.slice();
    new DataView(huge.buffer).setUint32(16, 100000);
    for (const value of [
      response(oversized),
      response(new Uint8Array([1, 2, 3])),
      response(png, { 'Content-Type': 'image/svg+xml' }),
      response(huge),
    ]) {
      expect(
        await harness(async (): Promise<Response> => value).get(
          async (): Promise<IconTarget> => target,
        ),
      ).toBeNull();
    }
  });
});

it('cancels an oversized streamed body without reading it all', async (): Promise<void> => {
  const cancel: Mock<() => void> = vi.fn();
  const stream: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    start: (controller: ReadableStreamDefaultController<Uint8Array>): void => {
      controller.enqueue(new Uint8Array(20000));
      controller.enqueue(new Uint8Array(20000));
    },
    cancel,
  });
  const service: WorkTabIconService = harness(async (): Promise<Response> => new Response(stream));
  expect(await service.get(async (): Promise<IconTarget> => target)).toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
});

it('revalidates queued targets before starting another fetch', async (): Promise<void> => {
  vi.useFakeTimers();
  let allowed: boolean = true;
  const fetch: Mock<WorkTabIconPorts['fetch']> = vi.fn(
    async (): Promise<Response> => new Promise<Response>((): void => {}),
  );
  const service: WorkTabIconService = harness(fetch);
  const active: Promise<string | null>[] = Array.from(
    { length: 4 },
    (_value: unknown, index: number): Promise<string | null> =>
      service.get(
        async (): Promise<IconTarget> => ({ ...target, url: `https://work.example/${index}` }),
      ),
  );
  const queued: Promise<string | null> = service.get(async (): Promise<IconTarget> => {
    if (!allowed) throw new Error('Session ended');
    return target;
  });
  const rejected: Promise<void> = expect(queued).rejects.toThrow('Session ended');
  await vi.advanceTimersByTimeAsync(0);
  allowed = false;
  await vi.advanceTimersByTimeAsync(2001);
  await rejected;
  await Promise.all(active);
  expect(fetch).toHaveBeenCalledTimes(4);
});
