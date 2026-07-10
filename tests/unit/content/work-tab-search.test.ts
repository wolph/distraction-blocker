// @vitest-environment jsdom
import { afterEach, expect, it, type Mock, vi } from 'vitest';
import { WorkTabSearch } from '../../../src/content/work-tab-search';
import type { WorkTab } from '../../../src/shared/work-target';

afterEach((): void => {
  vi.useRealTimers();
});

it('cancels filtering between chunks and cancels remaining timers on disposal', async (): Promise<void> => {
  vi.useFakeTimers();
  const index: WorkTabSearch = new WorkTabSearch();
  const tabs: WorkTab[] = Array.from(
    { length: 10000 },
    (_value: unknown, tabId: number): WorkTab => ({
      tabId,
      title: `Report ${tabId}`,
      hostname: 'work.example',
    }),
  );
  index.setTabs(tabs);
  const obsolete: Mock<(matches: WorkTab[]) => void> = vi.fn();
  const current: Mock<(matches: WorkTab[]) => void> = vi.fn();
  index.run('report', (): void => {}, obsolete);
  await vi.advanceTimersByTimeAsync(60);
  expect(obsolete).not.toHaveBeenCalled();
  index.run('9999', (): void => {}, current);
  await vi.runAllTimersAsync();
  expect(obsolete).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledWith([tabs[9999]]);
  index.run('report', (): void => {}, obsolete);
  index.cancel();
  expect(vi.getTimerCount()).toBe(0);
  await vi.runAllTimersAsync();
  expect(obsolete).not.toHaveBeenCalled();
});
