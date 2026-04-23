import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSessionManager, type SessionManager } from '../src/session-manager.js';
import type { SessionStore, PersistedSession } from '../src/session-store.js';
import type { AgentRuntime, SpawnOpts } from '../src/agent-runtime.js';
import type { ClaudeResult } from '../src/claude-cli.js';

vi.mock('../src/worktree.js', () => ({
  createWorktree: vi.fn().mockReturnValue('/tmp/a/.worktrees/thread-1'),
  removeWorktree: vi.fn(),
  listWorktrees: vi.fn().mockReturnValue([]),
  worktreePath: vi.fn((dir: string, key: string) => `${dir}/.worktrees/${key}`),
}));

/** Spy-able mock runtime that wraps a vi.fn() for spawn. */
function createMockRuntime(): AgentRuntime & { spawn: ReturnType<typeof vi.fn<(opts: SpawnOpts) => Promise<ClaudeResult>>> } {
  return {
    name: 'mock',
    canResume: false,
    spawn: vi.fn<(opts: SpawnOpts) => Promise<ClaudeResult>>().mockResolvedValue({
      text: 'Mock response',
      sessionId: 'mock-session-id',
      isError: false,
    }),
    async listOrphanedSessions() { return []; },
    async reattach() { throw new Error('not implemented'); },
  };
}

/** Mock runtime with canResume=true and spyable reattach/listOrphanedSessions/cleanup. */
function createResumableRuntime() {
  return {
    name: 'mock-tmux',
    canResume: true,
    spawn: vi.fn<(opts: SpawnOpts) => Promise<ClaudeResult>>().mockResolvedValue({
      text: 'Mock response',
      sessionId: 'mock-session-id',
      isError: false,
    }),
    listOrphanedSessions: vi.fn<() => Promise<string[]>>().mockResolvedValue([]),
    reattach: vi.fn<(key: string) => Promise<ClaudeResult>>().mockResolvedValue({
      text: 'Reattached response',
      sessionId: 'reattached-sid',
      isError: false,
    }),
    cleanup: vi.fn(),
  };
}

