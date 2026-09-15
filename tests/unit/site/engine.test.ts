import { beforeEach, describe, expect, it } from 'vitest';
import { createDemoEngine, type DemoEngine, type DemoEvent } from '../../../docs/site/engine';
import { DEMO_WINDOW_ID } from '../../../docs/site/tabs-model';
import type { DocumentContentCommand } from '../../../src/shared/enforcement-v2';
import type { Broadcast, Request, ResponseMap } from '../../../src/shared/messages';
import { isSessionSnapshotV2, isSetupState } from '../../../src/shared/runtime-validation';
import type {
  GateState,
  ListsConfig,
  SessionConfigV2,
  SessionRuleSnapshot,
  SessionSnapshotV2,
} from '../../../src/shared/types';

let clock: number;
let engine: DemoEngine;

/** The demo's one draft policy: the baked-in custom rules, no categories, no session extras. */
function draftRules(lists: ListsConfig): SessionRuleSnapshot {
  return {
    baselineRevision: 'demo',
    baselineCategories: lists.categories,
    categories: lists.categories,
    exclusions: {},
    permanentBlacklist: lists.custom,
    permanentAllowlist: lists.whitelist,
    sessionBlacklist: [],
    sessionAllowlist: [],
  };
}

function startRequest(
  engine: DemoEngine,
  minutes: number = 25,
): Promise<ResponseMap['startSession']> {
  return engine
    .handle({ type: 'getLists' })
    .then(async (lists: ListsConfig): Promise<ResponseMap['startSession']> => {
      const settings = await engine.handle({ type: 'getSettings' });
      const config: SessionConfigV2 = {
        mode: 'blacklist',
        strictness: 'friction',
        duration: { kind: 'timed', minutes },
        cycling: null,
        intention: 'Finish the proposal',
        source: 'manual',
        scheduleOccurrence: null,
        rules: draftRules(lists),
      };
      void settings;
      return engine.handle({ type: 'startSession', config, workTabId: 11, windowId: 1 });
    });
}

beforeEach((): void => {
  clock = 1_700_000_000_000;
  engine = createDemoEngine((): number => clock);
});

describe('demo engine setup answers', () => {
  it('reports a completed setup with website access granted', async (): Promise<void> => {
    const setup = await engine.handle({ type: 'getSetupState' });
    expect(isSetupState(setup)).toBe(true);
    expect(setup).toMatchObject({
      completed: true,
      websiteAccess: 'granted',
      blockingRegistration: 'ready',
    });
    expect(await engine.handle({ type: 'getBootFailure' })).toEqual({ ok: true, failure: null });
  });

  it('blocks the two distracting hosts through custom rules', async (): Promise<void> => {
    const lists = await engine.handle({ type: 'getLists' });
    expect(lists.custom).toEqual([
      { kind: 'host', pattern: 'headlines.example' },
      { kind: 'host', pattern: 'videos.example' },
    ]);
  });

  it('answers an idle snapshot the popup accepts', async (): Promise<void> => {
    const snapshot = await engine.handle({ type: 'getSnapshot' });
    expect(isSessionSnapshotV2(snapshot)).toBe(true);
    expect(snapshot.lifecycle.kind).toBe('idle');
  });

  it('throws for a request it does not model', async (): Promise<void> => {
    await expect(
      engine.handle({ type: 'exportEvents' } as Request as Extract<
        Request,
        { type: 'exportEvents' }
      >),
    ).rejects.toThrow('demo engine does not handle exportEvents');
  });
});

