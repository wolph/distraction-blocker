import { describe, expect, it } from 'vitest';
import { docStateFor, shouldStop } from '../../../src/content/gate';

describe('docStateFor', () => {
  it('is fresh while loading, loaded after', () => {
    expect(docStateFor('loading')).toBe('fresh');
    expect(docStateFor('interactive')).toBe('loaded');
    expect(docStateFor('complete')).toBe('loaded');
  });
});

describe('shouldStop', () => {
  it('stops only blocked fresh documents', () => {
    expect(shouldStop(true, 'fresh')).toBe(true);
    expect(shouldStop(true, 'loaded')).toBe(false);
    expect(shouldStop(false, 'fresh')).toBe(false);
  });
});
