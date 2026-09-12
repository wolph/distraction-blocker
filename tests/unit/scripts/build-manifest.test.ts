import type { ConfigEnv } from 'vite';
import { describe, expect, it } from 'vitest';
import manifest from '../../../manifest.config';
import { MANIFEST_KEY } from '../../../src/shared/manifest-key';

type BuiltManifest = Awaited<ReturnType<Extract<typeof manifest, (env: ConfigEnv) => unknown>>>;

describe('extension build identity', (): void => {
  it('omits the public identity key only from the store build', async (): Promise<void> => {
    if (typeof manifest !== 'function') throw new Error('manifest must select its build mode');
    const store: BuiltManifest = await manifest({ mode: 'store', command: 'build' });
    const ordinary: BuiltManifest = await manifest({ mode: 'production', command: 'build' });
    const development: BuiltManifest = await manifest({ mode: 'development', command: 'serve' });
    expect(Object.hasOwn(store, 'key')).toBe(false);
    expect(ordinary.key).toBe(MANIFEST_KEY);
    expect(development.key).toBe(MANIFEST_KEY);
    const { key: _key, ...withoutKey }: BuiltManifest = ordinary;
    expect(store).toEqual(withoutKey);
  });
});
