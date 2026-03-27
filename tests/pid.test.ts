import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writePid, readPid, removePid, isProcessRunning, checkPidFile } from '../src/pid.js';

describe('writePid', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'pid-test-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('writes current PID to file', () => {
    const pidPath = join(tempDir, 'mpg.pid');
    writePid(pidPath);
    const content = readFileSync(pidPath, 'utf-8').trim();
    expect(Number(content)).toBe(process.pid);
  });

  it('writes specified PID to file', () => {
    const pidPath = join(tempDir, 'mpg.pid');
    writePid(pidPath, 12345);
    const content = readFileSync(pidPath, 'utf-8').trim();
    expect(Number(content)).toBe(12345);
  });
});

describe('readPid', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'pid-test-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('returns PID from file', () => {
    const pidPath = join(tempDir, 'mpg.pid');
    writeFileSync(pidPath, '42\n');
    expect(readPid(pidPath)).toBe(42);
  });

  it('returns undefined when file does not exist', () => {
    expect(readPid(join(tempDir, 'nope.pid'))).toBeUndefined();
  });

  it('returns undefined for non-numeric content', () => {
    const pidPath = join(tempDir, 'mpg.pid');
    writeFileSync(pidPath, 'not-a-pid\n');
    expect(readPid(pidPath)).toBeUndefined();
  });
});

describe('removePid', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'pid-test-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('removes the PID file', () => {
    const pidPath = join(tempDir, 'mpg.pid');
    writeFileSync(pidPath, '42\n');
    removePid(pidPath);
    expect(existsSync(pidPath)).toBe(false);
  });

  it('does not throw when file does not exist', () => {
    expect(() => removePid(join(tempDir, 'nope.pid'))).not.toThrow();
  });
});

describe('isProcessRunning', () => {
  it('returns true for current process', () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  it('returns false for non-existent PID', () => {
    expect(isProcessRunning(99999999)).toBe(false);
  });
});

describe('checkPidFile', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'pid-test-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('returns "none" when no PID file exists', () => {
    const pidPath = join(tempDir, 'mpg.pid');
    expect(checkPidFile(pidPath)).toEqual({ status: 'none' });
  });

  it('returns "running" when process is alive', () => {
    const pidPath = join(tempDir, 'mpg.pid');
    writeFileSync(pidPath, `${process.pid}\n`);
    expect(checkPidFile(pidPath)).toEqual({ status: 'running', pid: process.pid });
  });

  it('returns "stale" and removes file when process is dead', () => {
    const pidPath = join(tempDir, 'mpg.pid');
    writeFileSync(pidPath, '99999999\n');
    expect(checkPidFile(pidPath)).toEqual({ status: 'stale', pid: 99999999 });
    expect(existsSync(pidPath)).toBe(false);
  });
});
