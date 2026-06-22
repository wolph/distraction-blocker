import type { WorkTab } from '../shared/work-target';

interface IndexedTab {
  tab: WorkTab;
  text: string;
}

/** Reuse normalised text and yield between large filtering chunks. */
export class WorkTabSearch {
  private indexed: IndexedTab[] = [];
  private generation: number = 0;
  private timer: number | null = null;

  setTabs(tabs: WorkTab[]): void {
    this.cancel();
    this.indexed = tabs.map(
      (tab: WorkTab): IndexedTab => ({
        tab,
        text: `${tab.title} ${tab.hostname ?? ''}`.toLowerCase(),
      }),
    );
  }

  run(query: string, pending: () => void, complete: (matches: WorkTab[]) => void): void {
    this.cancel();
    const generation: number = this.generation;
    const terms: string[] = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches: WorkTab[] = [];
    let index: number = 0;
    const step: () => void = (): void => {
      if (generation !== this.generation) return;
      this.timer = null;
      const end: number = Math.min(index + 500, this.indexed.length);
      for (; index < end; index += 1) {
        const entry: IndexedTab = this.indexed[index] as IndexedTab;
        if (terms.every((term: string): boolean => entry.text.includes(term)))
          matches.push(entry.tab);
      }
      if (index < this.indexed.length) this.timer = window.setTimeout(step, 0);
      else complete(matches);
    };
    if (this.indexed.length <= 500) step();
    else {
      pending();
      this.timer = window.setTimeout(step, 60);
    }
  }

  cancel(): void {
    this.generation += 1;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }
}
