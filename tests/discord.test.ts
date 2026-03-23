import { describe, it, expect } from 'vitest';
import { chunkMessage, handleCommand } from '../src/discord.js';
import type { GatewayConfig } from '../src/config.js';
import type { SessionManager } from '../src/session-manager.js';

const testConfig: GatewayConfig = {
  defaults: { idleTimeoutMs: 1800000, maxConcurrentSessions: 4, claudeArgs: [] },
  projects: {
    'ch-1': { name: 'Alpha', directory: '/tmp/alpha' },
    'ch-2': { name: 'Beta', directory: '/tmp/beta' },
  },
};

function mockSessionManager(sessions: ReturnType<SessionManager['listSessions']> = []): SessionManager {
  const sessionMap = new Map(sessions.map(s => [s.projectKey, s]));
  return {
    send: async () => ({ text: '', sessionId: '', isError: false }),
    getSession: (key) => sessionMap.get(key),
    listSessions: () => sessions,
    clearSession: (key) => sessionMap.delete(key),
    restartSession: (key) => {
      const s = sessionMap.get(key);
      if (!s) return false;
      s.sessionId = '';
      return true;
    },
    shutdown: () => {},
  };
}

describe('chunkMessage', () => {
  it('returns a single chunk for short messages', () => {
    const chunks = chunkMessage('Hello world', 2000);
    expect(chunks).toEqual(['Hello world']);
  });

  it('splits at newline boundaries', () => {
    const line = 'A'.repeat(1500);
    const msg = `${line}\n${'B'.repeat(1500)}`;
    const chunks = chunkMessage(msg, 2000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(line);
    expect(chunks[1]).toBe('B'.repeat(1500));
  });

  it('force-splits lines longer than the limit', () => {
    const msg = 'A'.repeat(4500);
    const chunks = chunkMessage(msg, 2000);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(2000);
    expect(chunks[1]).toHaveLength(2000);
    expect(chunks[2]).toHaveLength(500);
  });

  it('handles empty string', () => {
    expect(chunkMessage('', 2000)).toEqual(['']);
  });
});

describe('handleCommand', () => {
  it('returns null for non-command messages', () => {
    const sm = mockSessionManager();
    expect(handleCommand('hello world', testConfig, sm)).toBeNull();
  });

  it('lists sessions with !sessions', () => {
    const sm = mockSessionManager([
      { sessionId: 'abc12345-long-id', projectKey: 'ch-1', lastActivity: Date.now() - 60000, queueLength: 0 },
    ]);
    const result = handleCommand('!sessions', testConfig, sm);
    expect(result).toContain('Active sessions (1)');
    expect(result).toContain('Alpha');
    expect(result).toContain('abc12345');
  });

  it('shows no sessions message', () => {
    const sm = mockSessionManager();
    const result = handleCommand('!sessions', testConfig, sm);
    expect(result).toBe('No active sessions.');
  });

  it('inspects a session with !session', () => {
    const sm = mockSessionManager([
      { sessionId: 'sid-123', projectKey: 'ch-1', lastActivity: Date.now() - 5000, queueLength: 2 },
    ]);
    const result = handleCommand('!session Alpha', testConfig, sm);
    expect(result).toContain('Alpha');
    expect(result).toContain('sid-123');
    expect(result).toContain('Queue depth: 2');
  });

  it('returns error for unknown project in !session', () => {
    const sm = mockSessionManager();
    const result = handleCommand('!session NoSuch', testConfig, sm);
    expect(result).toContain('No project found');
  });

  it('kills a session with !kill', () => {
    const sm = mockSessionManager([
      { sessionId: 'sid-1', projectKey: 'ch-1', lastActivity: Date.now(), queueLength: 0 },
    ]);
    const result = handleCommand('!kill Alpha', testConfig, sm);
    expect(result).toContain('cleared');
  });

  it('restarts a session with !restart', () => {
    const sm = mockSessionManager([
      { sessionId: 'sid-1', projectKey: 'ch-1', lastActivity: Date.now(), queueLength: 0 },
    ]);
    const result = handleCommand('!restart Alpha', testConfig, sm);
    expect(result).toContain('restarted');
    expect(result).toContain('fresh context');
  });

  it('returns error for unknown project in !restart', () => {
    const sm = mockSessionManager();
    const result = handleCommand('!restart NoSuch', testConfig, sm);
    expect(result).toContain('No project found');
  });

  it('returns no session message for !restart with no active session', () => {
    const sm = mockSessionManager();
    const result = handleCommand('!restart Alpha', testConfig, sm);
    expect(result).toContain('no active session to restart');
  });

  it('shows help with !help', () => {
    const sm = mockSessionManager();
    const result = handleCommand('!help', testConfig, sm);
    expect(result).toContain('!sessions');
    expect(result).toContain('!kill');
    expect(result).toContain('!restart');
  });

  it('shows current thread session with !session (no args) in a thread', () => {
    const sm = mockSessionManager([
      { sessionId: 'thread-sid-abc', projectKey: 'thread-99', lastActivity: Date.now() - 3000, queueLength: 1 },
    ]);
    const result = handleCommand('!session', testConfig, sm, {
      channelId: 'thread-99',
      projectName: 'Alpha',
      isThread: true,
    });
    expect(result).toContain('Alpha');
    expect(result).toContain('(thread)');
    expect(result).toContain('thread-sid-abc');
    expect(result).toContain('Queue depth: 1');
  });

  it('shows no active session for !session (no args) in a thread with no session', () => {
    const sm = mockSessionManager();
    const result = handleCommand('!session', testConfig, sm, {
      channelId: 'thread-99',
      projectName: 'Alpha',
      isThread: true,
    });
    expect(result).toContain('no active session in this thread');
  });

  it('shows current channel session with !session (no args) in a main channel', () => {
    const sm = mockSessionManager([
      { sessionId: 'ch-sid-xyz', projectKey: 'ch-1', lastActivity: Date.now(), queueLength: 0 },
    ]);
    const result = handleCommand('!session', testConfig, sm, {
      channelId: 'ch-1',
      projectName: 'Alpha',
      isThread: false,
    });
    expect(result).toContain('Alpha');
    expect(result).not.toContain('(thread)');
    expect(result).toContain('ch-sid-xyz');
  });

  it('falls back to usage hint for !session (no args) without context', () => {
    const sm = mockSessionManager();
    const result = handleCommand('!session', testConfig, sm);
    expect(result).toContain('!session <project name>');
  });
});
