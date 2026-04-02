import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';

vi.mock('../src/tmux.js', () => ({
  ensureTmux: vi.fn(),
  createSession: vi.fn(),
  sessionExists: vi.fn(),
  listSessions: vi.fn().mockReturnValue([]),
  killSession: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    statSync: vi.fn(),
    rmSync: vi.fn(),
    watch: vi.fn().mockReturnValue({ close: vi.fn() }),
  };
});

import { TmuxRuntime } from '../src/runtimes/tmux-runtime.js';
import { ensureTmux, createSession, sessionExists, listSessions, killSession } from '../src/tmux.js';
import type { SpawnOpts } from '../src/agent-runtime.js';

const mockCreateSession = vi.mocked(createSession);
const mockSessionExists = vi.mocked(sessionExists);
const mockListSessions = vi.mocked(listSessions);
const mockKillSession = vi.mocked(killSession);
const mockMkdirSync = vi.mocked(fs.mkdirSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockRmSync = vi.mocked(fs.rmSync);

const validOutput = JSON.stringify({
  result: 'Hello from tmux',
  session_id: 'tmux-session-123',
  is_error: false,
  total_cost_usd: 0.01,
});

describe('TmuxRuntime', () => {
  let runtime: TmuxRuntime;

  beforeEach(() => {
    vi.resetAllMocks();
    // Ensure ensureTmux is a no-op so constructor doesn't try real tmux
    vi.mocked(ensureTmux).mockImplementation(() => {});
    // Default: sessionExists returns false after first check (session exited)
    mockSessionExists.mockReturnValue(false);
    mockListSessions.mockReturnValue([]);
    runtime = new TmuxRuntime();
  });

  describe('constructor', () => {
    it('calls ensureTmux on construction', () => {
      expect(vi.mocked(ensureTmux)).toHaveBeenCalled();
    });

    it('throws if tmux is not installed', () => {
      vi.mocked(ensureTmux).mockImplementation(() => { throw new Error('tmux is not installed'); });
      expect(() => new TmuxRuntime()).toThrow(/tmux is not installed/);
    });
  });

  describe('spawn', () => {
    const spawnOpts: SpawnOpts = {
      cwd: '/tmp/project',
      baseArgs: ['--permission-mode', 'acceptEdits', '--output-format', 'json'],
      prompt: 'Fix the bug',
      sessionId: 'test-session',
      systemPrompt: undefined,
      timeoutMs: 5000,
    };

    it('creates output directory and launches tmux session with timeout wrapper', async () => {
      // Session exits immediately, output file exists with valid JSON
      mockSessionExists.mockReturnValue(false);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(validOutput);

      const result = await runtime.spawn(spawnOpts);

      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('mpg-sessions'),
        { recursive: true },
      );
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.stringMatching(/^mpg-/),
        expect.stringContaining('run.sh'),
        expect.objectContaining({ cwd: '/tmp/project' }),
      );
      expect(result.text).toBe('Hello from tmux');
      expect(result.sessionId).toBe('tmux-session-123');

      // Verify script contains timeout wrapper: timeoutMs=5000 + 5min buffer = 305s
      const scriptContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(scriptContent).toMatch(/^#!\/bin\/sh\ntimeout 305 claude /);
    });

    it('uses default timeout (20min + 5min buffer = 1500s) when timeoutMs is omitted', async () => {
      mockSessionExists.mockReturnValue(false);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(validOutput);

      await runtime.spawn({ ...spawnOpts, timeoutMs: undefined });

      const scriptContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(scriptContent).toMatch(/^#!\/bin\/sh\ntimeout 1500 claude /);
    });

    it('kills stale tmux session before launching new one', async () => {
      // First call: session exists (stale), then after kill it doesn't
      mockSessionExists
        .mockReturnValueOnce(true) // pre-launch check: stale session exists
        .mockReturnValue(false);   // post-launch: session has exited
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(validOutput);

      await runtime.spawn(spawnOpts);

      expect(mockKillSession).toHaveBeenCalledWith(expect.stringMatching(/^mpg-/));
    });

    it('rejects with timeout error when CLI hangs', async () => {
      // Session never exits
      mockSessionExists.mockReturnValue(true);

      const opts = { ...spawnOpts, timeoutMs: 200 };
      await expect(runtime.spawn(opts)).rejects.toThrow(/timed out/i);
      expect(mockKillSession).toHaveBeenCalled();
    }, 5000);

    it('rejects with friendly error when only stderr is produced', async () => {
      mockSessionExists.mockReturnValue(false);
      mockExistsSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith('stderr.log')) return true;
        return false; // output.json doesn't exist
      });
      mockReadFileSync.mockReturnValue('API Error: Rate limit reached');

      await expect(runtime.spawn(spawnOpts)).rejects.toThrow(/usage limit reached/);
    });

    it('rejects when no output is produced', async () => {
      mockSessionExists.mockReturnValue(false);
      mockExistsSync.mockReturnValue(false);

      await expect(runtime.spawn(spawnOpts)).rejects.toThrow(/no output/i);
    });
  });

  describe('listOrphanedSessions', () => {
    it('returns session keys from tmux session names', async () => {
      mockListSessions.mockReturnValue(['mpg-thread-123', 'mpg-thread-456']);
      const result = await runtime.listOrphanedSessions();
      expect(result).toEqual(['thread-123', 'thread-456']);
      expect(mockListSessions).toHaveBeenCalledWith('mpg-');
    });

    it('returns empty array when no sessions exist', async () => {
      mockListSessions.mockReturnValue([]);
      const result = await runtime.listOrphanedSessions();
      expect(result).toEqual([]);
    });
  });

  describe('reattach', () => {
    it('reads output file when session has already finished', async () => {
      mockSessionExists.mockReturnValue(false);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(validOutput);

      const result = await runtime.reattach('test-session');
      expect(result.text).toBe('Hello from tmux');
      expect(result.sessionId).toBe('tmux-session-123');
    });

    it('throws when session is gone and no output file exists', async () => {
      mockSessionExists.mockReturnValue(false);
      mockExistsSync.mockReturnValue(false);

      await expect(runtime.reattach('missing-session')).rejects.toThrow(/does not exist/);
    });
  });

  describe('cleanup', () => {
    it('kills tmux session and removes temp directory', () => {
      runtime.cleanup('test-session');
      expect(mockKillSession).toHaveBeenCalledWith(expect.stringMatching(/^mpg-/));
      expect(mockRmSync).toHaveBeenCalledWith(
        expect.stringContaining('mpg-sessions'),
        { recursive: true, force: true },
      );
    });
  });
});
