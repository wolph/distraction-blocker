import { describe, expect, it } from 'vitest';
import { createDemoEngine, type DemoEngine } from '../../../docs/site/engine';
import { DEMO_INTENTION, seedDemoSession } from '../../../docs/site/seed';
import type { SessionSnapshotV2 } from '../../../src/shared/types';

describe('seedDemoSession', () => {
  it('boots a focus session with the draft as work tab and lands on the blocked Headlines tab', async (): Promise<void> => {
    const engine: DemoEngine = createDemoEngine((): number => 1_700_000_000_000);
    await seedDemoSession(engine, 11, 12);
    const snapshot: SessionSnapshotV2 = await engine.handle({ type: 'getSnapshot' });
    expect(snapshot.lifecycle.kind).toBe('active');
    expect(snapshot.phase).toBe('focus');
    expect(snapshot.config?.intention).toBe(DEMO_INTENTION);
    expect(engine.strip().activeTabId).toBe(12);
    const target = await engine.handle({ type: 'getWorkTarget' });
    expect(target).toMatchObject({ ok: true, state: 'ready', title: 'Proposal draft' });
    const verdict = await engine.handle({
      type: 'getBlockState',
      url: 'https://headlines.example/',
      docState: 'loaded',
    });
    expect(verdict.commands.at(-1)).toMatchObject({ presentation: 'active' });
  });
});