describe('demo engine session', () => {
  it('starts a session, broadcasts it, and blocks a distracting tab', async (): Promise<void> => {
    const broadcasts: Broadcast[] = [];
    const events: DemoEvent[] = [];
    engine.onBroadcast((message: Broadcast): void => {
      broadcasts.push(message);
    });
    engine.onEvent((event: DemoEvent): void => {
      events.push(event);
    });
    const started = await startRequest(engine);
    expect(started).toEqual({ ok: true, code: 'ok' });
    expect(broadcasts.map((message): string => message.type)).toEqual([
      'stateChanged',
      'reevaluate',
      'workTargetChanged',
    ]);
    expect(events).toEqual([{ type: 'sessionStarted' }]);

    const snapshot: SessionSnapshotV2 = await engine.handle({ type: 'getSnapshot' });
    expect(isSessionSnapshotV2(snapshot)).toBe(true);
    expect(snapshot.lifecycle.kind).toBe('active');
    expect(snapshot.config?.intention).toBe('Finish the proposal');

    const blocked = await engine.handle({
      type: 'getBlockState',
      url: 'https://headlines.example/',
      docState: 'loaded',
    });
    const commands: DocumentContentCommand[] = blocked.commands;
    expect(commands.map((command): string => command.command)).toEqual([
      'reset-enforcement-epoch',
      'apply-enforcement',
    ]);
    const apply = commands[1];
    expect(apply?.command === 'apply-enforcement' && apply.verdict.blocked).toBe(true);
    expect(apply?.command === 'apply-enforcement' && apply.overlay?.presentation).toBe('active');
    expect(events.at(-1)).toEqual({ type: 'blocked', tabId: 12 });

    const allowed = await engine.handle({
      type: 'getBlockState',
      url: 'https://proposal.example/draft',
      docState: 'loaded',
    });
    const clear = allowed.commands[1];
    expect(clear?.command === 'apply-enforcement' && clear.presentation).toBe('clear');
  });

  it('returns to the chosen work tab', async (): Promise<void> => {
    await startRequest(engine);
    engine.activate(12);
    const events: DemoEvent[] = [];
    engine.onEvent((event: DemoEvent): void => {
      events.push(event);
    });
    const target = await engine.handle({ type: 'getWorkTarget' });
    if (!target.ok || target.sessionId === null) throw new Error('work target unavailable');
    expect(target).toMatchObject({ state: 'ready', title: 'Proposal draft' });
    expect(await engine.handle({ type: 'returnToWork', sessionId: target.sessionId })).toEqual({
      ok: true,
    });
    expect(engine.strip().activeTabId).toBe(11);
    expect(events).toEqual([{ type: 'returnedToWork', tabId: 11 }]);
  });

  it('opens, readies and confirms the Friction end gate', async (): Promise<void> => {
    await startRequest(engine);
    expect(await engine.handle({ type: 'openEndGate' })).toEqual({ ok: true, code: 'ok' });
    const withGate: SessionSnapshotV2 = await engine.handle({ type: 'getSnapshot' });
    expect(withGate.gate?.kind).toBe('cancel');
    const gate = withGate.gate;
    if (gate === null) throw new Error('gate missing');
    expect(
      await engine.handle({ type: 'confirmGate', typedPhrase: null, expectedGate: gate }),
    ).toMatchObject({ ok: false, code: 'gate-not-ready' });
    clock += 10_000;
    engine.tick();
    expect(
      await engine.handle({ type: 'confirmGate', typedPhrase: null, expectedGate: gate }),
    ).toEqual({ ok: true, code: 'ok' });
    expect((await engine.handle({ type: 'getSnapshot' })).lifecycle.kind).toBe('idle');
  });

  it('ends a timed session when its clock runs out', async (): Promise<void> => {
    const events: DemoEvent[] = [];
    engine.onEvent((event: DemoEvent): void => {
      events.push(event);
    });
    await startRequest(engine);
    clock += 25 * 60_000;
    engine.tick();
    expect((await engine.handle({ type: 'getSnapshot' })).lifecycle.kind).toBe('idle');
    expect(events.at(-1)).toEqual({ type: 'sessionEnded' });
    const after = await engine.handle({
      type: 'getBlockState',
      url: 'https://headlines.example/',
      docState: 'loaded',
    });
    expect(after.commands.at(-1)).toMatchObject({
      command: 'apply-enforcement',
      presentation: 'clear',
    });
  });
});

describe('demo engine work tab preview before a session', () => {
  it('filters the pre-start listing by the requested policy, not the live session', async (): Promise<void> => {
    const lists = await engine.handle({ type: 'getLists' });
    const blacklisted = await engine.handle({
      type: 'getWorkTabs',
      mode: 'blacklist',
      windowId: DEMO_WINDOW_ID,
      rules: draftRules(lists),
    });
    expect(blacklisted).toEqual({
      ok: true,
      tabs: [
        { tabId: 11, title: 'Proposal draft', hostname: 'proposal.example', lastAccessed: clock },
      ],
    });

    const whitelisted = await engine.handle({
      type: 'getWorkTabs',
      mode: 'whitelist',
      windowId: DEMO_WINDOW_ID,
    });
    expect(whitelisted).toEqual({ ok: true, tabs: [] });
  });
});

