import { describe, expect, it } from 'vitest';
import {
  parseStartSessionResult,
  parseStoredWorkTarget,
  parseWorkTabIconResult,
  parseWorkTabsResult,
  parseWorkTargetResult,
} from '../../../src/shared/work-target';

describe('work target response boundaries', (): void => {
  it('preserves the started flag and rejects malformed acknowledgements', (): void => {
    expect(parseStartSessionResult({ ok: true })).toEqual({ ok: true });
    expect(
      parseStartSessionResult({ ok: false, error: 'Storage failed', sessionStarted: true }),
    ).toEqual({ ok: false, error: 'Storage failed', sessionStarted: true });
    expect(
      parseStartSessionResult({ ok: false, error: 'Failure', sessionStarted: false }),
    ).toBeNull();
    expect(parseStartSessionResult({ ok: true, sessionStarted: true })).toBeNull();
  });
  it('accepts only coherent target status without destination identity', (): void => {
    const ready: unknown = { ok: true, sessionId: 'session', state: 'ready', title: 'Work' };
    expect(parseWorkTargetResult(ready)).toEqual(ready);
    expect(
      parseWorkTargetResult({ ok: true, sessionId: null, state: 'ready', title: 'Work' }),
    ).toBeNull();
    expect(
      parseWorkTargetResult({
        ok: true,
        sessionId: 'session',
        state: 'missing',
        title: 'Leaked title',
      }),
    ).toBeNull();
    expect(
      parseWorkTargetResult({
        ok: true,
        sessionId: 'session',
        state: 'ready',
        title: 'Work',
        tabId: 1,
      }),
    ).toBeNull();
  });
  it('validates candidate identity and persisted metadata', (): void => {
    expect(parseWorkTabsResult({ ok: true, tabs: [{ tabId: 2, title: 'Work' }] })).toEqual({
      ok: true,
      tabs: [{ tabId: 2, title: 'Work' }],
    });
    expect(parseWorkTabsResult({ ok: true, tabs: [{ tabId: -1, title: 'Work' }] })).toBeNull();
    expect(
      parseStoredWorkTarget({
        sessionId: 's',
        tabId: 2,
        incognito: false,
        title: 'Must not persist',
      }),
    ).toBeNull();
  });
  it('accepts validated hostnames and legacy title-only candidates', (): void => {
    for (const hostname of [
      'work.example',
      'localhost',
      '127.0.0.1',
      '[::1]',
      'xn--bcher-kva.example',
    ]) {
      const result: unknown = { ok: true, tabs: [{ tabId: 7, title: 'Report', hostname }] };
      expect(parseWorkTabsResult(result)).toEqual(result);
    }
    expect(parseWorkTabsResult({ ok: true, tabs: [{ tabId: 7, title: 'Report' }] })).toEqual({
      ok: true,
      tabs: [{ tabId: 7, title: 'Report' }],
    });
  });
  it.each([
    '',
    'https://work.example',
    'work.example/path',
    'work.example?secret=1',
    'work.example:443',
    'user@work.example',
    ' work.example',
    null,
    undefined,
  ])('rejects invalid candidate hostname %s', (hostname: unknown): void => {
    expect(
      parseWorkTabsResult({ ok: true, tabs: [{ tabId: 7, title: 'Report', hostname }] }),
    ).toBeNull();
  });
  it('rejects extra fields alongside hostname and hostile hostname accessors', (): void => {
    expect(
      parseWorkTabsResult({
        ok: true,
        tabs: [
          {
            tabId: 7,
            title: 'Report',
            hostname: 'work.example',
            url: 'https://work.example/private',
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseWorkTabsResult({
        ok: true,
        tabs: [
          {
            tabId: 7,
            title: 'Report',
            get hostname(): string {
              throw new Error('hostile');
            },
          },
        ],
      }),
    ).toBeNull();
  });
  it('fails closed on hostile accessors', (): void => {
    const hostile: unknown = {
      get ok(): boolean {
        throw new Error('hostile');
      },
    };
    expect(parseStartSessionResult(hostile)).toBeNull();
    expect(parseWorkTargetResult(hostile)).toBeNull();
    expect(parseWorkTabsResult(hostile)).toBeNull();
    expect(parseStoredWorkTarget(hostile)).toBeNull();
  });
});

const pngIcon: string =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Tf8AAAAASUVORK5CYII=';
it('validates optional MRU metadata and ready destination hostname', (): void => {
  const tabs: unknown = { ok: true, tabs: [{ tabId: 1, title: 'Work', lastAccessed: 0 }] };
  expect(parseWorkTabsResult(tabs)).toEqual(tabs);
  for (const lastAccessed of [-1, NaN, Infinity, '1', undefined])
    expect(
      parseWorkTabsResult({ ok: true, tabs: [{ tabId: 1, title: 'Work', lastAccessed }] }),
    ).toBeNull();
  const target: unknown = {
    ok: true,
    sessionId: 'one',
    state: 'ready',
    title: 'Work',
    hostname: 'work.example',
  };
  expect(parseWorkTargetResult(target)).toEqual(target);
  expect(
    parseWorkTargetResult({ ...(target as object), hostname: 'https://work.example/private' }),
  ).toBeNull();
  expect(
    parseWorkTargetResult({
      ok: true,
      sessionId: 'one',
      state: 'missing',
      title: null,
      hostname: 'work.example',
    }),
  ).toBeNull();
});
it('accepts only bounded PNG icon replies', (): void => {
  expect(parseWorkTabIconResult({ ok: true, icon: pngIcon })).toEqual({ ok: true, icon: pngIcon });
  expect(parseWorkTabIconResult({ ok: true, icon: null })).toEqual({ ok: true, icon: null });
  expect(parseWorkTabIconResult({ ok: false, error: 'Changed' })).toEqual({
    ok: false,
    error: 'Changed',
  });
  for (const icon of [
    'https://remote.example/icon.png',
    'data:image/svg+xml,<svg/>',
    'data:image/png;base64,aGVsbG8=',
    pngIcon + 'A'.repeat(50000),
  ])
    expect(parseWorkTabIconResult({ ok: true, icon })).toBeNull();
  expect(parseWorkTabIconResult({ ok: true, icon: null, url: 'private' })).toBeNull();
});
