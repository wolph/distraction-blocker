/**
 * The shared engine seam's own guard. What it pins is the identity contract every harness that
 * boots a real `Engine` depends on: the runtime parser accepts UUIDs and nothing else, so a
 * fixture that mints anything else builds runtimes the parser refuses.
 */
import { describe, expect, it } from 'vitest';
import { emptyRuntimeV2 } from '../../../src/background/runtime-store-v2';
import type { RuntimeStateV2 } from '../../../src/background/runtime-v2-types';
import { parseRuntimeStateV2 } from '../../../src/background/runtime-v2-validation';
import { isUuid } from '../../../src/shared/v2-domain-intrinsics';
import { uuidMinterV2 } from './engine-ports-fake';

const NOW: number = new Date(2026, 8, 2, 9, 30, 0, 0).getTime();

describe('uuidMinterV2', (): void => {
  it('mints a distinct UUID every call', (): void => {
    const mint: () => string = uuidMinterV2();

    const minted: string[] = [mint(), mint(), mint()];

    for (const identity of minted) expect(isUuid(identity)).toBe(true);
    expect(new Set<string>(minted).size).toBe(minted.length);
  });

  it('mints an enforcement epoch the runtime parser accepts', (): void => {
    // The Engine mints a fresh epoch after an all-data clear and hands it straight to
    // emptyRuntimeV2, so a harness minting a non-UUID builds a runtime nothing can store.
    const mint: () => string = uuidMinterV2();

    const runtime: RuntimeStateV2 = emptyRuntimeV2(NOW, mint());

    expect(parseRuntimeStateV2(runtime)).not.toBeNull();
  });

  it('is what a plain counter is not', (): void => {
    // The failure this fixture exists to prevent, stated once so it cannot be mistaken for a
    // style preference: a readable identity is a runtime the parser refuses.
    const runtime: RuntimeStateV2 = emptyRuntimeV2(NOW, 'archive-id');

    expect(isUuid('archive-id')).toBe(false);
    expect(parseRuntimeStateV2(runtime)).toBeNull();
  });
});
