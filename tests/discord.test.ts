import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chunkMessage, handleCommand } from '../src/discord.js';
import type { GatewayConfig, AgentConfig } from '../src/config.js';
import type { SessionManager } from '../src/session-manager.js';
import { parseAgentMention, parseHandoffCommand } from '../src/agent-dispatch.js';
import { createTurnCounter } from '../src/turn-counter.js';
import { buildHandoffEmbed } from '../src/embed-format.js';
import { createUnsafeRegistry } from '../src/unsafe-mode.js';

const testConfig: GatewayConfig = {
  defaults: { idleTimeoutMs: 1800000, maxConcurrentSessions: 4, claudeArgs: [], sessionTtlMs: 604800000, maxPersistedSessions: 50, maxTurnsPerAgent: 5, agentTimeoutMs: 180000 },
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

const configWithAgents: GatewayConfig = {
  defaults: { idleTimeoutMs: 1800000, maxConcurrentSessions: 4, claudeArgs: [], sessionTtlMs: 604800000, maxPersistedSessions: 50, maxTurnsPerAgent: 5, agentTimeoutMs: 180000 },
  projects: {
    'ch-1': {
      name: 'my-app',
      directory: '/tmp/app',
      agents: {
        pm: { role: 'Product Manager', prompt: 'You manage requirements.' },
        engineer: { role: 'Engineer', prompt: 'You write code.' },
      },
    },
  },
};

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

  it('lists agents with !agents in a project with agents', () => {
    const sm = mockSessionManager();
    const result = handleCommand('!agents', configWithAgents, sm, {
      channelId: 'ch-1',
      projectName: 'my-app',
      isThread: false,
    });
    expect(result).toContain('my-app');
    expect(result).toContain('`pm`');
    expect(result).toContain('Product Manager');
    expect(result).toContain('`engineer`');
    expect(result).toContain('Engineer');
  });

  it('lists agents with !agents from a thread (thread channelId differs from project key)', () => {
    const sm = mockSessionManager();
    const result = handleCommand('!agents', configWithAgents, sm, {
      channelId: 'thread-123',
      projectName: 'my-app',
      isThread: true,
    });
    expect(result).toContain('my-app');
    expect(result).toContain('`pm`');
    expect(result).toContain('`engineer`');
  });

  it('returns no agents message for project without agents', () => {
    const sm = mockSessionManager();
    const result = handleCommand('!agents', testConfig, sm, {
      channelId: 'ch-1',
      projectName: 'Alpha',
      isThread: false,
    });
    expect(result).toContain('No agents configured');
  });

  it('returns usage hint for !agents without context', () => {
    const sm = mockSessionManager();
    const result = handleCommand('!agents', configWithAgents, sm);
    expect(result).toContain('!agents');
  });

  it('includes !agents in !help output', () => {
    const sm = mockSessionManager();
    const result = handleCommand('!help', testConfig, sm);
    expect(result).toContain('!agents');
  });

  it('includes !ask in !help output', () => {
    const sm = mockSessionManager();
    const result = handleCommand('!help', testConfig, sm);
    expect(result).toContain('!ask');
    expect(result).toContain('dispatch a message to a named agent');
  });

  it('!agents output shows !ask dispatch syntax', () => {
    const sm = mockSessionManager();
    const result = handleCommand('!agents', configWithAgents, sm, {
      channelId: 'ch-1',
      projectName: 'my-app',
      isThread: false,
    });
    expect(result).toContain('!ask');
    expect(result).toContain('pm');
    expect(result).toContain('engineer');
  });

  // --- !unsafe / !safe (#235, #239) ---

  it('!unsafe arms a pending escalation and asks for confirmation (no state change)', () => {
    const sm = mockSessionManager();
    const unsafe = createUnsafeRegistry();
    const result = handleCommand('!unsafe', testConfig, sm, {
      channelId: 'ch-1',
      projectName: 'Alpha',
      isThread: false,
    }, unsafe);
    expect(result).toMatch(/!unsafe confirm/i);
    expect(result).toContain('Alpha');
    expect(unsafe.isEnabled('ch-1')).toBe(false);     // not enabled yet
    expect(unsafe.hasPendingArm('ch-1')).toBe(true);  // arm recorded
  });

  it('!unsafe in a thread arms the thread channel id (not the parent)', () => {
    const sm = mockSessionManager();
    const unsafe = createUnsafeRegistry();
    handleCommand('!unsafe', testConfig, sm, {
      channelId: 'thread-99',
      projectName: 'Alpha',
      isThread: true,
    }, unsafe);
    expect(unsafe.hasPendingArm('thread-99')).toBe(true);
    expect(unsafe.hasPendingArm('ch-1')).toBe(false);
    expect(unsafe.isEnabled('thread-99')).toBe(false);
  });

  it('!unsafe confirm within window enables and acks', () => {
    const sm = mockSessionManager();
    const unsafe = createUnsafeRegistry();
    handleCommand('!unsafe', testConfig, sm, {
      channelId: 'ch-1', projectName: 'Alpha', isThread: false,
    }, unsafe);
    const result = handleCommand('!unsafe confirm', testConfig, sm, {
      channelId: 'ch-1', projectName: 'Alpha', isThread: false,
    }, unsafe);
    expect(result).toMatch(/unsafe mode enabled/i);
    expect(unsafe.isEnabled('ch-1')).toBe(true);
    expect(unsafe.hasPendingArm('ch-1')).toBe(false);
  });

  it('!unsafe confirm without prior !unsafe returns a no-pending error', () => {
    const sm = mockSessionManager();
    const unsafe = createUnsafeRegistry();
    const result = handleCommand('!unsafe confirm', testConfig, sm, {
      channelId: 'ch-1', projectName: 'Alpha', isThread: false,
    }, unsafe);
    expect(result).toMatch(/no pending|expired/i);
    expect(unsafe.isEnabled('ch-1')).toBe(false);
  });

  it('!unsafe confirm after the window expires does NOT enable', () => {
    const sm = mockSessionManager();
    let t = 1_000_000;
    const unsafe = createUnsafeRegistry({ now: () => t, windowMs: 1_000 });
    handleCommand('!unsafe', testConfig, sm, {
      channelId: 'ch-1', projectName: 'Alpha', isThread: false,
    }, unsafe);
    t += 2_000; // past window
    const result = handleCommand('!unsafe confirm', testConfig, sm, {
      channelId: 'ch-1', projectName: 'Alpha', isThread: false,
    }, unsafe);
    expect(result).toMatch(/no pending|expired/i);
    expect(unsafe.isEnabled('ch-1')).toBe(false);
  });

  it('!unsafe when already enabled informs the operator and does NOT arm', () => {
    const sm = mockSessionManager();
    const unsafe = createUnsafeRegistry();
    unsafe.enable('ch-1');
    const result = handleCommand('!unsafe', testConfig, sm, {
      channelId: 'ch-1', projectName: 'Alpha', isThread: false,
    }, unsafe);
    expect(result).toMatch(/already in unsafe mode/i);
    expect(unsafe.hasPendingArm('ch-1')).toBe(false);
  });

  it('!safe disables unsafe mode and acks', () => {
    const sm = mockSessionManager();
    const unsafe = createUnsafeRegistry();
    unsafe.enable('ch-1');
    const result = handleCommand('!safe', testConfig, sm, {
      channelId: 'ch-1',
      projectName: 'Alpha',
      isThread: false,
    }, unsafe);
    expect(result).toMatch(/safe mode/i);
    expect(unsafe.isEnabled('ch-1')).toBe(false);
  });

  it('!safe is a no-op when channel is already in safe mode and reports it', () => {
    const sm = mockSessionManager();
    const unsafe = createUnsafeRegistry();
    const result = handleCommand('!safe', testConfig, sm, {
      channelId: 'ch-1',
      projectName: 'Alpha',
      isThread: false,
    }, unsafe);
    expect(result).toMatch(/already in safe mode/i);
  });

  it('!safe also clears any pending arm', () => {
    const sm = mockSessionManager();
    const unsafe = createUnsafeRegistry();
    unsafe.armPending('ch-1');
    handleCommand('!safe', testConfig, sm, {
      channelId: 'ch-1', projectName: 'Alpha', isThread: false,
    }, unsafe);
    expect(unsafe.hasPendingArm('ch-1')).toBe(false);
  });

  it('!unsafe without context returns a usage hint', () => {
    const sm = mockSessionManager();
    const unsafe = createUnsafeRegistry();
    const result = handleCommand('!unsafe', testConfig, sm, undefined, unsafe);
    expect(result).toMatch(/project channel|thread/i);
    expect(unsafe.list()).toEqual([]);
  });

  it('!unsafe without a registry treats command as unrecognized (returns null)', () => {
    const sm = mockSessionManager();
    const result = handleCommand('!unsafe', testConfig, sm, {
      channelId: 'ch-1',
      projectName: 'Alpha',
      isThread: false,
    });
    expect(result).toBeNull();
  });

  it('!help mentions !unsafe / !unsafe confirm / !safe when registry support is present', () => {
    const sm = mockSessionManager();
    const unsafe = createUnsafeRegistry();
    const result = handleCommand('!help', testConfig, sm, undefined, unsafe);
    expect(result).toContain('!unsafe');
    expect(result).toContain('!unsafe confirm');
    expect(result).toContain('!safe');
  });

});

