import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

export function writePid(pidPath: string, pid: number = process.pid): void {
  writeFileSync(pidPath, `${pid}\n`);
}

export function readPid(pidPath: string): number | undefined {
  try {
    const content = readFileSync(pidPath, 'utf-8').trim();
    const pid = Number(content);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function removePid(pidPath: string): void {
  try {
    unlinkSync(pidPath);
  } catch {
    // Ignore — file may already be gone
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type PidStatus =
  | { status: 'none' }
  | { status: 'running'; pid: number }
  | { status: 'stale'; pid: number };

export function checkPidFile(pidPath: string): PidStatus {
  const pid = readPid(pidPath);
  if (pid === undefined) {
    return { status: 'none' };
  }

  if (isProcessRunning(pid)) {
    return { status: 'running', pid };
  }

  // Stale PID file — remove it
  removePid(pidPath);
  return { status: 'stale', pid };
}
