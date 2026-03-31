import { describe, it, expect } from 'vitest';
import type { ChannelAdapter } from '../src/adapter.js';

describe('ChannelAdapter interface', () => {
  it('can be implemented with the required methods', () => {
    const adapter: ChannelAdapter = {
      start: async () => {},
      stop: () => {},
      getStatus: () => 'connected',
      deliverOrphanResult: async () => {},
    };

    expect(adapter.start).toBeTypeOf('function');
    expect(adapter.stop).toBeTypeOf('function');
    expect(adapter.getStatus).toBeTypeOf('function');
    expect(adapter.deliverOrphanResult).toBeTypeOf('function');
  });

  it('getStatus returns a string', () => {
    const adapter: ChannelAdapter = {
      start: async () => {},
      stop: () => {},
      getStatus: () => 'disconnected',
      deliverOrphanResult: async () => {},
    };

    expect(adapter.getStatus()).toBe('disconnected');
  });
});
