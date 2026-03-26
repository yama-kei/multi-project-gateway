// tests/agent-dispatch.test.ts
import { describe, it, expect } from 'vitest';
import { parseAgentMention, parseAgentCommand, extractAskTarget, type AgentConfig } from '../src/agent-dispatch.js';

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

describe('parseAgentCommand', () => {
  it('parses canonical !ask <agent> <message>', () => {
    const result = parseAgentCommand('!ask pm review issue #10', agents);
    expect(result).toEqual({
      agentName: 'pm',
      agent: agents.pm,
      prompt: 'review issue #10',
    });
  });

  it('parses shorthand !<agent> <message>', () => {
    const result = parseAgentCommand('!engineer implement login', agents);
    expect(result).toEqual({
      agentName: 'engineer',
      agent: agents.engineer,
      prompt: 'implement login',
    });
  });

  it('is case-insensitive for !ask', () => {
    const result = parseAgentCommand('!ASK PM review this', agents);
    expect(result).toEqual({
      agentName: 'pm',
      agent: agents.pm,
      prompt: 'review this',
    });
  });

  it('is case-insensitive for agent name', () => {
    const result = parseAgentCommand('!ask PM review this', agents);
    expect(result!.agentName).toBe('pm');
  });

  it('returns null for unknown agent in !ask', () => {
    const result = parseAgentCommand('!ask tester check this', agents);
    expect(result).toBeNull();
  });

  it('returns null for unknown agent in shorthand', () => {
    const result = parseAgentCommand('!tester check this', agents);
    expect(result).toBeNull();
  });

  it('built-in commands take precedence over shorthand', () => {
    // Even if there were an agent named "help", the shorthand should not match
    const result = parseAgentCommand('!help', agents);
    expect(result).toBeNull();
  });

  it('built-in commands win: !sessions, !kill, !restart, !agents', () => {
    expect(parseAgentCommand('!sessions', agents)).toBeNull();
    expect(parseAgentCommand('!kill Alpha', agents)).toBeNull();
    expect(parseAgentCommand('!restart Alpha', agents)).toBeNull();
    expect(parseAgentCommand('!agents', agents)).toBeNull();
  });

  it('handles !ask <agent> with no message (empty prompt)', () => {
    const result = parseAgentCommand('!ask pm', agents);
    expect(result).toEqual({
      agentName: 'pm',
      agent: agents.pm,
      prompt: '',
    });
  });

  it('handles shorthand !<agent> with no message', () => {
    const result = parseAgentCommand('!pm', agents);
    expect(result).toEqual({
      agentName: 'pm',
      agent: agents.pm,
      prompt: '',
    });
  });

  it('returns null for non-command text', () => {
    expect(parseAgentCommand('hello world', agents)).toBeNull();
    expect(parseAgentCommand('@pm review this', agents)).toBeNull();
  });

  it('preserves multiline prompt content', () => {
    const result = parseAgentCommand('!ask engineer fix the bug\nhere is the stack trace', agents);
    expect(result!.prompt).toBe('fix the bug\nhere is the stack trace');
  });
});

describe('extractAskTarget', () => {
  it('extracts agent name from !ask command', () => {
    expect(extractAskTarget('!ask pm review this')).toBe('pm');
  });

  it('extracts unknown agent name', () => {
    expect(extractAskTarget('!ask unknownbot do something')).toBe('unknownbot');
  });

  it('extracts agent name with no message', () => {
    expect(extractAskTarget('!ask pm')).toBe('pm');
  });

  it('returns null for non-ask commands', () => {
    expect(extractAskTarget('!help')).toBeNull();
    expect(extractAskTarget('!sessions')).toBeNull();
    expect(extractAskTarget('hello world')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(extractAskTarget('!ASK PM review')).toBe('pm');
  });
});