describe('agent handoff flow', () => {
  const agents: Record<string, AgentConfig> = {
    pm: { role: 'Product Manager', prompt: 'You manage requirements.' },
    engineer: { role: 'Engineer', prompt: 'You write code.' },
  };

  it('simulates a full handoff chain with turn limit', async () => {
    const turnCounter = createTurnCounter();
    const threadId = 'thread-handoff-test';
    const maxTurns = 3;

    // Simulate: PM uses HANDOFF to dispatch to engineer, engineer uses HANDOFF back
    const responses = [
      'Great analysis!\n\nHANDOFF @engineer: please implement the login feature.',
      'Done implementing.\n\nHANDOFF @pm: please review the PR.',
      'Looks good!\n\nHANDOFF @engineer: please add tests.',
      'Tests added.\n\nHANDOFF @pm: ready for merge.',
    ];

    // Reset on human message
    turnCounter.reset(threadId);

    let responseIndex = 0;
    let currentAgent: string | undefined;
    let responseText = responses[responseIndex++]; // First PM response
    currentAgent = 'pm';

    const handoffLog: string[] = [];

    // Simulate the handoff while loop from discord.ts
    while (true) {
      const handoff = parseHandoffCommand(responseText, agents);
      if (!handoff || handoff.agentName === currentAgent) break;

      turnCounter.increment(threadId);
      if (turnCounter.isOverLimit(threadId, maxTurns)) {
        handoffLog.push(`limit-reached at turn ${turnCounter.getTurns(threadId)}`);
        break;
      }

      handoffLog.push(`${currentAgent ?? 'user'} → ${handoff.agentName}`);

      // Simulate the agent responding
      responseText = responses[responseIndex++] ?? 'No more responses.';
      currentAgent = handoff.agentName;
    }

    expect(handoffLog).toEqual([
      'pm → engineer',
      'engineer → pm',
      'limit-reached at turn 3',
    ]);
    expect(turnCounter.getTurns(threadId)).toBe(3);
    expect(turnCounter.isOverLimit(threadId, maxTurns)).toBe(true);
  });

  it('stops handoff when response does not mention another agent', () => {
    const turnCounter = createTurnCounter();
    const threadId = 'thread-no-handoff';

    turnCounter.reset(threadId);
    const responseText = 'All done, no more handoffs needed.';
    const handoff = parseHandoffCommand(responseText, agents);

    expect(handoff).toBeNull();
    expect(turnCounter.getTurns(threadId)).toBe(0);
  });

  it('bare @agent mention does not trigger handoff', () => {
    const responseText = 'I told @engineer to think about this more...';
    const handoff = parseHandoffCommand(responseText, agents);
    expect(handoff).toBeNull();
  });

  it('conversational @agent reference does not trigger handoff', () => {
    const responseText = "Once approved, I'll ask @engineer to implement it.";
    const handoff = parseHandoffCommand(responseText, agents);
    expect(handoff).toBeNull();
  });

  it('HANDOFF command triggers handoff detection', () => {
    const responseText = 'Analysis complete.\n\nHANDOFF @engineer: implement the feature';
    const handoff = parseHandoffCommand(responseText, agents);
    expect(handoff).not.toBeNull();
    expect(handoff!.agentName).toBe('engineer');
    expect(handoff!.prompt).toBe('implement the feature');
  });

  it('human message resets turn counter', () => {
    const turnCounter = createTurnCounter();
    const threadId = 'thread-reset';

    turnCounter.increment(threadId);
    turnCounter.increment(threadId);
    expect(turnCounter.getTurns(threadId)).toBe(2);

    // Human message resets
    turnCounter.reset(threadId);
    expect(turnCounter.getTurns(threadId)).toBe(0);
    expect(turnCounter.isOverLimit(threadId, 3)).toBe(false);
  });

  it('buildHandoffEmbed is available for handoff announcements', () => {
    const embed = buildHandoffEmbed('engineer', 'Engineer');
    expect(embed.data.description).toBe('Handing off to **@engineer**...');
    expect(embed.data.author?.name).toBe('Engineer');
  });

  it('uses correct session keys for agent dispatch', () => {
    const channelId = 'ch-123';
    const mention = parseAgentMention('@pm review this', agents);
    expect(mention).not.toBeNull();

    const sessionKey = `${channelId}:${mention!.agentName}`;
    expect(sessionKey).toBe('ch-123:pm');

    const systemPrompt = `Your role: ${mention!.agent.role}\n\n${mention!.agent.prompt}`;
    expect(systemPrompt).toBe('Your role: Product Manager\n\nYou manage requirements.');
  });
});
