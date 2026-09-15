/** Three prompts beside the pretend browser. Each lights up when the engine reports its beat. */
import type { DemoEvent } from './engine';

interface Beat {
  id: 'start' | 'blocked' | 'back';
  text: string;
}

const BEATS: readonly Beat[] = [
  { id: 'start', text: 'Click the Focus Lock icon, name your task, and press Start.' },
  { id: 'blocked', text: 'Open the Headlines tab and meet the lockscreen.' },
  { id: 'back', text: 'Press Back to work. Your draft is right where you left it.' },
];

export interface Guide {
  advance(event: DemoEvent): void;
}

export function createGuide(root: HTMLOListElement): Guide {
  const items: Map<Beat['id'], HTMLLIElement> = new Map<Beat['id'], HTMLLIElement>();
  root.innerHTML = '';
  for (const beat of BEATS) {
    const item: HTMLLIElement = document.createElement('li');
    item.className = 'guide-step';
    item.dataset.beat = beat.id;
    item.textContent = beat.text;
    items.set(beat.id, item);
    root.append(item);
  }
  items.get('start')?.classList.add('guide-current');
  const done = (id: Beat['id'], next: Beat['id'] | null): void => {
    const item: HTMLLIElement | undefined = items.get(id);
    if (item === undefined) return;
    item.classList.remove('guide-current');
    item.classList.add('guide-done');
    if (next !== null) items.get(next)?.classList.add('guide-current');
  };
  return {
    advance: (event: DemoEvent): void => {
      if (event.type === 'sessionStarted') done('start', 'blocked');
      if (event.type === 'blocked') done('blocked', 'back');
      if (event.type === 'returnedToWork') done('back', null);
    },
  };
}
