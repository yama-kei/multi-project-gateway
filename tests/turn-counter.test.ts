// tests/turn-counter.test.ts
import { describe, it, expect } from 'vitest';
import { createTurnCounter } from '../src/turn-counter.js';

describe('createTurnCounter', () => {
  it('starts at 0 turns', () => {
    const counter = createTurnCounter();
    expect(counter.getTurns('thread-1')).toBe(0);
  });

  it('increments turns for a thread', () => {
    const counter = createTurnCounter();
    counter.increment('thread-1');
    expect(counter.getTurns('thread-1')).toBe(1);
    counter.increment('thread-1');
    expect(counter.getTurns('thread-1')).toBe(2);
  });

  it('tracks threads independently', () => {
    const counter = createTurnCounter();
    counter.increment('thread-1');
    counter.increment('thread-1');
    counter.increment('thread-2');
    expect(counter.getTurns('thread-1')).toBe(2);
    expect(counter.getTurns('thread-2')).toBe(1);
  });

  it('reports when over limit', () => {
    const counter = createTurnCounter();
    counter.increment('thread-1');
    counter.increment('thread-1');
    expect(counter.isOverLimit('thread-1', 3)).toBe(false);
    counter.increment('thread-1');
    expect(counter.isOverLimit('thread-1', 3)).toBe(true);
  });

  it('resets turns for a thread', () => {
    const counter = createTurnCounter();
    counter.increment('thread-1');
    counter.increment('thread-1');
    counter.reset('thread-1');
    expect(counter.getTurns('thread-1')).toBe(0);
  });
});
