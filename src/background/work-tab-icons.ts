import { isWorkIconBytes, MAX_WORK_ICON_BYTES } from '../shared/work-target';

export interface IconTarget {
  url: string;
  incognito: boolean;
  favicon?: string;
}

export interface WorkTabIconPorts {
  url(pageUrl: string): string;
  fetch(url: string, signal: AbortSignal): Promise<Response>;
}

type ValidateTarget = () => Promise<IconTarget>;

const MAX_ACTIVE: number = 4;
const MAX_QUEUED: number = 32;
const MAX_CACHED: number = 256;
const TIMEOUT_MS: number = 2000;

function identity(target: IconTarget): string {
  return JSON.stringify([target.incognito, target.url, target.favicon ?? null]);
}

/** Only bytes from Chrome's local favicon endpoint leave this worker. */
export class WorkTabIconService {
  private active: number = 0;
  private readonly queued: (() => void)[] = [];
  private readonly cache: Map<string, string | null> = new Map();

  constructor(private readonly ports: WorkTabIconPorts) {}

  async get(validate: ValidateTarget): Promise<string | null> {
    const target: IconTarget = await validate();
    const key: string = identity(target);
    if (this.cache.has(key)) {
      const icon: string | null = this.cache.get(key) ?? null;
      this.checkIdentity(key, await validate());
      this.cache.delete(key);
      this.cache.set(key, icon);
      return icon;
    }
    if (this.active >= MAX_ACTIVE && this.queued.length >= MAX_QUEUED) return null;
    return new Promise<string | null>(
      (resolve: (icon: string | null) => void, reject: (error: unknown) => void): void => {
        const run: () => void = (): void => {
          this.active += 1;
          void this.load(key, target, validate)
            .then(resolve, reject)
            .finally((): void => {
              this.active -= 1;
              this.queued.shift()?.();
            });
        };
        if (this.active < MAX_ACTIVE) run();
        else this.queued.push(run);
      },
    );
  }

  private checkIdentity(key: string, target: IconTarget): void {
    if (identity(target) !== key)
      throw new Error('The work tab changed. Refresh the available tabs.');
  }

  private async load(
    key: string,
    target: IconTarget,
    validate: ValidateTarget,
  ): Promise<string | null> {
    this.checkIdentity(key, await validate());
    const icon: string | null = this.cache.has(key)
      ? (this.cache.get(key) ?? null)
      : await this.download(target.url);
    this.checkIdentity(key, await validate());
    this.cache.delete(key);
    this.cache.set(key, icon);
    if (this.cache.size > MAX_CACHED) {
      const oldest: string | undefined = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return icon;
  }

  private async download(pageUrl: string): Promise<string | null> {
    const controller: AbortController = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout: Promise<null> = new Promise<null>((resolve: (value: null) => void): void => {
      timer = setTimeout((): void => {
        controller.abort();
        resolve(null);
      }, TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.read(pageUrl, controller.signal), timeout]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async read(pageUrl: string, signal: AbortSignal): Promise<string | null> {
    const response: Response = await this.ports.fetch(this.ports.url(pageUrl), signal);
    const mime: string | null = response.headers.get('content-type');
    const length: string | null = response.headers.get('content-length');
    if (
      !response.ok ||
      (mime !== null && mime.split(';')[0]?.trim().toLowerCase() !== 'image/png') ||
      (length !== null && Number(length) > MAX_WORK_ICON_BYTES)
    ) {
      await response.body?.cancel();
      return null;
    }
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
    if (reader === undefined) return null;
    const bytes: Uint8Array = new Uint8Array(MAX_WORK_ICON_BYTES);
    let size: number = 0;
    try {
      while (!signal.aborted) {
        const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read();
        if (chunk.done) break;
        if (size + chunk.value.length > MAX_WORK_ICON_BYTES) return null;
        bytes.set(chunk.value, size);
        size += chunk.value.length;
      }
    } finally {
      await reader.cancel();
    }
    const png: Uint8Array = bytes.subarray(0, size);
    return !signal.aborted && isWorkIconBytes(png)
      ? `data:image/png;base64,${btoa(String.fromCharCode(...png))}`
      : null;
  }
}

export function chromeWorkTabIconPorts(): WorkTabIconPorts {
  return {
    url: (pageUrl: string): string => {
      const url: URL = new URL(chrome.runtime.getURL('/_favicon/'));
      url.searchParams.set('pageUrl', pageUrl);
      url.searchParams.set('size', '32');
      return url.href;
    },
    fetch: (url: string, signal: AbortSignal): Promise<Response> =>
      fetch(url, { signal, credentials: 'omit', redirect: 'error' }),
  };
}
