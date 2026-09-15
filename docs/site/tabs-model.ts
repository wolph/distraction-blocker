/** The pretend browser's tab strip. Pure data so the engine and the view share one truth. */
export interface DemoTab {
  tabId: number;
  title: string;
  url: string;
  kind: 'work' | 'distraction';
}

export interface TabStrip {
  tabs: readonly DemoTab[];
  activeTabId: number;
}

export const DEMO_WINDOW_ID: number = 1;

export const DEMO_TABS: readonly DemoTab[] = [
  { tabId: 11, title: 'Proposal draft', url: 'https://proposal.example/draft', kind: 'work' },
  { tabId: 12, title: 'Headlines', url: 'https://headlines.example/', kind: 'distraction' },
  { tabId: 13, title: 'Videos', url: 'https://videos.example/', kind: 'distraction' },
];

export function createTabStrip(): TabStrip {
  return { tabs: DEMO_TABS, activeTabId: DEMO_TABS[0]?.tabId ?? 0 };
}

export function tabById(strip: TabStrip, tabId: number): DemoTab | null {
  return strip.tabs.find((tab: DemoTab): boolean => tab.tabId === tabId) ?? null;
}

export function activateTab(strip: TabStrip, tabId: number): TabStrip {
  if (tabById(strip, tabId) === null) throw new Error(`unknown demo tab ${String(tabId)}`);
  return { tabs: strip.tabs, activeTabId: tabId };
}

export function activeTab(strip: TabStrip): DemoTab {
  const tab: DemoTab | null = tabById(strip, strip.activeTabId);
  if (tab === null) throw new Error('the tab strip has no active tab');
  return tab;
}

export function hostnameOf(tab: DemoTab): string {
  return new URL(tab.url).hostname;
}
