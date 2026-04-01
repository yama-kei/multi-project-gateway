// tests/agent-dispatch.test.ts
import { describe, it, expect } from 'vitest';
import { parseAgentMention, parseAgentCommand, extractAskTarget, parseHandoffCommand, parseAllHandoffs, type AgentConfig } from '../src/agent-dispatch.js';

const agents: Record<string, AgentConfig> = {
  pm: { role: 'Product Manager', prompt: 'You manage requirements.' },
  engineer: { role: 'Engineer', prompt: 'You write code.' },
};

const lifeAgents: Record<string, AgentConfig> = {
  'life-router': { role: 'Life Context Router', prompt: 'Route queries.' },
  'life-work': { role: 'Life Context Agent — Work', prompt: 'Work context.' },
  'life-travel': { role: 'Life Context Agent — Travel', prompt: 'Travel context.' },
  'life-social': { role: 'Life Context Agent — Social', prompt: 'Social context.' },
  'life-hobbies': { role: 'Life Context Agent — Hobbies', prompt: 'Hobbies context.' },
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

describe('parseHandoffCommand', () => {
  it('matches HANDOFF @agent: task', () => {
    const result = parseHandoffCommand('HANDOFF @engineer: implement the login feature', agents);
    expect(result).toEqual({
      agentName: 'engineer',
      agent: agents.engineer,
      prompt: 'implement the login feature',
    });
  });

  it('is case-insensitive for keyword', () => {
    const result = parseHandoffCommand('handoff @pm: review the spec', agents);
    expect(result).toEqual({
      agentName: 'pm',
      agent: agents.pm,
      prompt: 'review the spec',
    });
  });

  it('matches when HANDOFF is not on the first line', () => {
    const text = 'I have finished the spec.\n\nHANDOFF @engineer: implement it based on the spec above';
    const result = parseHandoffCommand(text, agents);
    expect(result).toEqual({
      agentName: 'engineer',
      agent: agents.engineer,
      prompt: 'implement it based on the spec above',
    });
  });

  it('returns null for bare @agent mentions (no HANDOFF keyword)', () => {
    expect(parseHandoffCommand('@engineer please implement this', agents)).toBeNull();
    expect(parseHandoffCommand('Hey @pm review this', agents)).toBeNull();
  });

  it('returns null for conversational references to agents', () => {
    expect(parseHandoffCommand("Once approved, I'll hand off to @engineer", agents)).toBeNull();
    expect(parseHandoffCommand('The engineer will handle this', agents)).toBeNull();
  });

  it('returns null for unknown agent', () => {
    expect(parseHandoffCommand('HANDOFF @tester: run the suite', agents)).toBeNull();
  });

  it('returns null when no agents configured', () => {
    expect(parseHandoffCommand('HANDOFF @pm: do it', {})).toBeNull();
  });

  it('handles extra whitespace around colon', () => {
    const result = parseHandoffCommand('HANDOFF @pm :  review this PR', agents);
    expect(result).toEqual({
      agentName: 'pm',
      agent: agents.pm,
      prompt: 'review this PR',
    });
  });

  it('captures rest of line as prompt (not multiline)', () => {
    const text = 'HANDOFF @engineer: implement login\nExtra context on next line';
    const result = parseHandoffCommand(text, agents);
    expect(result!.prompt).toBe('implement login');
  });

  it('returns empty prompt for HANDOFF with no task after colon', () => {
    const result = parseHandoffCommand('HANDOFF @engineer:', agents);
    expect(result).toEqual({
      agentName: 'engineer',
      agent: agents.engineer,
      prompt: '',
    });
  });
});

describe('parseAllHandoffs', () => {
  it('returns empty array when no handoffs found', () => {
    expect(parseAllHandoffs('Just a regular message', lifeAgents)).toEqual([]);
  });

  it('returns single match (same as parseHandoffCommand)', () => {
    const result = parseAllHandoffs('HANDOFF @life-travel: Where did I travel?', lifeAgents);
    expect(result).toHaveLength(1);
    expect(result[0].agentName).toBe('life-travel');
    expect(result[0].prompt).toBe('Where did I travel?');
  });

  it('returns multiple matches from multi-line response', () => {
    const text = [
      'HANDOFF @life-travel: What did I do last summer? (focus on trips)',
      'HANDOFF @life-social: What did I do last summer? (focus on social events)',
      'HANDOFF @life-hobbies: What did I do last summer? (focus on hobbies)',
    ].join('\n');
    const result = parseAllHandoffs(text, lifeAgents);
    expect(result).toHaveLength(3);
    expect(result.map(r => r.agentName)).toEqual(['life-travel', 'life-social', 'life-hobbies']);
  });

  it('deduplicates same agent mentioned twice', () => {
    const text = [
      'HANDOFF @life-travel: First question',
      'HANDOFF @life-travel: Second question',
    ].join('\n');
    const result = parseAllHandoffs(text, lifeAgents);
    expect(result).toHaveLength(1);
    expect(result[0].agentName).toBe('life-travel');
    expect(result[0].prompt).toBe('First question');
  });

  it('skips unknown agents', () => {
    const text = [
      'HANDOFF @life-travel: Question about travel',
      'HANDOFF @unknown-agent: Some question',
    ].join('\n');
    const result = parseAllHandoffs(text, lifeAgents);
    expect(result).toHaveLength(1);
    expect(result[0].agentName).toBe('life-travel');
  });

  it('returns empty array for empty agents', () => {
    expect(parseAllHandoffs('HANDOFF @life-travel: question', {})).toEqual([]);
  });

  it('handles HANDOFF lines with text before and after', () => {
    const text = [
      'I will dispatch to the relevant agents:',
      'HANDOFF @life-work: What projects am I on?',
      'HANDOFF @life-social: Who did I meet recently?',
      'That should cover it.',
    ].join('\n');
    const result = parseAllHandoffs(text, lifeAgents);
    expect(result).toHaveLength(2);
    expect(result[0].agentName).toBe('life-work');
    expect(result[1].agentName).toBe('life-social');
  });
});
