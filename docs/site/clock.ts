/**
 * The demo runs the real popup and lockscreen, and both read `Date.now()` for their countdowns.
 * Patching the realm's Date is the one place the demo bends time, so a 25 minute session ends
 * while a visitor watches. Every realm that runs product code installs its own copy.
 */
export interface ClockRealm {
  Date: DateConstructor;
}

export interface DemoClock {
  now(): number;
  uninstall(): void;
}

export function installDemoClock(realm: ClockRealm, speed: number): DemoClock {
  const RealDate: DateConstructor = realm.Date;
  const base: number = RealDate.now();
  const now = (): number => base + Math.round((RealDate.now() - base) * speed);
  const DemoDate = function (this: Date, ...args: unknown[]): Date | string {
    if (!new.target) return new RealDate(now()).toString();
    if (args.length === 0) return new RealDate(now());
    return new (RealDate as unknown as new (...values: unknown[]) => Date)(...args);
  } as unknown as DateConstructor;
  Object.setPrototypeOf(DemoDate, RealDate);
  (DemoDate as { prototype: DateConstructor['prototype'] }).prototype = RealDate.prototype;
  DemoDate.now = now;
  DemoDate.parse = RealDate.parse;
  DemoDate.UTC = RealDate.UTC;
  realm.Date = DemoDate;
  return {
    now,
    uninstall: (): void => {
      realm.Date = RealDate;
    },
  };
}
