import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import type { GatewayConfig } from '../src/config.js';

vi.mock('node:fs');
vi.mock('node:child_process');

const mockStatSync = vi.mocked(fs.statSync);
const mockExecFileSync = vi.mocked(cp.execFileSync);
const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

import { runHealthChecks } from '../src/health.js';

function makeConfig(projects: Record<string, { name: string; directory: string }>): GatewayConfig {
  return {
    defaults: { idleTimeoutMinutes: 1440, maxConcurrentSessions: 4, claudeArgs: [] },
    projects,
  };
}

describe('runHealthChecks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes when claude CLI is found and all directories exist', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

    const config = makeConfig({ '123': { name: 'Proj', directory: '/tmp/proj' } });
    runHealthChecks(config);

    expect(mockExit).not.toHaveBeenCalled();
  });

  it('exits when claude CLI is not found', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

    const config = makeConfig({ '123': { name: 'Proj', directory: '/tmp/proj' } });
    runHealthChecks(config);

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('claude'));
    expect(mockStatSync).not.toHaveBeenCalled();
  });

  it('exits when a project directory does not exist', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });

    const config = makeConfig({ '123': { name: 'Missing', directory: '/no/such/dir' } });
    runHealthChecks(config);

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('Missing'));
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('directory not found'));
  });

  it('exits when path exists but is not a directory', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    mockStatSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);

    const config = makeConfig({ '123': { name: 'NotADir', directory: '/tmp/file.txt' } });
    runHealthChecks(config);

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('NotADir'));
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('not a directory'));
  });

  it('reports all missing directories before exiting', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });

    const config = makeConfig({
      '1': { name: 'ProjA', directory: '/a' },
      '2': { name: 'ProjB', directory: '/b' },
    });
    runHealthChecks(config);

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('ProjA'));
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('ProjB'));
  });
});
