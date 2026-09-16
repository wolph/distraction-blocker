/** Three prompts beside the pretend browser. Each lights up when the engine reports its beat. */
import type { DemoEvent } from './engine';

interface Beat {
  id: 'back' | 'session' | 'start';
  text: string;
}

const BEATS: readonly Beat[] = [
  {
    id: 'back',
    text: 'You landed on a blocked site mid-session. Press Back to work to return to your draft.',
  },
  {
    id: 'session',
    text: 'Click the Focus Lock icon in the toolbar to see the running session, then end it.',
  },
  {
    id: 'start',
    text: 'Start your own: name a task, pick a duration, press Start, and open Headlines again.',
  },
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
  items.get('back')?.classList.add('guide-current');
  // A beat that has already finished stays finished: the engine can emit the same event more than
  // once, and a replay must never hand guide-current back to a beat that is already done.
  const doneBeats: Set<Beat['id']> = new Set<Beat['id']>();
  const done = (id: Beat['id'], next: Beat['id'] | null): void => {
    if (doneBeats.has(id)) return;
    doneBeats.add(id);
    const item: HTMLLIElement | undefined = items.get(id);
    if (item === undefined) return;
    item.classList.remove('guide-current');
    item.classList.add('guide-done');
    if (next !== null && !doneBeats.has(next)) items.get(next)?.classList.add('guide-current');
  };
  return {
    advance: (event: DemoEvent): void => {
      if (event.type === 'returnedToWork') done('back', 'session');
      if (event.type === 'sessionEnded') done('session', 'start');
      if (event.type === 'sessionStarted' && doneBeats.has('session')) done('start', null);
    },
  };
}
