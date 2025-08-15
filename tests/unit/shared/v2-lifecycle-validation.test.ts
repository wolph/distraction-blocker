import { describe, expect, it } from 'vitest';
import { isSessionLifecycleV2 } from '../../../src/shared/runtime-validation';
import type { SessionLifecycleV2 } from '../../../src/shared/types';
import {
  CLOSED_FRICTION_AUTHORITY,
  HIDDEN_AUTHORITY,
  IMMEDIATE_AUTHORITY,
  OPEN_FRICTION_AUTHORITY,
} from './v2-public-fixtures';
import { NOW, SESSION_ID } from './v2-runtime-fixtures';

describe('v2 public lifecycle validation', (): void => {
  const validLifecycles: SessionLifecycleV2[] = [
    { kind: 'idle', endAuthority: HIDDEN_AUTHORITY },
    {
      kind: 'starting',
      operationId: SESSION_ID,
      transition: 'start',
      endAuthority: HIDDEN_AUTHORITY,
    },
    {
      kind: 'starting',
      operationId: SESSION_ID,
      transition: 'resume',
      endAuthority: IMMEDIATE_AUTHORITY,
    },
    {
      kind: 'starting',
      operationId: SESSION_ID,
      transition: 'resume',
      endAuthority: OPEN_FRICTION_AUTHORITY,
    },
    {
      kind: 'cleanup',
      journal: 'transition',
      id: SESSION_ID,
      endAuthority: HIDDEN_AUTHORITY,
    },
    {
      kind: 'cleanup',
      journal: 'closure',
      id: SESSION_ID,
      endAuthority: HIDDEN_AUTHORITY,
    },
    { kind: 'active', endAuthority: CLOSED_FRICTION_AUTHORITY },
    {
      kind: 'error',
      code: 'transition-cleanup-failed',
      retryAvailable: true,
      endAuthority: HIDDEN_AUTHORITY,
    },
    {
      kind: 'error',
      code: 'closure-cleanup-failed',
      retryAvailable: true,
      endAuthority: HIDDEN_AUTHORITY,
    },
  ];

  it.each(validLifecycles)('accepts lifecycle %#', (value: SessionLifecycleV2): void => {
    expect(isSessionLifecycleV2(value)).toBe(true);
  });

  it.each([
    { kind: 'idle', endAuthority: IMMEDIATE_AUTHORITY },
    { kind: 'idle', canEnd: false, endAuthority: HIDDEN_AUTHORITY },
    {
      kind: 'starting',
      operationId: 'not-a-uuid',
      transition: 'start',
      endAuthority: HIDDEN_AUTHORITY,
    },
    {
      kind: 'starting',
      operationId: SESSION_ID,
      transition: 'restart',
      endAuthority: HIDDEN_AUTHORITY,
    },
    {
      kind: 'cleanup',
      journal: 'transition',
      id: SESSION_ID,
      endAuthority: IMMEDIATE_AUTHORITY,
    },
    {
      kind: 'cleanup',
      journal: 'activation',
      id: SESSION_ID,
      endAuthority: HIDDEN_AUTHORITY,
    },
    {
      kind: 'cleanup',
      journal: 'transition',
      id: 'not-a-uuid',
      endAuthority: HIDDEN_AUTHORITY,
    },
    {
      kind: 'error',
      code: 'closure-cleanup-failed',
      retryAvailable: false,
      endAuthority: HIDDEN_AUTHORITY,
    },
    {
      kind: 'active',
      endAuthority: { kind: 'immediate', actionLabel: 'Stop session' },
    },
    {
      kind: 'active',
      endAuthority: { ...IMMEDIATE_AUTHORITY, extra: true },
    },
    {
      kind: 'active',
      endAuthority: {
        ...CLOSED_FRICTION_AUTHORITY,
        copy: { actionLabel: 'Stop session' },
      },
    },
    {
      kind: 'active',
      endAuthority: {
        ...CLOSED_FRICTION_AUTHORITY,
        actions: { open: 'confirm-gate' },
      },
    },
    {
      kind: 'active',
      endAuthority: {
        ...CLOSED_FRICTION_AUTHORITY,
        copy: { ...CLOSED_FRICTION_AUTHORITY.copy, extra: true },
      },
    },
    {
      kind: 'active',
      endAuthority: {
        ...CLOSED_FRICTION_AUTHORITY,
        actions: { ...CLOSED_FRICTION_AUTHORITY.actions, [Symbol('extra')]: true },
      },
    },
    {
      kind: 'active',
      endAuthority: {
        ...OPEN_FRICTION_AUTHORITY,
        copy: { ...OPEN_FRICTION_AUTHORITY.copy, title: 'End session' },
      },
    },
    {
      kind: 'active',
      endAuthority: {
        ...OPEN_FRICTION_AUTHORITY,
        gate: { ...OPEN_FRICTION_AUTHORITY.gate, openedAt: 1.5 },
      },
    },
    {
      kind: 'active',
      endAuthority: {
        ...OPEN_FRICTION_AUTHORITY,
        gate: {
          ...OPEN_FRICTION_AUTHORITY.gate,
          readyAt: OPEN_FRICTION_AUTHORITY.gate.readyAt + 0.5,
        },
      },
    },
    {
      kind: 'active',
      endAuthority: {
        ...OPEN_FRICTION_AUTHORITY,
        gate: { ...OPEN_FRICTION_AUTHORITY.gate, kind: 'pause' },
      },
    },
    {
      kind: 'active',
      endAuthority: {
        ...OPEN_FRICTION_AUTHORITY,
        gate: { ...OPEN_FRICTION_AUTHORITY.gate, host: 'example.com' },
      },
    },
    {
      kind: 'active',
      endAuthority: {
        ...OPEN_FRICTION_AUTHORITY,
        gate: { ...OPEN_FRICTION_AUTHORITY.gate, readyAt: NOW - 1 },
      },
    },
    {
      kind: 'active',
      endAuthority: {
        ...OPEN_FRICTION_AUTHORITY,
        gate: { ...OPEN_FRICTION_AUTHORITY.gate, requiredPhrase: 1 },
      },
    },
    {
      kind: 'active',
      endAuthority: {
        ...OPEN_FRICTION_AUTHORITY,
        copy: { ...OPEN_FRICTION_AUTHORITY.copy, intentionReminder: 1 },
      },
    },
    {
      kind: 'active',
      endAuthority: {
        ...OPEN_FRICTION_AUTHORITY,
        actions: { ...OPEN_FRICTION_AUTHORITY.actions, confirm: 'open-end-gate' },
      },
    },
    {
      kind: 'active',
      endAuthority: {
        ...OPEN_FRICTION_AUTHORITY,
        gate: { ...OPEN_FRICTION_AUTHORITY.gate, extra: true },
      },
    },
  ])('rejects lifecycle or authority %#', (value: unknown): void => {
    expect(isSessionLifecycleV2(value)).toBe(false);
  });

  it('rejects accessor-backed lifecycle boundaries', (): void => {
    const rootAccessor: Record<string, unknown> = {
      kind: 'active',
      endAuthority: HIDDEN_AUTHORITY,
    };
    Object.defineProperty(rootAccessor, 'kind', {
      enumerable: true,
      get: (): string => 'active',
    });

    const authorityAccessor: Record<string, unknown> = {
      kind: 'immediate',
      actionLabel: 'End session',
    };
    Object.defineProperty(authorityAccessor, 'actionLabel', {
      enumerable: true,
      get: (): string => 'End session',
    });

    const copyAccessor: Record<string, unknown> = { actionLabel: 'End session' };
    Object.defineProperty(copyAccessor, 'actionLabel', {
      enumerable: true,
      get: (): string => 'End session',
    });

    const actionsAccessor: Record<string, unknown> = { open: 'open-end-gate' };
    Object.defineProperty(actionsAccessor, 'open', {
      enumerable: true,
      get: (): string => 'open-end-gate',
    });

    const gateAccessor: Record<string, unknown> = {
      ...OPEN_FRICTION_AUTHORITY.gate,
    };
    Object.defineProperty(gateAccessor, 'readyAt', {
      enumerable: true,
      get: (): number => NOW + 10_000,
    });

    expect(isSessionLifecycleV2(rootAccessor)).toBe(false);
    expect(isSessionLifecycleV2({ kind: 'active', endAuthority: authorityAccessor })).toBe(false);
    expect(
      isSessionLifecycleV2({
        kind: 'active',
        endAuthority: { ...CLOSED_FRICTION_AUTHORITY, copy: copyAccessor },
      }),
    ).toBe(false);
    expect(
      isSessionLifecycleV2({
        kind: 'active',
        endAuthority: { ...CLOSED_FRICTION_AUTHORITY, actions: actionsAccessor },
      }),
    ).toBe(false);
    expect(
      isSessionLifecycleV2({
        kind: 'active',
        endAuthority: { ...OPEN_FRICTION_AUTHORITY, gate: gateAccessor },
      }),
    ).toBe(false);
  });

  it('rejects a forwarding proxy', (): void => {
    const lifecycle: SessionLifecycleV2 = {
      kind: 'active',
      endAuthority: IMMEDIATE_AUTHORITY,
    };

    expect(isSessionLifecycleV2(new Proxy(lifecycle, {}))).toBe(false);
  });
});
