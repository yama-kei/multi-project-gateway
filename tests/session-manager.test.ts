import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSessionManager, type SessionManager } from '../src/session-manager.js';
import type { SessionStore, PersistedSession } from '../src/session-store.js';

vi.mock('../src/claude-cli.js', () => ({
  runClaude: vi.fn().mockResolvedValue({
    text: 'Mock response',
    sessionId: 'mock-session-id',
    isError: false,
  }),
  parseClaudeJsonOutput: vi.fn(),
  buildClaudeArgs: vi.fn(),
}));

vi.mock('../src/worktree.js', () => ({
  createWorktree: vi.fn().mockReturnValue('/tmp/a/.worktrees/thread-1'),
  removeWorktree: vi.fn(),
  listWorktrees: vi.fn().mockReturnValue([]),
  worktreePath: vi.fn((dir: string, key: string) => `${dir}/.worktrees/${key}`),
}));

const defaults = {
  idleTimeoutMs: 500,
  maxConcurrentSessions: 2,
  claudeArgs: ['--permission-mode', 'acceptEdits', '--output-format', 'json'],
};

function createMockStore(initial: PersistedSession[] = []): SessionStore & { saved: Map<string, PersistedSession> | null } {
  let data = new Map<string, PersistedSession>();
  for (const entry of initial) {
    data.set(entry.projectKey, entry);
  }
  return {
    saved: null,
    load() { return new Map(data); },
    save(sessions) {
      this.saved = new Map(sessions);
      data = new Map(sessions);
    },
  };
}

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(async () => {
    const { runClaude } = await import('../src/claude-cli.js');
    vi.mocked(runClaude).mockReset();
    vi.mocked(runClaude).mockResolvedValue({
      text: 'Mock response',
      sessionId: 'mock-session-id',
      isError: false,
    });
    const { createWorktree, removeWorktree } = await import('../src/worktree.js');
    vi.mocked(createWorktree).mockReset();
    vi.mocked(createWorktree).mockReturnValue('/tmp/a/.worktrees/thread-1');
    vi.mocked(removeWorktree).mockReset();
    manager = createSessionManager(defaults);
  });

  afterEach(() => {
    manager.shutdown();
  });

  it('sends a message and returns the response', async () => {
    const result = await manager.send('project-a', '/tmp/a', 'Hello');
    expect(result.text).toBe('Mock response');
    expect(result.isError).toBe(false);
  });

  it('tracks session ID after first message', async () => {
    await manager.send('project-a', '/tmp/a', 'Hello');
    const session = manager.getSession('project-a');
    expect(session).toBeDefined();
    expect(session!.sessionId).toBe('mock-session-id');
  });

  it('queues concurrent messages to the same project', async () => {
    const { runClaude } = await import('../src/claude-cli.js');
    const mockRun = vi.mocked(runClaude);

    let resolveFirst: (v: any) => void;
    mockRun.mockImplementationOnce(() => new Promise(r => { resolveFirst = r; }));
    mockRun.mockResolvedValueOnce({ text: 'Second', sessionId: 'sid-2', isError: false });

    const first = manager.send('project-a', '/tmp/a', 'First');
    const second = manager.send('project-a', '/tmp/a', 'Second');

    // Wait a tick for the mock implementation to be called and assign resolveFirst
    await new Promise(r => setTimeout(r, 10));

    expect(manager.getSession('project-a')?.queueLength).toBe(1);

    resolveFirst!({ text: 'First', sessionId: 'sid-1', isError: false });
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.text).toBe('First');
    expect(r2.text).toBe('Second');
  });

  it('clears session after idle timeout', async () => {
    await manager.send('project-a', '/tmp/a', 'Hello');
    expect(manager.getSession('project-a')).toBeDefined();

    await new Promise(r => setTimeout(r, 600));
    expect(manager.getSession('project-a')).toBeUndefined();
  });

  it('retries without session ID when resume fails', async () => {
    const { runClaude } = await import('../src/claude-cli.js');
    const mockRun = vi.mocked(runClaude);

    mockRun.mockResolvedValueOnce({ text: 'First', sessionId: 'sid-1', isError: false });
    await manager.send('project-a', '/tmp/a', 'Hello');
    expect(manager.getSession('project-a')?.sessionId).toBe('sid-1');

    mockRun.mockRejectedValueOnce(new Error('claude exited with code 1'));
    mockRun.mockResolvedValueOnce({ text: 'Recovered', sessionId: 'sid-2', isError: false });

    const result = await manager.send('project-a', '/tmp/a', 'Try again');
    expect(result.text).toBe('Recovered');
    expect(result.sessionReset).toBe(true);
    expect(manager.getSession('project-a')?.sessionId).toBe('sid-2');
  });

  it('enforces global concurrency limit', async () => {
    const { runClaude } = await import('../src/claude-cli.js');
    const mockRun = vi.mocked(runClaude);

    const resolvers: Array<(v: any) => void> = [];
    mockRun.mockImplementation(() => new Promise(r => { resolvers.push(r); }));

    const p1 = manager.send('project-a', '/tmp/a', 'A');
    const p2 = manager.send('project-b', '/tmp/b', 'B');
    const p3 = manager.send('project-c', '/tmp/c', 'C');

    await new Promise(r => setTimeout(r, 10));

    expect(resolvers).toHaveLength(2);

    resolvers[0]({ text: 'A done', sessionId: 'sid-a', isError: false });
    await new Promise(r => setTimeout(r, 10));
    expect(resolvers).toHaveLength(3);

    resolvers[1]({ text: 'B done', sessionId: 'sid-b', isError: false });
    resolvers[2]({ text: 'C done', sessionId: 'sid-c', isError: false });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.text).toBe('A done');
    expect(r2.text).toBe('B done');
    expect(r3.text).toBe('C done');
  });

  it('detects silent session ID change', async () => {
    const { runClaude } = await import('../src/claude-cli.js');
    const mockRun = vi.mocked(runClaude);

    mockRun.mockResolvedValueOnce({ text: 'First', sessionId: 'sid-1', isError: false });
    await manager.send('project-a', '/tmp/a', 'Hello');
    expect(manager.getSession('project-a')?.sessionId).toBe('sid-1');

    // Claude returns a different session ID without erroring
    mockRun.mockResolvedValueOnce({ text: 'Different context', sessionId: 'sid-2', isError: false });
    const result = await manager.send('project-a', '/tmp/a', 'Continue');
    expect(result.sessionChanged).toBe(true);
    expect(result.text).toBe('Different context');
    expect(manager.getSession('project-a')?.sessionId).toBe('sid-2');
  });

  it('does not flag sessionChanged when session ID stays the same', async () => {
    const { runClaude } = await import('../src/claude-cli.js');
    const mockRun = vi.mocked(runClaude);

    mockRun.mockResolvedValueOnce({ text: 'First', sessionId: 'sid-1', isError: false });
    await manager.send('project-a', '/tmp/a', 'Hello');

    mockRun.mockResolvedValueOnce({ text: 'Second', sessionId: 'sid-1', isError: false });
    const result = await manager.send('project-a', '/tmp/a', 'Continue');
    expect(result.sessionChanged).toBeUndefined();
  });

  it('restarts a session (clears session ID, keeps session)', async () => {
    await manager.send('project-a', '/tmp/a', 'Hello');
    expect(manager.getSession('project-a')?.sessionId).toBe('mock-session-id');

    expect(manager.restartSession('project-a')).toBe(true);
    const session = manager.getSession('project-a');
    expect(session).toBeDefined();
    expect(session!.sessionId).toBe('');
  });

  it('returns false when restarting a non-existent session', () => {
    expect(manager.restartSession('no-such-project')).toBe(false);
  });

  it('clears a specific session', async () => {
    await manager.send('project-a', '/tmp/a', 'Hello');
    expect(manager.getSession('project-a')).toBeDefined();
    expect(manager.clearSession('project-a')).toBe(true);
    expect(manager.getSession('project-a')).toBeUndefined();
  });

  it('returns false when clearing a non-existent session', () => {
    expect(manager.clearSession('no-such-project')).toBe(false);
  });

  it('lists active sessions', async () => {
    await manager.send('project-a', '/tmp/a', 'Hello');
    await manager.send('project-b', '/tmp/b', 'Hello');
    const sessions = manager.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map(s => s.projectKey)).toContain('project-a');
    expect(sessions.map(s => s.projectKey)).toContain('project-b');
  });

  describe('session persistence', () => {
    it('restores sessions from store on creation', () => {
      const store = createMockStore([
        { sessionId: 'restored-sid', projectKey: 'proj-x', cwd: '/tmp/x', lastActivity: Date.now() - 1000 },
      ]);
      const m = createSessionManager(defaults, store);
      const session = m.getSession('proj-x');
      expect(session).toBeDefined();
      expect(session!.sessionId).toBe('restored-sid');
      m.shutdown();
    });

    it('persists sessions to store after send', async () => {
      const store = createMockStore();
      const m = createSessionManager(defaults, store);
      await m.send('proj-a', '/tmp/a', 'Hello');
      expect(store.saved).not.toBeNull();
      expect(store.saved!.get('proj-a')?.sessionId).toBe('mock-session-id');
      m.shutdown();
    });

    it('persists sessions on shutdown', async () => {
      const store = createMockStore();
      const m = createSessionManager(defaults, store);
      await m.send('proj-a', '/tmp/a', 'Hello');
      store.saved = null;
      m.shutdown();
      expect(store.saved).not.toBeNull();
    });

    it('resumes Claude with restored session ID', async () => {
      const { runClaude } = await import('../src/claude-cli.js');
      const mockRun = vi.mocked(runClaude);

      const store = createMockStore([
        { sessionId: 'old-sid', projectKey: 'proj-a', cwd: '/tmp/a', lastActivity: Date.now() - 1000 },
      ]);
      const m = createSessionManager(defaults, store);

      await m.send('proj-a', '/tmp/a', 'Continue');
      expect(mockRun).toHaveBeenCalledWith('/tmp/a', defaults.claudeArgs, 'Continue', 'old-sid', undefined);
      m.shutdown();
    });

    it('keeps session on disk after idle cleanup', async () => {
      const store = createMockStore();
      const m = createSessionManager(defaults, store);
      await m.send('proj-a', '/tmp/a', 'Hello');

      // Session is in memory and on disk
      expect(m.getSession('proj-a')).toBeDefined();
      expect(store.saved!.get('proj-a')?.sessionId).toBe('mock-session-id');

      // After idle timeout, removed from memory but still on disk
      await new Promise(r => setTimeout(r, 600));
      expect(m.getSession('proj-a')).toBeUndefined();
      expect(store.saved!.get('proj-a')?.sessionId).toBe('mock-session-id');
      m.shutdown();
    });

    it('resumes session from disk after idle cleanup', async () => {
      const { runClaude } = await import('../src/claude-cli.js');
      const mockRun = vi.mocked(runClaude);

      const store = createMockStore();
      const m = createSessionManager(defaults, store);

      // First message creates session
      mockRun.mockResolvedValueOnce({ text: 'First', sessionId: 'sid-1', isError: false });
      await m.send('proj-a', '/tmp/a', 'Hello');

      // Wait for idle cleanup
      await new Promise(r => setTimeout(r, 600));
      expect(m.getSession('proj-a')).toBeUndefined();

      // New message should resume with the persisted session ID
      mockRun.mockResolvedValueOnce({ text: 'Resumed', sessionId: 'sid-1', isError: false });
      const result = await m.send('proj-a', '/tmp/a', 'Back again');
      expect(result.text).toBe('Resumed');
      expect(mockRun).toHaveBeenLastCalledWith('/tmp/a', defaults.claudeArgs, 'Back again', 'sid-1', undefined);
      m.shutdown();
    });
  });

  describe('worktree sessions', () => {
    it('creates a worktree when worktree option is true', async () => {
      const { createWorktree } = await import('../src/worktree.js');
      const { runClaude } = await import('../src/claude-cli.js');
      const mockCreate = vi.mocked(createWorktree);
      const mockRun = vi.mocked(runClaude);

      mockCreate.mockReturnValue('/tmp/a/.worktrees/thread-1');

      await manager.send('thread-1', '/tmp/a', 'Hello', { worktree: true });

      expect(mockCreate).toHaveBeenCalledWith('/tmp/a', 'thread-1');
      expect(mockRun).toHaveBeenCalledWith(
        '/tmp/a/.worktrees/thread-1',
        defaults.claudeArgs,
        'Hello',
        undefined,
        undefined,
      );
    });

    it('reuses existing worktree for subsequent messages', async () => {
      const { createWorktree } = await import('../src/worktree.js');
      const mockCreate = vi.mocked(createWorktree);
      mockCreate.mockReturnValue('/tmp/a/.worktrees/thread-1');

      await manager.send('thread-1', '/tmp/a', 'First', { worktree: true });
      await manager.send('thread-1', '/tmp/a', 'Second', { worktree: true });

      // createWorktree called only once — session reuses cached worktree path
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('does not create worktree when option is absent', async () => {
      const { createWorktree } = await import('../src/worktree.js');
      const { runClaude } = await import('../src/claude-cli.js');
      const mockCreate = vi.mocked(createWorktree);
      const mockRun = vi.mocked(runClaude);

      await manager.send('project-a', '/tmp/a', 'Hello');

      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockRun).toHaveBeenCalledWith('/tmp/a', defaults.claudeArgs, 'Hello', undefined, undefined);
    });

    it('removes worktree on clearSession', async () => {
      const { createWorktree, removeWorktree } = await import('../src/worktree.js');
      const mockCreate = vi.mocked(createWorktree);
      const mockRemove = vi.mocked(removeWorktree);
      mockCreate.mockReturnValue('/tmp/a/.worktrees/thread-1');

      await manager.send('thread-1', '/tmp/a', 'Hello', { worktree: true });
      manager.clearSession('thread-1');

      expect(mockRemove).toHaveBeenCalledWith('/tmp/a', 'thread-1');
    });

    it('persists worktreePath to store', async () => {
      const { createWorktree } = await import('../src/worktree.js');
      vi.mocked(createWorktree).mockReturnValue('/tmp/a/.worktrees/thread-1');

      const store = createMockStore();
      const m = createSessionManager(defaults, store);
      await m.send('thread-1', '/tmp/a', 'Hello', { worktree: true });

      expect(store.saved!.get('thread-1')?.worktreePath).toBe('/tmp/a/.worktrees/thread-1');
      m.shutdown();
    });
  });

  describe('session pruning', () => {
    it('prunes sessions older than TTL on startup', () => {
      const now = Date.now();
      const store = createMockStore([
        { sessionId: 'fresh', projectKey: 'fresh', cwd: '/tmp/a', lastActivity: now - 1000 },
        { sessionId: 'stale', projectKey: 'stale', cwd: '/tmp/b', lastActivity: now - 8 * 24 * 60 * 60 * 1000 },
      ]);
      const m = createSessionManager({ ...defaults, sessionTtlMs: 7 * 24 * 60 * 60 * 1000 }, store);
      expect(m.getSession('fresh')).toBeDefined();
      expect(m.getSession('stale')).toBeUndefined();
      expect(store.saved!.has('stale')).toBe(false);
      m.shutdown();
    });

    it('enforces max persisted sessions cap on startup', () => {
      const now = Date.now();
      const entries = Array.from({ length: 5 }, (_, i) => ({
        sessionId: `sid-${i}`,
        projectKey: `proj-${i}`,
        cwd: `/tmp/${i}`,
        lastActivity: now - (5 - i) * 1000, // proj-0 oldest, proj-4 newest
      }));
      const store = createMockStore(entries);
      const m = createSessionManager({ ...defaults, maxPersistedSessions: 3 }, store);
      // Should keep the 3 newest: proj-2, proj-3, proj-4
      expect(m.getSession('proj-0')).toBeUndefined();
      expect(m.getSession('proj-1')).toBeUndefined();
      expect(m.getSession('proj-2')).toBeDefined();
      expect(m.getSession('proj-3')).toBeDefined();
      expect(m.getSession('proj-4')).toBeDefined();
      m.shutdown();
    });

    it('prunes during persistSessions', async () => {
      const now = Date.now();
      const store = createMockStore([
        { sessionId: 'old', projectKey: 'old-proj', cwd: '/tmp/old', lastActivity: now - 8 * 24 * 60 * 60 * 1000 },
      ]);
      const m = createSessionManager({ ...defaults, sessionTtlMs: 7 * 24 * 60 * 60 * 1000 }, store);
      // The stale entry was pruned on startup; now send a message to trigger persistSessions
      await m.send('new-proj', '/tmp/new', 'Hello');
      expect(store.saved!.has('old-proj')).toBe(false);
      expect(store.saved!.has('new-proj')).toBe(true);
      m.shutdown();
    });
  });
});
