import { execFileSync } from 'node:child_process';

const TIMEOUT = 10_000;

/**
 * Check whether tmux is available on the system.
 * Throws a descriptive error if not installed.
 */
export function ensureTmux(): void {
  try {
    execFileSync('tmux', ['-V'], { timeout: TIMEOUT, stdio: 'pipe' });
  } catch {
    throw new Error(
      'tmux is not installed or not on PATH. Install tmux to use persistent sessions (e.g. `apt install tmux`).',
    );
  }
}

/**
 * Create a detached tmux session running the given shell command.
 */
export function createSession(name: string, command: string, opts?: { cwd?: string }): void {
  ensureTmux();
  execFileSync('tmux', ['new-session', '-d', '-s', name, command], {
    cwd: opts?.cwd,
    timeout: TIMEOUT,
    stdio: 'pipe',
  });
}

/**
 * Check whether a named tmux session exists.
 */
export function sessionExists(name: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', name], {
      timeout: TIMEOUT,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * List tmux sessions whose names start with the given prefix.
 * Returns an array of full session names.
 */
export function listSessions(prefix: string): string[] {
  try {
    const raw = execFileSync('tmux', ['ls', '-F', '#{session_name}'], {
      timeout: TIMEOUT,
      stdio: 'pipe',
    }).toString();
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith(prefix));
  } catch {
    // tmux ls fails if no server is running (no sessions) — that's fine
    return [];
  }
}

/**
 * Kill a named tmux session.
 */
export function killSession(name: string): void {
  try {
    execFileSync('tmux', ['kill-session', '-t', name], {
      timeout: TIMEOUT,
      stdio: 'pipe',
    });
  } catch {
    // Session may already be dead — safe to ignore
  }
}
