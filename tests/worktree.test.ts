import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as cp from 'node:child_process';

vi.mock('node:child_process');

const mockExecFileSync = vi.mocked(cp.execFileSync);

import { createWorktree, removeWorktree, listWorktrees } from '../src/worktree.js';

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
    // Falls back to git worktree add without -b (reuse existing branch)
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(result).toBe('/repo/.worktrees/thread-abc');
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
