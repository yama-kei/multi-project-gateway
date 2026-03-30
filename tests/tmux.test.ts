import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as cp from 'node:child_process';

vi.mock('node:child_process');

const mockExecFileSync = vi.mocked(cp.execFileSync);

import { ensureTmux, createSession, sessionExists, listSessions, killSession } from '../src/tmux.js';

describe('tmux helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ensureTmux', () => {
    it('does not throw when tmux is available', () => {
      mockExecFileSync.mockReturnValue(Buffer.from('tmux 3.4'));
      expect(() => ensureTmux()).not.toThrow();
      expect(mockExecFileSync).toHaveBeenCalledWith('tmux', ['-V'], expect.objectContaining({ timeout: 10000, stdio: 'pipe' }));
    });

    it('throws descriptive error when tmux is not installed', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      expect(() => ensureTmux()).toThrow(/tmux is not installed/);
    });
  });

  describe('createSession', () => {
    it('creates a detached tmux session with the given command', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''));
      createSession('mpg-test', 'echo hello', { cwd: '/tmp' });
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['new-session', '-d', '-s', 'mpg-test', 'echo hello'],
        expect.objectContaining({ cwd: '/tmp', timeout: 10000, stdio: 'pipe' }),
      );
    });

    it('calls ensureTmux before creating session', () => {
      // First call is ensureTmux (-V), second is new-session
      mockExecFileSync.mockReturnValue(Buffer.from(''));
      createSession('mpg-test', 'echo hello');
      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
      expect(mockExecFileSync.mock.calls[0][1]).toEqual(['-V']);
    });
  });

  describe('sessionExists', () => {
    it('returns true when session exists', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''));
      expect(sessionExists('mpg-test')).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['has-session', '-t', 'mpg-test'],
        expect.objectContaining({ timeout: 10000 }),
      );
    });

    it('returns false when session does not exist', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('no session'); });
      expect(sessionExists('mpg-missing')).toBe(false);
    });
  });

  describe('listSessions', () => {
    it('returns sessions matching the prefix', () => {
      mockExecFileSync.mockReturnValue(Buffer.from('mpg-abc\nmpg-def\nother-session\n'));
      const result = listSessions('mpg-');
      expect(result).toEqual(['mpg-abc', 'mpg-def']);
    });

    it('returns empty array when no tmux server running', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('no server running'); });
      expect(listSessions('mpg-')).toEqual([]);
    });

    it('returns empty array when no sessions match', () => {
      mockExecFileSync.mockReturnValue(Buffer.from('other-session\n'));
      expect(listSessions('mpg-')).toEqual([]);
    });
  });

  describe('killSession', () => {
    it('kills the named session', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''));
      killSession('mpg-test');
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['kill-session', '-t', 'mpg-test'],
        expect.objectContaining({ timeout: 10000 }),
      );
    });

    it('does not throw when session does not exist', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('no session'); });
      expect(() => killSession('mpg-missing')).not.toThrow();
    });
  });
});
