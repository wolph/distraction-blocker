import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DemoClock, installDemoClock } from '../../../docs/site/clock';

describe('installDemoClock', () => {
  afterEach((): void => {
    vi.useRealTimers();
  });

  it('runs the realm clock at the given speed from the moment of installation', (): void => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const realm: { Date: DateConstructor } = { Date };
    const clock: DemoClock = installDemoClock(realm, 60);
    expect(realm.Date.now()).toBe(1_000_000);
    vi.setSystemTime(1_001_000);
    expect(realm.Date.now()).toBe(1_060_000);
    expect(clock.now()).toBe(1_060_000);
    clock.uninstall();
    expect(realm.Date.now()).toBe(1_001_000);
  });

  it('keeps new Date() on the same accelerated clock', (): void => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const realm: { Date: DateConstructor } = { Date };
    const clock: DemoClock = installDemoClock(realm, 10);
    vi.setSystemTime(2_000_500);
    expect(new realm.Date().getTime()).toBe(2_005_000);
    clock.uninstall();
  });

  it('reports the same now() for two realms installed at different real times with the same base', (): void => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const base: number = Date.now();
    const parentRealm: { Date: DateConstructor } = { Date };
    const parentClock: DemoClock = installDemoClock(parentRealm, 60, base);
    expect(parentClock.base).toBe(base);

    // The tab realm installs its own clock 400ms of real time after the parent did, the fraction
    // of a second a real iframe takes to load and run its own script, but shares the same base.
    vi.setSystemTime(1_000_400);
    const tabRealm: { Date: DateConstructor } = { Date };
    const tabClock: DemoClock = installDemoClock(tabRealm, 60, base);
    expect(tabClock.base).toBe(base);

    expect(tabClock.now()).toBe(parentClock.now());

    parentClock.uninstall();
    tabClock.uninstall();
  });
});
