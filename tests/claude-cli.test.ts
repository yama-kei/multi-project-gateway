import { describe, it, expect, vi } from 'vitest';
import { parseClaudeJsonOutput, buildClaudeArgs } from '../src/claude-cli.js';

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
});
