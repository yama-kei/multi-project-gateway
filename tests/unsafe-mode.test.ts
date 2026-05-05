import { describe, it, expect } from 'vitest';
import { createUnsafeRegistry, UNSAFE_MODE_EXTRA_ARGS } from '../src/unsafe-mode.js';

describe('createUnsafeRegistry', () => {
  it('starts with no enabled channels', () => {
    const reg = createUnsafeRegistry();
    expect(reg.isEnabled('chan-1')).toBe(false);
    expect(reg.list()).toEqual([]);
  });

  it('enables a channel', () => {
    const reg = createUnsafeRegistry();
    reg.enable('chan-1');
    expect(reg.isEnabled('chan-1')).toBe(true);
  });

  it('disables a previously enabled channel', () => {
    const reg = createUnsafeRegistry();
    reg.enable('chan-1');
    reg.disable('chan-1');
    expect(reg.isEnabled('chan-1')).toBe(false);
  });

  it('isolates channels from each other', () => {
    const reg = createUnsafeRegistry();
    reg.enable('chan-1');
    expect(reg.isEnabled('chan-1')).toBe(true);
    expect(reg.isEnabled('chan-2')).toBe(false);
  });

  it('list() returns all enabled channels', () => {
    const reg = createUnsafeRegistry();
    reg.enable('chan-1');
    reg.enable('chan-2');
    expect(reg.list().sort()).toEqual(['chan-1', 'chan-2']);
  });

  it('disabling a non-enabled channel is a no-op', () => {
    const reg = createUnsafeRegistry();
    expect(() => reg.disable('chan-x')).not.toThrow();
    expect(reg.isEnabled('chan-x')).toBe(false);
  });

  it('enabling the same channel twice is idempotent', () => {
    const reg = createUnsafeRegistry();
    reg.enable('chan-1');
    reg.enable('chan-1');
    expect(reg.list()).toEqual(['chan-1']);
  });
});

describe('UNSAFE_MODE_EXTRA_ARGS', () => {
  it('uses --permission-mode bypassPermissions to escalate the session', () => {
    expect(UNSAFE_MODE_EXTRA_ARGS).toEqual(['--permission-mode', 'bypassPermissions']);
  });
});
