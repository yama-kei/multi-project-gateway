import { describe, it, expect, vi } from 'vitest';
import { parseClaudeJsonOutput, buildClaudeArgs, friendlyError } from '../src/claude-cli.js';

describe('parseClaudeJsonOutput', () => {
  it('extracts result text and session_id from JSON output', () => {
    const json = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Hello! I fixed the bug.',
      session_id: 'abc-123-def',
    });
    const parsed = parseClaudeJsonOutput(json);
    expect(parsed.text).toBe('Hello! I fixed the bug.');
    expect(parsed.sessionId).toBe('abc-123-def');
    expect(parsed.isError).toBe(false);
  });

  it('handles error results', () => {
    const json = JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'Something went wrong',
      session_id: 'abc-123-def',
    });
    const parsed = parseClaudeJsonOutput(json);
    expect(parsed.isError).toBe(true);
    expect(parsed.text).toBe('Something went wrong');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseClaudeJsonOutput('not json')).toThrow();
  });
});

describe('buildClaudeArgs', () => {
  const baseArgs = ['--dangerously-skip-permissions', '--output-format', 'json'];

  it('builds args for a new session', () => {
    const args = buildClaudeArgs(baseArgs, 'Fix the bug', undefined);
    expect(args).toEqual([
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      'Fix the bug',
    ]);
  });

  it('builds args with --resume for existing session', () => {
    const args = buildClaudeArgs(baseArgs, 'Now add tests', 'session-uuid-123');
    expect(args).toEqual([
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--resume', 'session-uuid-123',
      'Now add tests',
    ]);
  });

  it('includes --append-system-prompt when provided', () => {
    const args = buildClaudeArgs([], 'hello', undefined, 'You are a PM.');
    expect(args).toContain('--append-system-prompt');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('You are a PM.');
  });

  it('omits --append-system-prompt when not provided', () => {
    const args = buildClaudeArgs([], 'hello', undefined);
    expect(args).not.toContain('--append-system-prompt');
  });
});

describe('friendlyError', () => {
  it('detects rate limit errors', () => {
    expect(friendlyError('API Error: Rate limit reached')).toContain('usage limit reached');
  });

  it('detects rate_limit_error JSON type', () => {
    expect(friendlyError('429 {"type":"error","error":{"type":"rate_limit_error"}}')).toContain('usage limit reached');
  });

  it('detects overloaded errors', () => {
    expect(friendlyError('API Error (529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}})')).toContain('overloaded');
  });

  it('detects authentication errors', () => {
    expect(friendlyError('Invalid API key')).toContain('authentication failed');
  });

  it('detects authentication_error JSON type', () => {
    expect(friendlyError('{"type":"error","error":{"type":"authentication_error"}}')).toContain('authentication failed');
  });

  it('detects empty response errors', () => {
    expect(friendlyError('No messages returned')).toContain('empty response');
  });

  it('falls back to truncated raw error for unknown patterns', () => {
    const msg = friendlyError('something unexpected happened');
    expect(msg).toContain('Claude error:');
    expect(msg).toContain('something unexpected happened');
  });
});
