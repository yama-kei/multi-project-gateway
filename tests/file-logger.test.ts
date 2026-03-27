import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileWriter, rotateLog } from '../src/file-logger.js';

describe('createFileWriter', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'file-logger-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('creates log directory if it does not exist', () => {
    const logDir = join(tempDir, 'logs');
    const logPath = join(logDir, 'mpg.log');
    const writer = createFileWriter(logPath);
    writer('test line');
    expect(existsSync(logDir)).toBe(true);
  });

  it('writes lines to the log file', () => {
    const logPath = join(tempDir, 'mpg.log');
    const writer = createFileWriter(logPath);
    writer('line 1');
    writer('line 2');
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toBe('line 1\nline 2\n');
  });

  it('appends to existing log file', () => {
    const logPath = join(tempDir, 'mpg.log');
    writeFileSync(logPath, 'existing\n');
    const writer = createFileWriter(logPath);
    writer('new line');
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toBe('existing\nnew line\n');
  });
});

describe('rotateLog', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'file-logger-rotate-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('renames current log to .1', () => {
    const logPath = join(tempDir, 'mpg.log');
    writeFileSync(logPath, 'current content');
    rotateLog(logPath, 5);
    expect(existsSync(logPath)).toBe(false);
    expect(readFileSync(`${logPath}.1`, 'utf-8')).toBe('current content');
  });

  it('shifts existing rotated files', () => {
    const logPath = join(tempDir, 'mpg.log');
    writeFileSync(`${logPath}.1`, 'old-1');
    writeFileSync(logPath, 'current');
    rotateLog(logPath, 5);
    expect(readFileSync(`${logPath}.1`, 'utf-8')).toBe('current');
    expect(readFileSync(`${logPath}.2`, 'utf-8')).toBe('old-1');
  });

  it('removes files beyond maxFiles', () => {
    const logPath = join(tempDir, 'mpg.log');
    writeFileSync(`${logPath}.1`, 'r1');
    writeFileSync(`${logPath}.2`, 'r2');
    writeFileSync(`${logPath}.3`, 'r3');
    writeFileSync(logPath, 'current');
    rotateLog(logPath, 3);
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(`${logPath}.2`)).toBe(true);
    expect(existsSync(`${logPath}.3`)).toBe(true);
    expect(existsSync(`${logPath}.4`)).toBe(false);
  });

  it('does nothing when log file does not exist', () => {
    const logPath = join(tempDir, 'mpg.log');
    expect(() => rotateLog(logPath, 5)).not.toThrow();
  });
});