const defaults = {
  idleTimeoutMs: 500,
  maxConcurrentSessions: 2,
  claudeArgs: ['--permission-mode', 'acceptEdits', '--output-format', 'json'],
  maxTurnsPerAgent: 5,
  agentTimeoutMs: 180000,
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
  let mockRuntime: ReturnType<typeof createMockRuntime>;

  beforeEach(async () => {
    mockRuntime = createMockRuntime();
    const { createWorktree, removeWorktree } = await import('../src/worktree.js');
    vi.mocked(createWorktree).mockReset();
    vi.mocked(createWorktree).mockReturnValue('/tmp/a/.worktrees/thread-1');
    vi.mocked(removeWorktree).mockReset();
    manager = createSessionManager(defaults, mockRuntime);
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
    let resolveFirst: (v: any) => void;
    mockRuntime.spawn.mockImplementationOnce(() => new Promise(r => { resolveFirst = r; }));
    mockRuntime.spawn.mockResolvedValueOnce({ text: 'Second', sessionId: 'sid-2', isError: false });

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
    mockRuntime.spawn.mockResolvedValueOnce({ text: 'First', sessionId: 'sid-1', isError: false });
    await manager.send('project-a', '/tmp/a', 'Hello');
    expect(manager.getSession('project-a')?.sessionId).toBe('sid-1');

    mockRuntime.spawn.mockRejectedValueOnce(new Error('claude exited with code 1'));
    mockRuntime.spawn.mockResolvedValueOnce({ text: 'Recovered', sessionId: 'sid-2', isError: false });

    const result = await manager.send('project-a', '/tmp/a', 'Try again');
    expect(result.text).toBe('Recovered');
    expect(result.sessionReset).toBe(true);
    expect(manager.getSession('project-a')?.sessionId).toBe('sid-2');
  });

  it('enforces global concurrency limit', async () => {
    const resolvers: Array<(v: any) => void> = [];
    mockRuntime.spawn.mockImplementation(() => new Promise(r => { resolvers.push(r); }));

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
    mockRuntime.spawn.mockResolvedValueOnce({ text: 'First', sessionId: 'sid-1', isError: false });
    await manager.send('project-a', '/tmp/a', 'Hello');
    expect(manager.getSession('project-a')?.sessionId).toBe('sid-1');

    // Claude returns a different session ID without erroring
    mockRuntime.spawn.mockResolvedValueOnce({ text: 'Different context', sessionId: 'sid-2', isError: false });
    const result = await manager.send('project-a', '/tmp/a', 'Continue');
    expect(result.sessionChanged).toBe(true);
    expect(result.text).toBe('Different context');
    expect(manager.getSession('project-a')?.sessionId).toBe('sid-2');
  });

  it('does not flag sessionChanged when session ID stays the same', async () => {
    mockRuntime.spawn.mockResolvedValueOnce({ text: 'First', sessionId: 'sid-1', isError: false });
    await manager.send('project-a', '/tmp/a', 'Hello');

    mockRuntime.spawn.mockResolvedValueOnce({ text: 'Second', sessionId: 'sid-1', isError: false });
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

  it('passes system prompt to runtime.spawn', async () => {
    const rt = createMockRuntime();
    const sm = createSessionManager(defaults, rt);
    await sm.send('proj-1', '/tmp/proj', 'hello', { systemPrompt: 'You are a PM.' });
    expect(rt.spawn).toHaveBeenCalledWith({
      cwd: '/tmp/proj',
      baseArgs: defaults.claudeArgs,
      prompt: 'hello',
      sessionId: undefined,
      systemPrompt: 'You are a PM.',
      timeoutMs: undefined,
      projectKey: 'proj-1',
    });
    sm.shutdown();
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
      const m = createSessionManager(defaults, mockRuntime, store);
      const session = m.getSession('proj-x');
      expect(session).toBeDefined();
      expect(session!.sessionId).toBe('restored-sid');
      m.shutdown();
    });

    it('persists sessions to store after send', async () => {
      const store = createMockStore();
      const m = createSessionManager(defaults, mockRuntime, store);
      await m.send('proj-a', '/tmp/a', 'Hello');
      expect(store.saved).not.toBeNull();
      expect(store.saved!.get('proj-a')?.sessionId).toBe('mock-session-id');
      m.shutdown();
    });

    it('persists sessions on shutdown', async () => {
      const store = createMockStore();
      const m = createSessionManager(defaults, mockRuntime, store);
      await m.send('proj-a', '/tmp/a', 'Hello');
      store.saved = null;
      m.shutdown();
      expect(store.saved).not.toBeNull();
    });

    it('resumes Claude with restored session ID', async () => {
      const rt = createMockRuntime();
      const store = createMockStore([
        { sessionId: 'old-sid', projectKey: 'proj-a', cwd: '/tmp/a', lastActivity: Date.now() - 1000 },
      ]);
      const m = createSessionManager(defaults, rt, store);

      await m.send('proj-a', '/tmp/a', 'Continue');
      expect(rt.spawn).toHaveBeenCalledWith({
        cwd: '/tmp/a',
        baseArgs: defaults.claudeArgs,
        prompt: 'Continue',
        sessionId: 'old-sid',
        systemPrompt: undefined,
        timeoutMs: undefined,
        projectKey: 'proj-a',
      });
      m.shutdown();
    });

    it('keeps session on disk after idle cleanup', async () => {
      const store = createMockStore();
      const m = createSessionManager(defaults, mockRuntime, store);
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
      const rt = createMockRuntime();
      const store = createMockStore();
      const m = createSessionManager(defaults, rt, store);

      // First message creates session
      rt.spawn.mockResolvedValueOnce({ text: 'First', sessionId: 'sid-1', isError: false });
      await m.send('proj-a', '/tmp/a', 'Hello');

      // Wait for idle cleanup
      await new Promise(r => setTimeout(r, 600));
      expect(m.getSession('proj-a')).toBeUndefined();

      // New message should resume with the persisted session ID
      rt.spawn.mockResolvedValueOnce({ text: 'Resumed', sessionId: 'sid-1', isError: false });
      const result = await m.send('proj-a', '/tmp/a', 'Back again');
      expect(result.text).toBe('Resumed');
      expect(rt.spawn).toHaveBeenLastCalledWith({
        cwd: '/tmp/a',
        baseArgs: defaults.claudeArgs,
        prompt: 'Back again',
        sessionId: 'sid-1',
        systemPrompt: undefined,
        timeoutMs: undefined,
        projectKey: 'proj-a',
      });
      m.shutdown();
    });
  });

  describe('worktree sessions', () => {
    it('creates a worktree when worktree option is true', async () => {
      const { createWorktree } = await import('../src/worktree.js');
      const mockCreate = vi.mocked(createWorktree);

      mockCreate.mockReturnValue('/tmp/a/.worktrees/thread-1');

      await manager.send('thread-1', '/tmp/a', 'Hello', { worktree: true });

      expect(mockCreate).toHaveBeenCalledWith('/tmp/a', 'thread-1');
      expect(mockRuntime.spawn).toHaveBeenCalledWith({
        cwd: '/tmp/a/.worktrees/thread-1',
        baseArgs: defaults.claudeArgs,
        prompt: 'Hello',
        sessionId: undefined,
        systemPrompt: undefined,
        timeoutMs: undefined,
        projectKey: 'thread-1',
      });
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
      const mockCreate = vi.mocked(createWorktree);

      await manager.send('project-a', '/tmp/a', 'Hello');

      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockRuntime.spawn).toHaveBeenCalledWith({
        cwd: '/tmp/a',
        baseArgs: defaults.claudeArgs,
        prompt: 'Hello',
        sessionId: undefined,
        systemPrompt: undefined,
        timeoutMs: undefined,
        projectKey: 'project-a',
      });
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
      const m = createSessionManager(defaults, mockRuntime, store);
      await m.send('thread-1', '/tmp/a', 'Hello', { worktree: true });

      expect(store.saved!.get('thread-1')?.worktreePath).toBe('/tmp/a/.worktrees/thread-1');
      m.shutdown();
    });
  });

  describe('pulse event emission', () => {
    let pulseEmitter: {
      sessionStart: ReturnType<typeof vi.fn>;
      sessionEnd: ReturnType<typeof vi.fn>;
      sessionIdle: ReturnType<typeof vi.fn>;
      sessionResume: ReturnType<typeof vi.fn>;
      messageRouted: ReturnType<typeof vi.fn>;
      messageCompleted: ReturnType<typeof vi.fn>;
      agentHandoff: ReturnType<typeof vi.fn>;
    };
    let pulseManager: SessionManager;

    let pulseRuntime: ReturnType<typeof createMockRuntime>;

    beforeEach(() => {
      pulseRuntime = createMockRuntime();
      pulseEmitter = {
        sessionStart: vi.fn(),
        sessionEnd: vi.fn(),
        sessionIdle: vi.fn(),
        sessionResume: vi.fn(),
        messageRouted: vi.fn(),
        messageCompleted: vi.fn(),
        agentHandoff: vi.fn(),
      };
      pulseManager = createSessionManager(defaults, pulseRuntime, undefined, pulseEmitter);
    });

    afterEach(() => {
      pulseManager.shutdown();
    });

    it('emits session_start on first message to a project', async () => {
      await pulseManager.send('project-a', '/tmp/a', 'Hello');
      expect(pulseEmitter.sessionStart).toHaveBeenCalledOnce();
      expect(pulseEmitter.sessionStart).toHaveBeenCalledWith(
        expect.any(String), 'project-a', '/tmp/a', expect.objectContaining({ triggerSource: 'discord' }),
      );
    });

    it('emits session_start with agentName when project key contains agent', async () => {
      await pulseManager.send('thread-1:engineer', '/tmp/a', 'Hello');
      expect(pulseEmitter.sessionStart).toHaveBeenCalledWith(
        expect.any(String), 'thread-1:engineer', '/tmp/a',
        expect.objectContaining({ agentName: 'engineer', triggerSource: 'discord' }),
      );
    });

    it('emits session_start without agentName for plain project keys', async () => {
      await pulseManager.send('project-a', '/tmp/a', 'Hello');
      expect(pulseEmitter.sessionStart).toHaveBeenCalledWith(
        expect.any(String), 'project-a', '/tmp/a',
        expect.objectContaining({ agentName: undefined, triggerSource: 'discord' }),
      );
    });

    it('emits message_routed on each dispatched message', async () => {
      await pulseManager.send('project-a', '/tmp/a', 'Hello');
      expect(pulseEmitter.messageRouted).toHaveBeenCalledOnce();
      expect(pulseEmitter.messageRouted).toHaveBeenCalledWith(
        expect.any(String), 'project-a', '/tmp/a', expect.objectContaining({ queueDepth: expect.any(Number) }),
      );
    });

    it('does not emit session_start on subsequent messages to same project', async () => {
      await pulseManager.send('project-a', '/tmp/a', 'Hello');
      await pulseManager.send('project-a', '/tmp/a', 'World');
      expect(pulseEmitter.sessionStart).toHaveBeenCalledOnce();
      expect(pulseEmitter.messageRouted).toHaveBeenCalledTimes(2);
    });

    it('emits session_end on clearSession', async () => {
      await pulseManager.send('project-a', '/tmp/a', 'Hello');
      pulseManager.clearSession('project-a');
      expect(pulseEmitter.sessionEnd).toHaveBeenCalledOnce();
      expect(pulseEmitter.sessionEnd).toHaveBeenCalledWith(
        'mock-session-id', 'project-a', '/tmp/a', expect.any(Number), 1,
      );
    });

    it('emits session_idle when idle timer fires', async () => {
      await pulseManager.send('project-a', '/tmp/a', 'Hello');
      // Wait for idle timeout (500ms in test defaults)
      await new Promise(r => setTimeout(r, 600));
      expect(pulseEmitter.sessionIdle).toHaveBeenCalledOnce();
      expect(pulseEmitter.sessionIdle).toHaveBeenCalledWith(
        'mock-session-id', 'project-a', '/tmp/a', expect.any(Number), 1,
      );
    });

    it('emits session_resume when restoring a persisted session', async () => {
      const store = createMockStore([{
        sessionId: 'old-session',
        projectKey: 'project-a',
        cwd: '/tmp/a',
        lastActivity: Date.now() - 60000,
      }]);
      const resumeManager = createSessionManager(defaults, pulseRuntime, store, pulseEmitter);
      await resumeManager.send('project-a', '/tmp/a', 'Hello');
      expect(pulseEmitter.sessionResume).toHaveBeenCalledOnce();
      expect(pulseEmitter.sessionResume).toHaveBeenCalledWith(
        'old-session', 'project-a', '/tmp/a', expect.any(Number),
      );
      // Should NOT emit session_start for restored sessions
      expect(pulseEmitter.sessionStart).not.toHaveBeenCalled();
      resumeManager.shutdown();
    });

    it('emits message_completed after successful spawn with usage data', async () => {
      pulseRuntime.spawn.mockResolvedValue({
        text: 'Mock response',
        sessionId: 'mock-session-id',
        isError: false,
        usage: {
          input_tokens: 15000,
          output_tokens: 3200,
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 8000,
          total_cost_usd: 0.042,
          duration_ms: 45000,
          duration_api_ms: 38000,
          num_turns: 12,
          model: 'claude-sonnet-4-20250514',
        },
      });

      await pulseManager.send('project-a', '/tmp/a', 'Hello');
      expect(pulseEmitter.messageCompleted).toHaveBeenCalledOnce();
      expect(pulseEmitter.messageCompleted).toHaveBeenCalledWith(
        expect.any(String),
        'project-a',
        '/tmp/a',
        expect.objectContaining({
          input_tokens: 15000,
          output_tokens: 3200,
          total_cost_usd: 0.042,
        }),
        expect.objectContaining({ agentTarget: undefined }),
      );
    });

    it('does not emit message_completed when usage is absent', async () => {
      await pulseManager.send('project-a', '/tmp/a', 'Hello');
      expect(pulseEmitter.messageCompleted).not.toHaveBeenCalled();
    });

    it('emitHandoff emits agent_handoff pulse event', async () => {
      await pulseManager.send('thread-1:pm', '/tmp/a', 'Hello');
      pulseManager.emitHandoff('thread-1:engineer', '/tmp/a', {
        fromAgent: 'pm',
        toAgent: 'engineer',
        threadId: 'thread-1',
      });
      expect(pulseEmitter.agentHandoff).toHaveBeenCalledOnce();
      expect(pulseEmitter.agentHandoff).toHaveBeenCalledWith(
        expect.any(String), 'thread-1:engineer', '/tmp/a',
        { fromAgent: 'pm', toAgent: 'engineer', threadId: 'thread-1' },
      );
    });
  });

  describe('session pruning', () => {
    it('prunes sessions older than TTL on startup', () => {
      const now = Date.now();
      const store = createMockStore([
        { sessionId: 'fresh', projectKey: 'fresh', cwd: '/tmp/a', lastActivity: now - 1000 },
        { sessionId: 'stale', projectKey: 'stale', cwd: '/tmp/b', lastActivity: now - 8 * 24 * 60 * 60 * 1000 },
      ]);
      const m = createSessionManager({ ...defaults, sessionTtlMs: 7 * 24 * 60 * 60 * 1000 }, mockRuntime, store);
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
      const m = createSessionManager({ ...defaults, maxPersistedSessions: 3 }, mockRuntime, store);
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
      const m = createSessionManager({ ...defaults, sessionTtlMs: 7 * 24 * 60 * 60 * 1000 }, mockRuntime, store);
      // The stale entry was pruned on startup; now send a message to trigger persistSessions
      await m.send('new-proj', '/tmp/new', 'Hello');
      expect(store.saved!.has('old-proj')).toBe(false);
      expect(store.saved!.has('new-proj')).toBe(true);
      m.shutdown();
    });
  });

  describe('orphan session recovery', () => {
    function mockCallbacks() {
      return { onStart: vi.fn(), onResult: vi.fn(), onError: vi.fn() };
    }

    it('skips recovery when runtime does not support resume', async () => {
      const rt = createMockRuntime(); // canResume=false
      const m = createSessionManager(defaults, rt);
      const cb = mockCallbacks();
      await m.recoverOrphanedSessions(cb);
      expect(cb.onStart).not.toHaveBeenCalled();
      expect(cb.onResult).not.toHaveBeenCalled();
      m.shutdown();
    });

    it('cleans up unmatched orphan sessions (no persisted record)', async () => {
      const rt = createResumableRuntime();
      rt.listOrphanedSessions.mockResolvedValue(['unknown-key']);
      const store = createMockStore(); // empty — no persisted sessions
      const m = createSessionManager(defaults, rt, store);
      const cb = mockCallbacks();
      await m.recoverOrphanedSessions(cb);
      expect(rt.cleanup).toHaveBeenCalledWith('unknown-key');
      expect(rt.reattach).not.toHaveBeenCalled();
      expect(cb.onStart).not.toHaveBeenCalled();
      expect(cb.onResult).not.toHaveBeenCalled();
      m.shutdown();
    });

    it('calls onStart before reattach and onResult after', async () => {
      const rt = createResumableRuntime();
      rt.listOrphanedSessions.mockResolvedValue(['thread-123']);
      const callOrder: string[] = [];
      rt.reattach.mockImplementation(async () => {
        callOrder.push('reattach');
        return { text: 'Orphan output', sessionId: 'orphan-sid', isError: false };
      });
      const store = createMockStore([
        { sessionId: 'old-sid', projectKey: 'thread-123', cwd: '/tmp/proj', lastActivity: Date.now() - 5000 },
      ]);
      const m = createSessionManager(defaults, rt, store);
      const cb = {
        onStart: vi.fn(() => callOrder.push('onStart')),
        onResult: vi.fn(() => callOrder.push('onResult')),
      };
      await m.recoverOrphanedSessions(cb);
      expect(callOrder).toEqual(['onStart', 'reattach', 'onResult']);
      expect(cb.onStart).toHaveBeenCalledWith('thread-123');
      expect(cb.onResult).toHaveBeenCalledWith('thread-123', expect.objectContaining({ text: 'Orphan output' }));
      expect(rt.cleanup).toHaveBeenCalledWith('thread-123');
      m.shutdown();
    });

    it('registers recovered session as processing and visible in listSessions', async () => {
      const rt = createResumableRuntime();
      rt.listOrphanedSessions.mockResolvedValue(['thread-123']);
      const store = createMockStore([
        { sessionId: 'old-sid', projectKey: 'thread-123', cwd: '/tmp/proj', lastActivity: Date.now() - 5000 },
      ]);
      const m = createSessionManager(defaults, rt, store);
      let sessionDuringReattach: ReturnType<typeof m.getSession> | undefined;
      rt.reattach.mockImplementation(async () => {
        sessionDuringReattach = m.getSession('thread-123');
        return { text: 'Done', sessionId: 'new-sid', isError: false };
      });
      await m.recoverOrphanedSessions(mockCallbacks());
      // During reattach, session should be visible and processing
      expect(sessionDuringReattach).toBeDefined();
      expect(sessionDuringReattach!.processing).toBe(true);
      expect(sessionDuringReattach!.sessionId).toBe('old-sid');
      m.shutdown();
    });

    it('restores sessionId after successful recovery', async () => {
      const rt = createResumableRuntime();
      rt.listOrphanedSessions.mockResolvedValue(['thread-123']);
      rt.reattach.mockResolvedValue({ text: 'Done', sessionId: 'new-sid', isError: false });
      const store = createMockStore([
        { sessionId: 'old-sid', projectKey: 'thread-123', cwd: '/tmp/proj', lastActivity: Date.now() - 5000 },
      ]);
      const m = createSessionManager(defaults, rt, store);
      await m.recoverOrphanedSessions(mockCallbacks());
      // After recovery, session should have updated sessionId and not be processing
      const session = m.getSession('thread-123');
      expect(session).toBeDefined();
      expect(session!.sessionId).toBe('new-sid');
      expect(session!.processing).toBe(false);
      m.shutdown();
    });

    it('emits session_resume for reattached orphans', async () => {
      const rt = createResumableRuntime();
      rt.listOrphanedSessions.mockResolvedValue(['thread-456']);
      const store = createMockStore([
        { sessionId: 'sid-456', projectKey: 'thread-456', cwd: '/tmp/proj', lastActivity: Date.now() - 10000 },
      ]);
      const pulseEmitter = {
        sessionStart: vi.fn(),
        sessionEnd: vi.fn(),
        sessionIdle: vi.fn(),
        sessionResume: vi.fn(),
        messageRouted: vi.fn(),
        messageCompleted: vi.fn(),
        agentHandoff: vi.fn(),
      };
      const m = createSessionManager(defaults, rt, store, pulseEmitter);
      await m.recoverOrphanedSessions(mockCallbacks());
      expect(pulseEmitter.sessionResume).toHaveBeenCalledWith(
        'sid-456', 'thread-456', '/tmp/proj', expect.any(Number),
      );
      m.shutdown();
    });

    it('handles reattach failure gracefully and fires onError', async () => {
      const rt = createResumableRuntime();
      rt.listOrphanedSessions.mockResolvedValue(['thread-789']);
      rt.reattach.mockRejectedValue(new Error('output file missing'));
      const store = createMockStore([
        { sessionId: 'sid-789', projectKey: 'thread-789', cwd: '/tmp/proj', lastActivity: Date.now() - 5000 },
      ]);
      const m = createSessionManager(defaults, rt, store);
      const cb = mockCallbacks();
      // Should not throw
      await m.recoverOrphanedSessions(cb);
      expect(cb.onStart).toHaveBeenCalledWith('thread-789');
      expect(cb.onResult).not.toHaveBeenCalled();
      expect(cb.onError).toHaveBeenCalledWith('thread-789', expect.objectContaining({ message: 'output file missing' }));
      expect(rt.cleanup).toHaveBeenCalledWith('thread-789');
      // Session should not be processing after failure
      const session = m.getSession('thread-789');
      expect(session).toBeDefined();
      expect(session!.processing).toBe(false);
      m.shutdown();
    });

    it('processes multiple orphans concurrently', async () => {
      const rt = createResumableRuntime();
      rt.listOrphanedSessions.mockResolvedValue(['t-1', 't-2', 't-unknown']);
      rt.reattach.mockImplementation(async (key: string) => ({
        text: `Result for ${key}`,
        sessionId: `sid-${key}`,
        isError: false,
      }));
      const store = createMockStore([
        { sessionId: 'old-1', projectKey: 't-1', cwd: '/tmp/a', lastActivity: Date.now() - 1000 },
        { sessionId: 'old-2', projectKey: 't-2', cwd: '/tmp/b', lastActivity: Date.now() - 2000 },
      ]);
      const m = createSessionManager(defaults, rt, store);
      const cb = mockCallbacks();
      await m.recoverOrphanedSessions(cb);
      // t-1 and t-2 reattached, t-unknown cleaned up
      expect(rt.reattach).toHaveBeenCalledTimes(2);
      expect(cb.onStart).toHaveBeenCalledTimes(2);
      expect(cb.onResult).toHaveBeenCalledTimes(2);
      expect(rt.cleanup).toHaveBeenCalledWith('t-unknown'); // unmatched
      expect(rt.cleanup).toHaveBeenCalledWith('t-1'); // post-reattach
      expect(rt.cleanup).toHaveBeenCalledWith('t-2'); // post-reattach
      m.shutdown();
    });
  });
});
