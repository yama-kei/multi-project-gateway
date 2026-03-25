// tests/agent-dispatch.test.ts
import { describe, it, expect } from 'vitest';
import { parseAgentMention, type AgentConfig } from '../src/agent-dispatch.js';

const agents: Record<string, AgentConfig> = {
  pm: { role: 'Product Manager', prompt: 'You manage requirements.' },
  engineer: { role: 'Engineer', prompt: 'You write code.' },
};

describe('parseAgentMention', () => {
  it('extracts @agent at the start of the message', () => {
    const result = parseAgentMention('@pm review issue #10', agents);
    expect(result).toEqual({
      agentName: 'pm',
      agent: agents.pm,
      prompt: 'review issue #10',
    });
  });

  it('extracts @agent in the middle of the message', () => {
    const result = parseAgentMention('Hey @engineer please implement this', agents);
    expect(result).toEqual({
      agentName: 'engineer',
      agent: agents.engineer,
      prompt: 'Hey @engineer please implement this',
    });
  });

  it('returns null when no agent is mentioned', () => {
    const result = parseAgentMention('Just a regular message', agents);
    expect(result).toBeNull();
  });

  it('returns null for unknown agent names', () => {
    const result = parseAgentMention('@tester check this', agents);
    expect(result).toBeNull();
  });

  it('is case-insensitive for agent names', () => {
    const result = parseAgentMention('@PM review this', agents);
    expect(result).toEqual({
      agentName: 'pm',
      agent: agents.pm,
      prompt: 'review this',
    });
  });

  it('matches first known agent when multiple are mentioned', () => {
    const result = parseAgentMention('@pm tell @engineer to fix it', agents);
    expect(result!.agentName).toBe('pm');
  });

  it('strips @agent from start of prompt', () => {
    const result = parseAgentMention('@engineer implement login', agents);
    expect(result!.prompt).toBe('implement login');
  });

  it('preserves full message as prompt when mention is not at start', () => {
    const result = parseAgentMention('please @pm do something', agents);
    expect(result!.prompt).toBe('please @pm do something');
  });
});
