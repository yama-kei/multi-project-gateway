import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const WORKTREE_DIR = '.worktrees';
const BRANCH_PREFIX = 'mpg/';
const TIMEOUT = 10_000;

export function worktreePath(projectDir: string, projectKey: string): string {
  return join(projectDir, WORKTREE_DIR, projectKey);
}

export function createWorktree(projectDir: string, projectKey: string): string {
  const wtPath = worktreePath(projectDir, projectKey);
  const branch = `${BRANCH_PREFIX}${projectKey}`;
  try {
    execFileSync('git', ['worktree', 'add', '-b', branch, wtPath], {
      cwd: projectDir,
      timeout: TIMEOUT,
    });
  } catch {
    // Branch may already exist (previous session) — attach without creating branch
    execFileSync('git', ['worktree', 'add', wtPath, branch], {
      cwd: projectDir,
      timeout: TIMEOUT,
    });
  }
  return wtPath;
}

export function removeWorktree(projectDir: string, projectKey: string): void {
  const wtPath = worktreePath(projectDir, projectKey);
  try {
    execFileSync('git', ['worktree', 'remove', '--force', wtPath], {
      cwd: projectDir,
      timeout: TIMEOUT,
    });
  } catch {
    // Already removed or not a worktree — safe to ignore
  }
}

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export function listWorktrees(projectDir: string): WorktreeInfo[] {
  try {
    const raw = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: projectDir,
      timeout: TIMEOUT,
    }).toString();

    const entries: WorktreeInfo[] = [];
    let currentPath = '';
    let currentBranch = '';

    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice('worktree '.length);
      } else if (line.startsWith('branch ')) {
        currentBranch = line.slice('branch '.length);
      } else if (line === '') {
        if (currentPath) {
          entries.push({ path: currentPath, branch: currentBranch });
        }
        currentPath = '';
        currentBranch = '';
      }
    }
    return entries;
  } catch {
    return [];
  }
}

export function reconcileWorktrees(projectDir: string, knownKeys: Set<string>): void {
  const worktrees = listWorktrees(projectDir);
  for (const wt of worktrees) {
    if (!wt.branch.startsWith(`refs/heads/${BRANCH_PREFIX}`)) continue;
    const key = wt.branch.slice(`refs/heads/${BRANCH_PREFIX}`.length);
    if (!knownKeys.has(key)) {
      removeWorktree(projectDir, key);
    }
  }
}
