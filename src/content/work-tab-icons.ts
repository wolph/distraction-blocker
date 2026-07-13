import { sendRequest } from '../shared/messages';
import { parseWorkTabIconResult, type WorkTab } from '../shared/work-target';

interface IconRow {
  tab: WorkTab;
  badge: HTMLElement;
}

export class WorkTabIcons {
  private visible: Map<string, IconRow> = new Map();
  private active: Set<string> = new Set();
  private cache: Map<string, string | null> = new Map();
  private queued: string[] = [];
  private closed: boolean = false;
  private generation: number = 0;

  constructor(private readonly sessionId: string) {}

  show(rows: IconRow[]): void {
    this.visible = new Map(rows.map((row: IconRow): [string, IconRow] => [this.key(row.tab), row]));
    this.queued = [];
    for (const [key, row] of this.visible) {
      if (this.cache.has(key)) this.paint(row.badge, this.cache.get(key) ?? null);
      else if (!this.active.has(key)) this.queued.push(key);
    }
    this.pump();
  }

  invalidate(): void {
    this.generation += 1;
    this.cache.clear();
    this.visible.clear();
    this.queued = [];
  }

  close(): void {
    this.closed = true;
    this.visible.clear();
    this.queued = [];
    this.cache.clear();
  }

  private key(tab: WorkTab): string {
    return `${this.generation}:${tab.tabId}:${tab.hostname ?? ''}`;
  }

  private pump(): void {
    while (!this.closed && this.active.size < 4 && this.queued.length > 0) {
      const key: string = this.queued.shift() as string;
      const row: IconRow | undefined = this.visible.get(key);
      if (row === undefined || this.active.has(key) || this.cache.has(key)) continue;
      this.active.add(key);
      void this.load(key, row.tab.tabId, this.generation);
    }
  }

  private async load(key: string, tabId: number, generation: number): Promise<void> {
    let icon: string | null = null;
    try {
      const result: ReturnType<typeof parseWorkTabIconResult> = parseWorkTabIconResult(
        await sendRequest({ type: 'getWorkTabIcon', sessionId: this.sessionId, tabId }),
      );
      if (result?.ok) icon = result.icon;
    } catch {
      /* The domain badge remains available without a browser icon. */
    }
    this.active.delete(key);
    if (this.closed) return;
    const row: IconRow | undefined = this.visible.get(key);
    if (generation === this.generation && row !== undefined) {
      this.cache.set(key, icon);
      while (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value as string);
      this.paint(row.badge, icon);
    }
    this.pump();
  }

  private paint(badge: HTMLElement, icon: string | null): void {
    if (icon === null || badge.querySelector('img') !== null) return;
    const image: HTMLImageElement = document.createElement('img');
    image.alt = '';
    image.addEventListener('load', (): void => badge.classList.add('has-icon'));
    image.addEventListener('error', (): void => image.remove());
    image.src = icon;
    badge.append(image);
  }
}