describe('demo engine pause economy', () => {
  it('pauses on Unlock all sites once affordable, then resumes and blocks again', async (): Promise<void> => {
    await startRequest(engine, 60);
    clock += 30 * 60_000;
    expect(await engine.handle({ type: 'openGate', gate: 'pause', host: null })).toEqual({
      ok: true,
      code: 'ok',
    });
    const opened: SessionSnapshotV2 = await engine.handle({ type: 'getSnapshot' });
    const gate: GateState | null = opened.gate;
    if (gate === null) throw new Error('gate missing');
    clock += 10_000;
    engine.tick();
    expect(
      await engine.handle({ type: 'confirmGate', typedPhrase: null, expectedGate: gate }),
    ).toEqual({ ok: true, code: 'ok' });

    const paused: SessionSnapshotV2 = await engine.handle({ type: 'getSnapshot' });
    expect(paused.phase).toBe('paused');
    const blockedWhilePaused = await engine.handle({
      type: 'getBlockState',
      url: 'https://headlines.example/',
      docState: 'loaded',
    });
    expect(blockedWhilePaused.commands.at(-1)).toMatchObject({
      command: 'apply-enforcement',
      presentation: 'clear',
    });

    expect(await engine.handle({ type: 'resumeFromPause' })).toEqual({ ok: true, code: 'ok' });
    const resumed: SessionSnapshotV2 = await engine.handle({ type: 'getSnapshot' });
    expect(resumed.phase).toBe('focus');
    const blockedAfterResume = await engine.handle({
      type: 'getBlockState',
      url: 'https://headlines.example/',
      docState: 'loaded',
    });
    expect(blockedAfterResume.commands.at(-1)).toMatchObject({
      command: 'apply-enforcement',
      presentation: 'active',
    });
  });

  it('unlocks the host of the active tab, not the host the request named', async (): Promise<void> => {
    await startRequest(engine, 60);
    engine.activate(12);
    clock += 30 * 60_000;
    expect(
      await engine.handle({ type: 'openGate', gate: 'unlockSite', host: 'localhost' }),
    ).toEqual({ ok: true, code: 'ok' });
    const opened: SessionSnapshotV2 = await engine.handle({ type: 'getSnapshot' });
    const gate: GateState | null = opened.gate;
    if (gate === null) throw new Error('gate missing');
    expect(gate).toMatchObject({ kind: 'unlockSite', host: 'headlines.example' });
    clock += 10_000;
    engine.tick();
    expect(
      await engine.handle({ type: 'confirmGate', typedPhrase: null, expectedGate: gate }),
    ).toEqual({ ok: true, code: 'ok' });

    const headlines = await engine.handle({
      type: 'getBlockState',
      url: 'https://headlines.example/',
      docState: 'loaded',
    });
    expect(headlines.commands.at(-1)).toMatchObject({
      command: 'apply-enforcement',
      presentation: 'clear',
    });
    const videos = await engine.handle({
      type: 'getBlockState',
      url: 'https://videos.example/',
      docState: 'loaded',
    });
    expect(videos.commands.at(-1)).toMatchObject({
      command: 'apply-enforcement',
      presentation: 'active',
    });
  });

  it('refuses to confirm a pause gate the bank cannot yet afford', async (): Promise<void> => {
    await startRequest(engine, 60);
    expect(await engine.handle({ type: 'openGate', gate: 'pause', host: null })).toEqual({
      ok: true,
      code: 'ok',
    });
    const opened: SessionSnapshotV2 = await engine.handle({ type: 'getSnapshot' });
    const gate: GateState | null = opened.gate;
    if (gate === null) throw new Error('gate missing');
    clock += 10_000;
    engine.tick();
    expect(
      await engine.handle({ type: 'confirmGate', typedPhrase: null, expectedGate: gate }),
    ).toMatchObject({ ok: false, code: 'end-not-allowed' });
    expect((await engine.handle({ type: 'getSnapshot' })).phase).toBe('focus');
  });
});

describe('demo engine publish throttling', () => {
  it('publishes only when something observable changes', async (): Promise<void> => {
    const lists = await engine.handle({ type: 'getLists' });
    const config: SessionConfigV2 = {
      mode: 'blacklist',
      strictness: 'friction',
      duration: { kind: 'timed', minutes: 60 },
      cycling: { focusMin: 10, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
      intention: 'Finish the proposal',
      source: 'manual',
      scheduleOccurrence: null,
      rules: draftRules(lists),
    };
    await engine.handle({ type: 'startSession', config, workTabId: 11, windowId: 1 });

    const broadcasts: Broadcast[] = [];
    engine.onBroadcast((message: Broadcast): void => {
      broadcasts.push(message);
    });
    for (let i: number = 0; i < 10; i++) {
      await engine.handle({ type: 'getSnapshot' });
    }
    expect(broadcasts).toEqual([]);

    clock += 10 * 60_000;
    await engine.handle({ type: 'getSnapshot' });
    expect(broadcasts.map((message: Broadcast): string => message.type)).toEqual([
      'stateChanged',
      'reevaluate',
    ]);
  });

  it('publishes a throttled credit tick, without a reevaluate, when only the bank moves', async (): Promise<void> => {
    await startRequest(engine, 60);
    const broadcasts: Broadcast[] = [];
    engine.onBroadcast((message: Broadcast): void => {
      broadcasts.push(message);
    });
    clock += 1_500;
    await engine.handle({ type: 'getSnapshot' });
    expect(broadcasts.map((message: Broadcast): string => message.type)).toEqual(['stateChanged']);
  });
});
