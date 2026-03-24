import { describe, it, expect } from 'vitest';
import { createAgentTracker } from '../src/agent-tracker.js';

describe('createAgentTracker', () => {
  it('returns false for untracked message IDs', () => {
    const tracker = createAgentTracker();
    expect(tracker.isAgentMessage('unknown-id')).toBe(false);
  });

  it('returns true for tracked message IDs', () => {
    const tracker = createAgentTracker();
    tracker.track('msg-1');
    expect(tracker.isAgentMessage('msg-1')).toBe(true);
  });

  it('deletes entry after isAgentMessage returns true (one-time use)', () => {
    const tracker = createAgentTracker();
    tracker.track('msg-1');
    expect(tracker.isAgentMessage('msg-1')).toBe(true);
    expect(tracker.isAgentMessage('msg-1')).toBe(false);
  });

  it('tracks multiple messages independently', () => {
    const tracker = createAgentTracker();
    tracker.track('msg-1');
    tracker.track('msg-2');
    expect(tracker.isAgentMessage('msg-1')).toBe(true);
    expect(tracker.isAgentMessage('msg-2')).toBe(true);
    expect(tracker.isAgentMessage('msg-1')).toBe(false);
    expect(tracker.isAgentMessage('msg-2')).toBe(false);
  });

  it('returns false for untracked cross-post IDs', () => {
    const tracker = createAgentTracker();
    expect(tracker.isCrossPost('unknown-id')).toBe(false);
  });

  it('returns true for tracked cross-post IDs and deletes (one-time use)', () => {
    const tracker = createAgentTracker();
    tracker.trackCrossPost('msg-1');
    expect(tracker.isCrossPost('msg-1')).toBe(true);
    expect(tracker.isCrossPost('msg-1')).toBe(false);
  });

  it('agent messages and cross-posts are independent sets', () => {
    const tracker = createAgentTracker();
    tracker.track('msg-1');
    tracker.trackCrossPost('msg-2');
    expect(tracker.isAgentMessage('msg-1')).toBe(true);
    expect(tracker.isCrossPost('msg-1')).toBe(false);
    expect(tracker.isCrossPost('msg-2')).toBe(true);
    expect(tracker.isAgentMessage('msg-2')).toBe(false);
  });
});
