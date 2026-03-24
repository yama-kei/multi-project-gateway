import { describe, it, expect } from 'vitest';
import { createThreadLinkRegistry } from '../src/thread-links.js';

describe('createThreadLinkRegistry', () => {
  it('returns null for unlinked threads', () => {
    const registry = createThreadLinkRegistry();
    expect(registry.getLinkedThread('thread-a')).toBeNull();
  });

  it('creates a link between two threads', () => {
    const registry = createThreadLinkRegistry();
    const link = registry.link('thread-a', 'thread-b', 'pm');
    expect(link.sourceThread).toBe('thread-a');
    expect(link.targetThread).toBe('thread-b');
    expect(link.sourceChannel).toBe('pm');
    expect(link.turnCount).toBe(0);
  });

  it('retrieves linked thread from source side', () => {
    const registry = createThreadLinkRegistry();
    registry.link('thread-a', 'thread-b', 'pm');
    const link = registry.getLinkedThread('thread-a');
    expect(link).not.toBeNull();
    expect(link!.targetThread).toBe('thread-b');
  });

  it('retrieves linked thread from target side (bidirectional)', () => {
    const registry = createThreadLinkRegistry();
    registry.link('thread-a', 'thread-b', 'pm');
    const link = registry.getLinkedThread('thread-b');
    expect(link).not.toBeNull();
    expect(link!.sourceThread).toBe('thread-a');
  });

  it('records turns and increments counter', () => {
    const registry = createThreadLinkRegistry();
    registry.link('thread-a', 'thread-b', 'pm');
    expect(registry.recordTurn('thread-a', 'thread-b')).toBe(1);
    expect(registry.recordTurn('thread-a', 'thread-b')).toBe(2);
    expect(registry.recordTurn('thread-b', 'thread-a')).toBe(3);
  });

  it('checks over-limit correctly', () => {
    const registry = createThreadLinkRegistry();
    registry.link('thread-a', 'thread-b', 'pm');
    registry.recordTurn('thread-a', 'thread-b');
    registry.recordTurn('thread-a', 'thread-b');
    expect(registry.isOverLimit('thread-a', 'thread-b', 3)).toBe(false);
    registry.recordTurn('thread-a', 'thread-b');
    expect(registry.isOverLimit('thread-a', 'thread-b', 3)).toBe(true);
  });

  it('resets pair turn counter', () => {
    const registry = createThreadLinkRegistry();
    registry.link('thread-a', 'thread-b', 'pm');
    registry.recordTurn('thread-a', 'thread-b');
    registry.recordTurn('thread-a', 'thread-b');
    registry.resetPair('thread-a', 'thread-b');
    expect(registry.isOverLimit('thread-a', 'thread-b', 3)).toBe(false);
    expect(registry.recordTurn('thread-a', 'thread-b')).toBe(1);
  });

  it('resetPair works from either side of the pair', () => {
    const registry = createThreadLinkRegistry();
    registry.link('thread-a', 'thread-b', 'pm');
    registry.recordTurn('thread-a', 'thread-b');
    registry.recordTurn('thread-a', 'thread-b');
    registry.resetPair('thread-b', 'thread-a');
    expect(registry.recordTurn('thread-a', 'thread-b')).toBe(1);
  });

  it('isOverLimit returns false for unlinked threads', () => {
    const registry = createThreadLinkRegistry();
    expect(registry.isOverLimit('x', 'y', 5)).toBe(false);
  });
});
