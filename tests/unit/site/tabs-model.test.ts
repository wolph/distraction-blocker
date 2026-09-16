import { describe, expect, it } from 'vitest';
import {
  activateTab,
  activeTab,
  createTabStrip,
  DEMO_TABS,
  hostnameOf,
  type TabStrip,
  tabById,
} from '../../../docs/site/tabs-model';

describe('tab strip model', () => {
  it('starts on the work tab with three fixed tabs', (): void => {
    const strip: TabStrip = createTabStrip();
    expect(strip.tabs).toEqual(DEMO_TABS);
    expect(activeTab(strip)).toMatchObject({ kind: 'work', url: 'https://proposal.example/draft' });
    expect(DEMO_TABS.map((tab): string => tab.url)).toEqual([
      'https://proposal.example/draft',
      'https://headlines.example/',
      'https://videos.example/',
    ]);
  });

  it('activates a tab by id without mutating the previous strip', (): void => {
    const first: TabStrip = createTabStrip();
    const second: TabStrip = activateTab(first, 12);
    expect(activeTab(second).title).toBe('Headlines');
    expect(activeTab(first).kind).toBe('work');
  });

  it('refuses an unknown tab id', (): void => {
    expect((): TabStrip => activateTab(createTabStrip(), 99)).toThrow('unknown demo tab 99');
    expect(tabById(createTabStrip(), 99)).toBeNull();
  });

  it('reports hostnames the matcher can classify', (): void => {
    expect(DEMO_TABS.map(hostnameOf)).toEqual([
      'proposal.example',
      'headlines.example',
      'videos.example',
    ]);
  });
});
