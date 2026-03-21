import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSessionManager, type SessionManager } from '../src/session-manager.js';

vi.mock('../src/claude-cli.js', () => ({
  runClaude: vi.fn().mockResolvedValue({
    text: 'Mock response',
    sessionId: 'mock-session-id',
    isError: false,
  }),
  parseClaudeJsonOutput: vi.fn(),
  buildClaudeArgs: vi.fn(),
}));

const defaults = {
  idleTimeoutMs: 500,
  maxConcurrentSessions: 2,
  claudeArgs: ['--dangerously-skip-permissions', '--output-format', 'json'],
};

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

  it('lists active sessions', async () => {
    await manager.send('project-a', '/tmp/a', 'Hello');
    await manager.send('project-b', '/tmp/b', 'Hello');
    const sessions = manager.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map(s => s.projectKey)).toContain('project-a');
    expect(sessions.map(s => s.projectKey)).toContain('project-b');
  });
});
