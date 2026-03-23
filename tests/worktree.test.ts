import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as cp from 'node:child_process';

vi.mock('node:child_process');

const mockExecFileSync = vi.mocked(cp.execFileSync);

import { createWorktree, removeWorktree, listWorktrees, reconcileWorktrees } from '../src/worktree.js';

describe('createWorktree', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs git worktree add with branch named after projectKey', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    const result = createWorktree('/repo', 'thread-abc');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '-b', 'mpg/thread-abc', '/repo/.worktrees/thread-abc'],
      { cwd: '/repo', timeout: 10000 },
    );
    expect(result).toBe('/repo/.worktrees/thread-abc');
  });

  it('reuses existing worktree if branch already exists', () => {
    mockExecFileSync
      .mockImplementationOnce(() => { throw new Error('already exists'); })
      .mockReturnValueOnce(Buffer.from(''));
    const result = createWorktree('/repo', 'thread-abc');
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(mockExecFileSync).toHaveBeenLastCalledWith(
      'git',
      ['worktree', 'add', '/repo/.worktrees/thread-abc', 'mpg/thread-abc'],
      { cwd: '/repo', timeout: 10000 },
    );
    expect(result).toBe('/repo/.worktrees/thread-abc');
  });

  it('re-throws non-"already exists" errors', () => {
    mockExecFileSync.mockImplementationOnce(() => { throw new Error('permission denied'); });
    expect(() => createWorktree('/repo', 'thread-abc')).toThrow('permission denied');
  });

  it('rejects invalid projectKey characters', () => {
    expect(() => createWorktree('/repo', '../escape')).toThrow('Invalid projectKey');
    expect(() => createWorktree('/repo', 'foo/bar')).toThrow('Invalid projectKey');
  });
});

describe('removeWorktree', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs git worktree remove --force', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    removeWorktree('/repo', 'thread-abc');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', '/repo/.worktrees/thread-abc'],
      { cwd: '/repo', timeout: 10000 },
    );
  });

  it('does not throw if worktree does not exist', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not a working tree'); });
    expect(() => removeWorktree('/repo', 'thread-abc')).not.toThrow();
  });
});

describe('listWorktrees', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses git worktree list --porcelain output', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(
      'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n' +
      'worktree /repo/.worktrees/thread-1\nHEAD def456\nbranch refs/heads/mpg/thread-1\n\n'
    ));
    const result = listWorktrees('/repo');
    expect(result).toEqual([
      { path: '/repo', branch: 'refs/heads/main' },
      { path: '/repo/.worktrees/thread-1', branch: 'refs/heads/mpg/thread-1' },
    ]);
  });

  it('returns empty array on error', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not a git repo'); });
    expect(listWorktrees('/repo')).toEqual([]);
  });
});

describe('reconcileWorktrees', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes worktrees with mpg/ prefix not in known sessions', () => {
    mockExecFileSync
      // listWorktrees call
      .mockReturnValueOnce(Buffer.from(
        'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n' +
        'worktree /repo/.worktrees/thread-1\nHEAD def\nbranch refs/heads/mpg/thread-1\n\n' +
        'worktree /repo/.worktrees/thread-2\nHEAD ghi\nbranch refs/heads/mpg/thread-2\n\n'
      ))
      // removeWorktree call for thread-2
      .mockReturnValue(Buffer.from(''));

    reconcileWorktrees('/repo', new Set(['thread-1']));

    // Should only remove thread-2 (thread-1 is known)
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', '/repo/.worktrees/thread-2'],
      expect.any(Object),
    );
    expect(mockExecFileSync).toHaveBeenCalledTimes(2); // list + 1 remove
  });

  it('does nothing when all worktrees are known', () => {
    mockExecFileSync.mockReturnValueOnce(Buffer.from(
      'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n' +
      'worktree /repo/.worktrees/thread-1\nHEAD def\nbranch refs/heads/mpg/thread-1\n\n'
    ));

    reconcileWorktrees('/repo', new Set(['thread-1']));

    expect(mockExecFileSync).toHaveBeenCalledTimes(1); // list only
  });
});
