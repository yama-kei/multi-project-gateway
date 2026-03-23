import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/router.js';
import type { GatewayConfig } from '../src/config.js';

const config: GatewayConfig = {
  defaults: { idleTimeoutMs: 1800000, maxConcurrentSessions: 4, claudeArgs: [] },
  projects: {
    '111': { name: 'ProjectA', directory: '/tmp/a' },
    '222': { name: 'ProjectB', directory: '/tmp/b' },
  },
};

describe('createRouter', () => {
  const router = createRouter(config);

  it('returns project config for a mapped channel', () => {
    const result = router.resolve('111');
    expect(result).toEqual({ channelId: '111', name: 'ProjectA', directory: '/tmp/a' });
  });

  it('returns null for an unmapped channel', () => {
    expect(router.resolve('999')).toBeNull();
  });

  it('resolves a thread to its own session using parent project config', () => {
    const result = router.resolve('thread-123', '111');
    expect(result).toEqual({ channelId: 'thread-123', name: 'ProjectA', directory: '/tmp/a' });
  });

  it('returns null when thread parent is also unmapped', () => {
    expect(router.resolve('thread-456', '999')).toBeNull();
  });
});
